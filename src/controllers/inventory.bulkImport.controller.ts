import { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { broadcastToModule } from '../services/notificationService.js';
import { logAudit, extractRequestContext, AuditActorType } from '../services/auditService.js';
import { addQuantityStock } from '../services/quantityStockService.js';
import { InsufficientFundsError } from '../services/balanceService.js';
import { createPurchaseInvoice } from '../services/invoiceService.js';

// ── Category name normalisation ────────────────────────────────────────────────

/**
 * Canonical form used for *comparison only* — trimmed, inner whitespace collapsed,
 * lowercased. "Soap", "soap " and "SOAP" all normalise to "soap", so they can never
 * become three separate categories. The display name keeps the user's own casing.
 */
export const normalizeCategoryName = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

/** Tidies a display name without changing the author's casing. */
const cleanDisplayName = (value: string): string => value.trim().replace(/\s+/g, ' ');

// ── Row error helper ───────────────────────────────────────────────────────────

interface RowError {
  row: number;
  field: string;
  message: string;
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const ImportRowSchema = z.object({
  row: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, 'Product name is required').max(120),
  categoryId: z.preprocess(emptyToNull, z.string().min(1).nullable().optional()),
  newCategoryName: z.preprocess(emptyToNull, z.string().trim().min(1).max(80).nullable().optional()),
  costPrice: z.coerce.number().nonnegative().default(0),
  sellingPrice: z.coerce.number().nonnegative(),
  quantity: z.coerce.number().int().nonnegative().default(0),
  unit: z.preprocess(emptyToNull, z.string().trim().max(24).nullable().optional()),
  barcode: z.preprocess(emptyToNull, z.string().trim().max(64).nullable().optional()),
  reorderThreshold: z.coerce.number().int().nonnegative().default(0),
  imageUrl: z.preprocess(emptyToNull, z.string().url().nullable().optional()),
});

const BulkImportSchema = z.object({
  products: z.array(ImportRowSchema).min(1, 'At least one product is required').max(1000),
  /**
   * SERIALIZED imports create products whose units are added individually and go
   * through the existing purchase-invoice flow. QUANTITY imports put the stock on
   * the shelf immediately. Defaults to QUANTITY: a spreadsheet of shop stock is
   * the case this screen exists for.
   */
  stockTrackingMode: z.enum(['SERIALIZED', 'QUANTITY']).optional(),
  /**
   * False when the file lists stock the business already owns. The counts are
   * recorded, but no expense is booked — that money left the business before today.
   */
  isNewPurchase: z.boolean().optional(),
});

type ImportRow = z.infer<typeof ImportRowSchema>;

const ProductCategorySchema = z.object({
  name: z.string().trim().min(1, 'Category name is required').max(80),
});

// ── SKU / abbreviation generation ──────────────────────────────────────────────

/**
 * Derives a short, human-recognisable abbreviation from a product name and makes it
 * unique for the tenant. `taken` holds both the SKUs already in the database and the
 * ones handed out earlier in this same batch.
 */
const buildAbbreviation = (name: string, taken: Set<string>): string => {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const base = (letters.slice(0, 4) || 'PRD').padEnd(3, 'X');

  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let i = 1; i < 10000; i += 1) {
    const suffix = String(i);
    const candidate = `${base.slice(0, Math.max(2, 8 - suffix.length))}${suffix}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const fallback = `P${Date.now().toString(36).slice(-6).toUpperCase()}`;
  taken.add(fallback);
  return fallback;
};

// ── Product categories ─────────────────────────────────────────────────────────

export const listProductCategories = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const categories = await (prisma as any).productCategory.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });

    return res.json({
      success: true,
      message: 'Product categories retrieved successfully',
      data: categories.map((c: any) => ({
        id: c.id,
        name: c.name,
        normalizedName: c.normalizedName,
        productCount: c._count?.products ?? 0,
        createdAt: c.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error listing product categories:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve product categories',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Just the names of products already saved, so the import screen can flag a
 * clash while the user is still reviewing rather than at submit time. Kept
 * separate from the full list because it is polled for one field.
 */
export const listProductNames = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const products = await (prisma as any).inventoryCategory.findMany({
      where: { tenantId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    return res.json({
      success: true,
      message: 'Product names retrieved successfully',
      data: products,
    });
  } catch (error) {
    console.error('Error listing product names:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve product names',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const createProductCategory = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const parsed = ProductCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const name = cleanDisplayName(parsed.data.name);
    const normalizedName = normalizeCategoryName(name);

    const existing = await (prisma as any).productCategory.findFirst({
      where: { tenantId, normalizedName },
    });
    if (existing) {
      // Already there under a different casing — hand back the canonical one rather
      // than creating a near-duplicate.
      return res.status(200).json({
        success: true,
        message: 'Category already exists',
        data: { id: existing.id, name: existing.name, productCount: 0, existed: true },
      });
    }

    const category = await (prisma as any).productCategory.create({
      data: { tenantId, name, normalizedName },
    });

    return res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: { id: category.id, name: category.name, productCount: 0, existed: false },
    });
  } catch (error) {
    console.error('Error creating product category:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create category',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// ── Bulk import ────────────────────────────────────────────────────────────────

/**
 * Creates every product in one transaction — including any brand-new categories the
 * rows reference. Either the whole batch lands or nothing does; a half-imported
 * inventory is worse than no import at all.
 */
export const bulkImportProducts = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const parsed = BulkImportSchema.safeParse(req.body);

    if (!parsed.success) {
      const rowErrors: RowError[] = parsed.error.issues.map((issue) => {
        const [, index, field] = issue.path as (string | number)[];
        const rowIndex = typeof index === 'number' ? index : -1;
        const raw = Array.isArray(req.body?.products) ? req.body.products[rowIndex] : undefined;
        return {
          row: Number(raw?.row ?? rowIndex + 1),
          field: String(field ?? 'row'),
          message: issue.message,
        };
      });
      return res.status(400).json({
        success: false,
        message: 'Some rows could not be saved',
        data: { created: 0, errors: rowErrors },
      });
    }

    const rows: ImportRow[] = parsed.data.products;
    const trackingMode = parsed.data.stockTrackingMode ?? 'QUANTITY';
    const isNewPurchase = parsed.data.isNewPurchase ?? true;
    const serializedIds: string[] = [];
    const errors: RowError[] = [];

    // ── Barcodes must stay unique: inside the batch… ──────────────────────────
    const seenBarcodes = new Map<string, number>();
    for (const row of rows) {
      if (!row.barcode) continue;
      const previous = seenBarcodes.get(row.barcode);
      if (previous !== undefined) {
        errors.push({
          row: row.row,
          field: 'barcode',
          message: `Barcode "${row.barcode}" is already used on row ${previous}`,
        });
      } else {
        seenBarcodes.set(row.barcode, row.row);
      }
    }

    // ── Product names must be unique for the tenant ───────────────────────────
    // Two products with the same name are impossible to tell apart at the till,
    // so a clash blocks the row. Matched on the trimmed, lowercased form: "Savon"
    // and "savon " are the same product to the person selling it.
    const normalizeName = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

    const seenNames = new Map<string, number>();
    for (const row of rows) {
      const key = normalizeName(row.name);
      if (!key) continue;
      const previous = seenNames.get(key);
      if (previous !== undefined) {
        errors.push({
          row: row.row,
          field: 'name',
          message: `"${row.name.trim()}" is already on row ${previous} of this file`,
        });
      } else {
        seenNames.set(key, row.row);
      }
    }

    const existingProducts = await (prisma as any).inventoryCategory.findMany({
      where: { tenantId },
      select: { name: true },
    });
    const existingNames = new Set<string>(
      existingProducts.map((p: any) => normalizeName(String(p.name ?? ''))),
    );
    for (const [key, row] of seenNames) {
      if (existingNames.has(key)) {
        const original = rows.find((r) => r.row === row);
        errors.push({
          row,
          field: 'name',
          message: `A product called "${original?.name.trim() ?? key}" already exists`,
        });
      }
    }

    // ── …and against products already saved ───────────────────────────────────
    const barcodeList = [...seenBarcodes.keys()];
    if (barcodeList.length > 0) {
      const clashes = await (prisma as any).inventoryCategory.findMany({
        where: { tenantId, barcode: { in: barcodeList } },
        select: { barcode: true, name: true },
      });
      for (const clash of clashes) {
        const row = seenBarcodes.get(clash.barcode);
        if (row !== undefined) {
          errors.push({
            row,
            field: 'barcode',
            message: `Barcode "${clash.barcode}" already belongs to "${clash.name}"`,
          });
        }
      }
    }

    // ── Resolve categories ────────────────────────────────────────────────────
    const referencedIds = [...new Set(rows.map((r) => r.categoryId).filter(Boolean) as string[])];
    const existingCategories = await (prisma as any).productCategory.findMany({
      where: { tenantId },
    });
    const byId = new Map<string, any>(existingCategories.map((c: any) => [c.id, c]));
    const byNormalized = new Map<string, any>(
      existingCategories.map((c: any) => [c.normalizedName, c]),
    );

    for (const id of referencedIds) {
      if (!byId.has(id)) {
        const row = rows.find((r) => r.categoryId === id);
        errors.push({
          row: row?.row ?? 0,
          field: 'category',
          message: 'That category no longer exists. Pick another one.',
        });
      }
    }

    // New category names, deduplicated on their normalised form. A name that already
    // exists in the database is reused instead of created again.
    const categoriesToCreate = new Map<string, string>(); // normalized -> display name
    for (const row of rows) {
      if (row.categoryId || !row.newCategoryName) continue;
      const normalized = normalizeCategoryName(row.newCategoryName);
      if (byNormalized.has(normalized) || categoriesToCreate.has(normalized)) continue;
      categoriesToCreate.set(normalized, cleanDisplayName(row.newCategoryName));
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Some rows could not be saved',
        data: { created: 0, errors },
      });
    }

    // ── Unique SKUs for the whole batch ───────────────────────────────────────
    const existingSkus = await (prisma as any).inventoryCategory.findMany({
      where: { tenantId },
      select: { sku: true, abbreviation: true },
    });
    const takenSkus = new Set<string>();
    for (const c of existingSkus) {
      if (c.sku) takenSkus.add(String(c.sku).toUpperCase());
      if (c.abbreviation) takenSkus.add(String(c.abbreviation).toUpperCase());
    }
    const abbreviations = rows.map((row) => buildAbbreviation(row.name, takenSkus));

    // ── One transaction: categories, products, stock history ──────────────────
    const result = await prisma.$transaction(
      async (tx) => {
        const resolved = new Map<string, string>(); // normalized -> category id
        for (const [normalized, category] of byNormalized) {
          resolved.set(normalized as string, (category as any).id);
        }

        for (const [normalized, displayName] of categoriesToCreate) {
          const created = await (tx as any).productCategory.create({
            data: { tenantId, name: displayName, normalizedName: normalized },
          });
          resolved.set(normalized, created.id);
        }

        const createdProducts: Array<{ row: number; id: string; name: string }> = [];

        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          const productCategoryId = row.categoryId
            ? row.categoryId
            : row.newCategoryName
              ? (resolved.get(normalizeCategoryName(row.newCategoryName)) ?? null)
              : null;

          const abbreviation = abbreviations[i];
          const images = row.imageUrl ? [row.imageUrl] : [];

          const quantityTracked = trackingMode === 'QUANTITY';

          const product = await (tx as any).inventoryCategory.create({
            data: {
              tenantId,
              name: row.name,
              sku: abbreviation,
              abbreviation,
              barcode: row.barcode ?? null,
              productCategoryId,
              type: 'STOCK',
              stockTrackingMode: trackingMode as any,
              unit: row.unit ?? null,
              costPrice: row.costPrice as any,
              sellingPrice: row.sellingPrice as any,
              // Quantity products hold live stock in quantityOnHand (applied below).
              // Serialised ones keep plannedQty as the quantity to be authorised.
              plannedQty: quantityTracked ? 0 : row.quantity,
              reorderThreshold: row.reorderThreshold,
              identifierType: row.barcode ? 'BARCODE' : 'NONE',
              identifierLabel: row.barcode ? 'Barcode' : null,
              imageUrl: row.imageUrl ?? null,
              images,
              invoiceApproved: false,
            },
          });

          if (quantityTracked) {
            if (row.quantity > 0) {
              await addQuantityStock({
                tx,
                tenantId,
                categoryId: product.id,
                quantityAdded: row.quantity,
                costPrice: row.costPrice,
                // "Already have" imports record the count without booking a cost —
                // that money was spent before today.
                isNewPurchase,
                categoryName: product.name,
                note: 'Imported from file',
              });
            }
          } else if (row.quantity > 0) {
            // Serialised rows: the quantity is a purchase to be authorised, and the
            // units are added one by one afterwards through the normal flow.
            await (tx as any).categoryStockLog.create({
              data: {
                tenantId,
                categoryId: product.id,
                eventType: 'BULK_IMPORT',
                stockBefore: 0,
                stockAfter: 0,
                delta: 0,
                title: `Imported from file — ${row.quantity} ${row.unit || 'units'} to be received`,
                performedBy: req.user?.id ?? null,
              },
            });
            serializedIds.push(product.id);
          }

          createdProducts.push({ row: row.row, id: product.id, name: product.name });
        }

        return { createdProducts, categoriesCreated: categoriesToCreate.size };
      },
      { timeout: 120_000, maxWait: 20_000 },
    );

    const created = result.createdProducts.length;

    // Serialised imports still go through finance: one purchase invoice per product,
    // raised after the batch commits so a finance hiccup cannot roll back the import.
    if (serializedIds.length > 0 && req.user?.id) {
      for (const categoryId of serializedIds) {
        try {
          await createPurchaseInvoice({ tenantId, categoryId, submittedBy: req.user.id });
        } catch (err) {
          console.error('[invoice] Error raising purchase invoice for imported product:', err);
        }
      }
    }

    broadcastToModule(tenantId, 'inventory', {
      type: 'inventory.bulk.imported',
      title: 'Products imported',
      message: `${created} product${created === 1 ? '' : 's'} added from a file upload.`,
      link: '/inventory',
    }).catch((err: any) => console.error('[notify] bulk import:', err));

    void logAudit({
      tenantId,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PRODUCTS_BULK_IMPORTED',
      module: 'inventory',
      entityType: 'InventoryCategory',
      entityLabel: `${created} products`,
      details: { created, categoriesCreated: result.categoriesCreated },
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: `${created} product${created === 1 ? '' : 's'} imported successfully`,
      data: {
        created,
        categoriesCreated: result.categoriesCreated,
        products: result.createdProducts,
        errors: [],
      },
    });
  } catch (error) {
    console.error('Error importing products:', error);
    const msg = error instanceof Error ? error.message : '';

    if (error instanceof InsufficientFundsError) {
      return res.status(400).json({
        success: false,
        message:
          'Could not record what this stock cost. Nothing was saved — choose "I already have it" if this stock was not just bought.',
      });
    }

    if (msg.includes('inventory_categories_tenant_id_barcode_key')) {
      return res.status(409).json({
        success: false,
        message: 'One of the barcodes is already used by another product. Nothing was saved.',
      });
    }
    if (msg.includes('product_categories_tenant_id_normalized_name_key')) {
      return res.status(409).json({
        success: false,
        message: 'One of the categories was created a moment ago by someone else. Please try again.',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Import failed. Nothing was saved, so you can safely try again.',
      error: msg || 'Unknown error',
    });
  }
};
