import { prisma } from '../db.js';

/** Where a resolved price came from — useful when a price needs explaining. */
export type PriceSource = 'CUSTOMER_LIST' | 'DEFAULT_LIST' | 'PRODUCT' | 'VARIANT';

export interface ResolvedPrice {
  unitPrice: number;
  source: PriceSource;
  priceListId?: string;
  priceListName?: string;
  /**
   * Set whenever a variantId was given, regardless of which tier the price
   * itself came from — callers snapshot SaleItem.variantLabel from this
   * without a second DB round trip.
   */
  variantLabel?: string;
  /**
   * Nothing priced the line: no price-list rule, no variant price and no
   * selling price on the product. unitPrice is then 0. The cost price is
   * never a fallback; selling at cost would hide the missing price.
   */
  missingPrice?: boolean;
}

/** Either the global Prisma client or a `tx` handed in from `prisma.$transaction`. */
type PrismaLike = typeof prisma;

/**
 * Picks the tier that applies at this quantity. Rules arrive sorted by
 * minQuantity descending, so the first rule the order reaches is the
 * highest tier it qualifies for.
 */
function applicableRule<T extends { minQuantity: number }>(rules: T[], quantity: number) {
  return rules.find((rule) => quantity >= rule.minQuantity);
}

/**
 * The price a rule sets: its fixed unit price, or its percentage off `base`.
 * Null when it is a percentage and there is nothing to take it off, so the
 * cascade moves on rather than selling at 0.
 */
export function rulePrice(
  rule: { unitPrice: unknown; discountPercent?: unknown },
  base: number | null,
): number | null {
  if (rule.unitPrice != null) return Number(rule.unitPrice);
  if (rule.discountPercent == null || base == null) return null;
  return Math.round(base * (100 - Number(rule.discountPercent))) / 100;
}

/** Splits a category's rules into the ones scoped to this specific variant and the product-level ones. */
function splitRules<T extends { variantId: string | null }>(rules: T[], variantId: string | null) {
  const variantRules = variantId ? rules.filter((r) => r.variantId === variantId) : [];
  const productRules = rules.filter((r) => r.variantId === null);
  return { variantRules, productRules };
}

/** The product's own price tier: its selling price, or "missing". */
function productTier(sellingPrice: unknown, variantLabel?: string): ResolvedPrice {
  return sellingPrice != null
    ? { unitPrice: Number(sellingPrice), source: 'PRODUCT', variantLabel }
    : { unitPrice: 0, source: 'PRODUCT', variantLabel, missingPrice: true };
}

/**
 * Works out what one unit of a product (optionally, one specific variant of
 * it) costs this customer at this quantity. A one-line call to
 * resolvePricesForSale, so the cascade lives in one place.
 */
export async function resolvePriceDetailed(
  tenantId: string,
  categoryId: string,
  customerId: string | null,
  quantity: number,
  variantId: string | null = null,
  client: PrismaLike = prisma,
): Promise<ResolvedPrice> {
  const [resolved] = await resolvePricesForSale(tenantId, customerId, [{ categoryId, quantity, variantId }], client);
  return resolved;
}

/** Price only, for callers that do not care where it came from. */
export async function resolvePrice(
  tenantId: string,
  categoryId: string,
  customerId: string | null,
  quantity: number,
  variantId: string | null = null,
  client: PrismaLike = prisma,
): Promise<number> {
  return (await resolvePriceDetailed(tenantId, categoryId, customerId, quantity, variantId, client)).unitPrice;
}

export interface PriceLineRequest {
  categoryId: string;
  quantity: number;
  variantId?: string | null;
}

/**
 * Same 6-tier cascade as resolvePriceDetailed, batched for a whole sale
 * instead of called once per line. A cart with N lines used to run up to 3
 * queries per line inside the sale's transaction (customer list, default
 * list, variant) — on a 20-line cart against a pooled Neon connection,
 * ~60 round trips inside one transaction with a 30s timeout. This issues a
 * fixed number of queries regardless of line count: the customer's price
 * list (all its rules for the categories on this sale), the tenant's
 * default list (same), every distinct variant in one batch, and every
 * distinct category in one batch — then resolves each line in memory.
 *
 * Measured 6 queries, not the 4 statements below might suggest: Prisma
 * splits a nested `include` into one query per relation level, so each
 * price-list read costs 2-3. The number that matters is that it does not
 * grow with the cart — measured 6 queries at 2, 10 and 40 lines, against
 * 12 / 60 / 240 for the per-line version this replaced.
 *
 * Pass `tx` here when calling from inside `prisma.$transaction` — resolving
 * prices on the global client while the surrounding writes go through `tx`
 * meant the price read wasn't part of the same transaction/snapshot as the
 * sale it was priced for.
 */
