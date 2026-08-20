import { prisma } from '../db.js';

/** Where a resolved price came from — useful when a price needs explaining. */
export type PriceSource = 'CUSTOMER_LIST' | 'DEFAULT_LIST' | 'PRODUCT';

export interface ResolvedPrice {
  unitPrice: number;
  source: PriceSource;
  priceListId?: string;
  priceListName?: string;
}

/**
 * Picks the tier that applies at this quantity.
 *
 * Rules arrive sorted by minQuantity descending, so the first rule the order
 * reaches is the highest tier it qualifies for — buy 100 against tiers of 1/10/50
 * and you get the 50 price, not the 1 price.
 */
function applicableRule(rules: { minQuantity: number; unitPrice: any }[], quantity: number) {
  return rules.find((rule) => quantity >= rule.minQuantity);
}

async function productPrice(categoryId: string): Promise<number> {
  const category = await prisma.inventoryCategory.findUnique({
    where: { id: categoryId },
    select: { sellingPrice: true, costPrice: true },
  });
  return Number(category?.sellingPrice ?? category?.costPrice ?? 0);
}

/**
 * Works out what one unit of a product costs this customer at this quantity.
 *
 * Three places to look, most specific first:
 *
 *   1. A price list assigned to this customer — their negotiated rates.
 *   2. The organisation's default price list — the standard wholesale rates.
 *   3. The product's own selling price.
 *
 * Step 2 used to be missing, which made tiered pricing unreachable in practice:
 * every list had to be assigned to every customer by hand before it did
 * anything, and nothing in the UI could even create that assignment. With the
 * default in place, assignment becomes what it should be — something you do for
 * a customer who has negotiated *different* rates, not a prerequisite for having
 * any rates at all.
 */
export async function resolvePriceDetailed(
  tenantId: string,
  categoryId: string,
  customerId: string | null,
  quantity: number,
): Promise<ResolvedPrice> {
  // No customer means no price list can apply: lists are attached to customers,
  // and the default is the *wholesale* standard, not a walk-in counter price.
  if (!customerId) {
    return { unitPrice: await productPrice(categoryId), source: 'PRODUCT' };
  }

  const customerPriceList = await prisma.customerPriceList.findFirst({
    where: { customerId, priceList: { tenantId } },
    include: {
      priceList: {
        include: { rules: { where: { categoryId }, orderBy: { minQuantity: 'desc' } } },
      },
    },
  });

  if (customerPriceList?.priceList) {
    const rule = applicableRule(customerPriceList.priceList.rules, quantity);
    if (rule) {
      return {
        unitPrice: Number(rule.unitPrice),
        source: 'CUSTOMER_LIST',
        priceListId: customerPriceList.priceList.id,
        priceListName: customerPriceList.priceList.name,
      };
    }
    // Assigned a list that says nothing about this product: fall through to the
    // default rather than stopping here, so a customer-specific list only needs
    // to carry the products that customer actually negotiated.
  }

  const defaultList = await prisma.priceList.findFirst({
    where: { tenantId, isDefault: true },
    include: { rules: { where: { categoryId }, orderBy: { minQuantity: 'desc' } } },
  });

  if (defaultList) {
    const rule = applicableRule(defaultList.rules, quantity);
    if (rule) {
      return {
        unitPrice: Number(rule.unitPrice),
        source: 'DEFAULT_LIST',
        priceListId: defaultList.id,
        priceListName: defaultList.name,
      };
    }
  }

  // Deliberate last resort, not an accident: no list covers this product at this
  // quantity, so the product's own price stands.
  return { unitPrice: await productPrice(categoryId), source: 'PRODUCT' };
}

/** Price only, for callers that do not care where it came from. */
export async function resolvePrice(
  tenantId: string,
  categoryId: string,
  customerId: string | null,
  quantity: number,
): Promise<number> {
  return (await resolvePriceDetailed(tenantId, categoryId, customerId, quantity)).unitPrice;
}
