import { prismaUnscoped as db } from '../db.js';
import { ApiError } from '../lib/errors.js';
import { ProductIndex, matchesTyped, type MatchReason } from '../lib/productIdentity.js';

/**
 * Importing products from another branch of the same tenant: the products
 * chosen, with their category, details, prices, tracking mode (serialized or
 * by quantity), variants and images. Never their stock: no units, quantities,
 * movements or history — the receiving branch adds its own.
 *
 * Nothing is duplicated. A product the receiving branch already has — same
 * name, abbreviation, barcode or code (lib/productIdentity.ts) — is skipped
 * and reported. A category is matched by name and reused. Images are shared:
 * the copy points at the same stored file (product images are never deleted
 * from storage, so this is safe).
 *
 * Cross-branch by nature, so it uses the unscoped client and names both
 * branches itself.
 */

export interface CopyRequest {
  tenantId: string;
  fromBranchId: string;
  toBranchId: string;
  /** The products to import. Null = decided by productCategoryIds. */
  productIds?: string[] | null;
  /** Whole categories to import. Null (with no productIds) = everything. */
  productCategoryIds?: string[] | null;
  dryRun: boolean;
}

export interface CopyResult {
  categories: { created: string[]; reused: string[] };
  products: {
    created: Array<{ sourceId: string; id: string | null; name: string }>;
    skipped: Array<{ sourceId: string; name: string; sku: string; reason: MatchReason }>;
  };
  variants: { created: number };
}

async function assertBranches(tenantId: string, ids: string[]) {
  const found = await db.branch.count({ where: { tenantId, id: { in: ids } } });
  if (found !== new Set(ids).size) throw new ApiError(404, 'Branch not found.', 'BRANCH_NOT_FOUND');
}

async function productIndexOf(tx: any, tenantId: string, branchId: string) {
  const products = await tx.inventoryCategory.findMany({
    where: { tenantId, branchId },
    select: { name: true, abbreviation: true, barcode: true, sku: true },
  });
  return new ProductIndex(products);
}

export async function copyCatalog(req: CopyRequest): Promise<CopyResult> {
  const { tenantId, fromBranchId, toBranchId, productIds, productCategoryIds, dryRun } = req;
  if (fromBranchId === toBranchId) {
    throw new ApiError(400, 'Choose another branch to import from.', 'SAME_BRANCH');
  }
  await assertBranches(tenantId, [fromBranchId, toBranchId]);

  const sourceProducts = await db.inventoryCategory.findMany({
    where: {
      tenantId,
      branchId: fromBranchId,
      ...(productIds ? { id: { in: productIds } } : productCategoryIds ? { productCategoryId: { in: productCategoryIds } } : {}),
    },
    include: { variants: true, productCategory: true },
    orderBy: { name: 'asc' },
  });

  const run = async (tx: any): Promise<CopyResult> => {
    const result: CopyResult = {
      categories: { created: [], reused: [] },
      products: { created: [], skipped: [] },
      variants: { created: 0 },
    };
    const existing = await productIndexOf(tx, tenantId, toBranchId);
    const toImport = sourceProducts.filter((p) => {
      const reason = existing.match(p);
      if (reason) {
        result.products.skipped.push({ sourceId: p.id, name: p.name, sku: p.sku, reason });
        return false;
      }
      existing.add(p); // two chosen products that are the same one: import once
      return true;
    });

    // Categories of what is imported: reuse by name, create the missing ones.
    const targetCategories = await tx.productCategory.findMany({
      where: { tenantId, branchId: toBranchId },
      select: { id: true, normalizedName: true },
    });
    const byName = new Map<string, string>(targetCategories.map((c: any) => [c.normalizedName, c.id]));
    const categoryMap = new Map<string, string>();
    for (const cat of new Map(toImport.filter((p) => p.productCategory).map((p) => [p.productCategory!.id, p.productCategory!])).values()) {
      const found = byName.get(cat.normalizedName);
      if (found) {
        categoryMap.set(cat.id, found);
        result.categories.reused.push(cat.name);
        continue;
      }
      result.categories.created.push(cat.name);
      if (dryRun) continue;
      const created = await tx.productCategory.create({
        data: { tenantId, branchId: toBranchId, name: cat.name, normalizedName: cat.normalizedName },
        select: { id: true },
      });
      categoryMap.set(cat.id, created.id);
      byName.set(cat.normalizedName, created.id);
    }

    // Variant codes are unique per branch too.
    const targetVariants = await tx.productVariant.findMany({
      where: { tenantId, branchId: toBranchId },
      select: { sku: true, barcode: true },
    });
    const usedVariantSkus = new Set<string>(targetVariants.map((v: any) => v.sku).filter(Boolean));
    const usedVariantBarcodes = new Set<string>(targetVariants.map((v: any) => v.barcode).filter(Boolean));

    for (const p of toImport) {
      result.variants.created += p.variants.length;
      if (dryRun) {
        result.products.created.push({ sourceId: p.id, id: null, name: p.name });
        continue;
      }
      const product = await tx.inventoryCategory.create({
        data: {
          tenantId,
          branchId: toBranchId,
          sku: p.sku,
          abbreviation: p.abbreviation,
          name: p.name,
          barcode: p.barcode,
          productCategoryId: p.productCategoryId ? categoryMap.get(p.productCategoryId) ?? null : null,
          stockTrackingMode: p.stockTrackingMode,
          hasUniquePerUnitBarcode: p.hasUniquePerUnitBarcode,
          retailEnabled: p.retailEnabled,
          wholesaleEnabled: p.wholesaleEnabled,
          description: p.description,
          supplier: p.supplier,
          unit: p.unit,
          costPrice: p.costPrice,
          sellingPrice: p.sellingPrice,
          reorderThreshold: p.reorderThreshold,
          type: p.type,
          identifierType: p.identifierType,
          identifierLabel: p.identifierLabel,
          imageUrl: p.imageUrl,
          images: p.images ?? [],
          notes: p.notes,
        },
        select: { id: true },
      });
      result.products.created.push({ sourceId: p.id, id: product.id, name: p.name });

      if (p.variants.length) {
        await tx.productVariant.createMany({
          data: p.variants.map((v: any) => {
            const sku = v.sku && !usedVariantSkus.has(v.sku) ? v.sku : null;
            const vBarcode = v.barcode && !usedVariantBarcodes.has(v.barcode) ? v.barcode : null;
            if (sku) usedVariantSkus.add(sku);
            if (vBarcode) usedVariantBarcodes.add(vBarcode);
            return {
              tenantId,
              branchId: toBranchId,
              categoryId: product.id,
              attributes: v.attributes ?? {},
              axisOrder: v.axisOrder ?? [],
              label: v.label,
              sku,
              barcode: vBarcode,
              priceOverride: v.priceOverride,
              isActive: v.isActive,
              sortOrder: v.sortOrder,
              imageUrl: v.imageUrl,
            };
          }),
        });
      }
    }
    return result;
  };

  if (dryRun) return run(db);
  return db.$transaction((tx) => run(tx), { timeout: 120_000, maxWait: 20_000 });
}