export async function resolvePricesForSale(
  tenantId: string,
  customerId: string | null,
  lines: PriceLineRequest[],
  client: PrismaLike = prisma,
): Promise<ResolvedPrice[]> {
  const categoryIds = [...new Set(lines.map((l) => l.categoryId))];
  const variantIds = [...new Set(lines.filter((l) => l.variantId).map((l) => l.variantId as string))];

  const [customerPriceList, defaultList, variants, categories] = await Promise.all([
    customerId
      ? client.customerPriceList.findFirst({
          where: { customerId, priceList: { tenantId } },
          // Newest list, the same one "Load price list" fills the cart from. Only
          // customers assigned twice before one-list-per-customer can have two.
          orderBy: { createdAt: 'desc' },
          include: {
            priceList: {
              include: {
                rules: { where: { categoryId: { in: categoryIds } }, orderBy: { minQuantity: 'desc' } },
              },
            },
          },
        })
      : null,
    client.priceList.findFirst({
      where: { tenantId, isDefault: true },
      include: {
        rules: { where: { categoryId: { in: categoryIds } }, orderBy: { minQuantity: 'desc' } },
      },
    }),
    variantIds.length
      ? client.productVariant.findMany({
          where: { id: { in: variantIds } },
          select: { id: true, label: true, priceOverride: true },
        })
      : Promise.resolve([]),
    client.inventoryCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, sellingPrice: true },
    }),
  ]);

  // Explicit value types: the `variantIds.length ? ... : Promise.resolve([])`
  // branch above makes TS infer the empty arm as never[], which would leave
  // Map#get returning {} and lose label/priceOverride.
  const variantById = new Map<string, { id: string; label: string; priceOverride: unknown }>(
    (variants as any[]).map((v) => [v.id, v]),
  );
  const categoryById = new Map<string, { id: string; sellingPrice: unknown }>(
    (categories as any[]).map((c) => [c.id, c]),
  );

  return lines.map((line): ResolvedPrice => {
    const variant = line.variantId ? variantById.get(line.variantId) : undefined;
    const variantLabel = variant?.label;
    const category = categoryById.get(line.categoryId);

    /** What a percentage rule is taken off: the variant's own price, else the product's. */
    function basePrice(): number | null {
      const p = variant?.priceOverride ?? category?.sellingPrice;
      return p == null ? null : Number(p);
    }

    function fallback(): ResolvedPrice {
      if (variant?.priceOverride != null) {
        return { unitPrice: Number(variant.priceOverride), source: 'VARIANT', variantLabel };
      }
      return productTier(category?.sellingPrice, variantLabel);
    }

    if (!customerId) return fallback();

    if (customerPriceList?.priceList) {
      const rulesForCategory = customerPriceList.priceList.rules.filter(
        (r: any) => r.categoryId === line.categoryId,
      );
      const { variantRules, productRules } = splitRules(rulesForCategory, line.variantId ?? null);
      const rule = applicableRule(variantRules, line.quantity) ?? applicableRule(productRules, line.quantity);
      const price = rule && rulePrice(rule, basePrice());
      if (price != null) {
        return {
          unitPrice: price,
          source: 'CUSTOMER_LIST',
          priceListId: customerPriceList.priceList.id,
          priceListName: customerPriceList.priceList.name,
          variantLabel,
        };
      }
    }

    if (defaultList) {
      const rulesForCategory = defaultList.rules.filter((r: any) => r.categoryId === line.categoryId);
      const { variantRules, productRules } = splitRules(rulesForCategory, line.variantId ?? null);
      const rule = applicableRule(variantRules, line.quantity) ?? applicableRule(productRules, line.quantity);
      const price = rule && rulePrice(rule, basePrice());
      if (price != null) {
        return {
          unitPrice: price,
          source: 'DEFAULT_LIST',
          priceListId: defaultList.id,
          priceListName: defaultList.name,
          variantLabel,
        };
      }
    }

    return fallback();
  });
}