/** A branch's products as the import review lists them, marked when the receiving branch already has them. */
export async function listSourceProducts(tenantId: string, fromBranchId: string, toBranchId: string) {
  await assertBranches(tenantId, [fromBranchId, toBranchId]);
  const [products, existing] = await Promise.all([
    db.inventoryCategory.findMany({
      where: { tenantId, branchId: fromBranchId },
      select: {
        id: true, name: true, sku: true, abbreviation: true, barcode: true, imageUrl: true,
        stockTrackingMode: true, sellingPrice: true,
        productCategory: { select: { id: true, name: true } },
        _count: { select: { variants: true } },
      },
      orderBy: { name: 'asc' },
    }),
    productIndexOf(db, tenantId, toBranchId),
  ]);
  return products.map(({ _count, sellingPrice, ...p }) => ({
    ...p,
    sellingPrice: sellingPrice === null ? null : Number(sellingPrice),
    variantCount: _count.variants,
    alreadyHere: existing.match(p),
  }));
}

/**
 * While a branch creates a product: does it already exist — here, or in
 * another branch where it could be imported instead?
 */
export async function findProductElsewhere(
  tenantId: string,
  branchId: string,
  typed: { name?: string; abbreviation?: string; barcode?: string },
) {
  const name = typed.name?.trim().replace(/\s+/g, ' ');
  const abbreviation = typed.abbreviation?.trim();
  const barcode = typed.barcode?.trim();
  const or = [
    ...(name && name.length >= 3 ? [{ name: { equals: name, mode: 'insensitive' as const } }] : []),
    ...(abbreviation && abbreviation.length >= 2 ? [{ abbreviation: { equals: abbreviation, mode: 'insensitive' as const } }] : []),
    ...(barcode && barcode.length >= 4 ? [{ barcode }] : []),
  ];
  if (!or.length) return { here: [], elsewhere: [] };
  const rows = await db.inventoryCategory.findMany({
    where: { tenantId, OR: or },
    select: {
      id: true, name: true, abbreviation: true, barcode: true, imageUrl: true, branchId: true,
      branch: { select: { id: true, name: true, code: true } },
    },
    take: 20,
  });
  const withReason = rows.map((r) => ({ ...r, matchedBy: matchesTyped(r, typed) }));
  const strip = ({ branchId: _b, ...r }: (typeof withReason)[number]) => r;
  return {
    here: withReason.filter((r) => r.branchId === branchId).map(strip),
    elsewhere: withReason
      .filter((r) => r.branchId !== branchId)
      .filter((r, i, all) => all.findIndex((x) => x.branchId === r.branchId) === i)
      .map(strip),
  };
}
