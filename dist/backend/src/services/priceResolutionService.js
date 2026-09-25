import { prisma } from '../db.js';
/**
 * Picks the tier that applies at this quantity. Rules arrive sorted by
 * minQuantity descending, so the first rule the order reaches is the
 * highest tier it qualifies for.
 */
function applicableRule(rules, quantity) {
    return rules.find((rule) => quantity >= rule.minQuantity);
}
/** Splits a category's rules into the ones scoped to this specific variant and the product-level ones. */
function splitRules(rules, variantId) {
    const variantRules = variantId ? rules.filter((r) => r.variantId === variantId) : [];
    const productRules = rules.filter((r) => r.variantId === null);
    return { variantRules, productRules };
}
async function productPrice(client, categoryId) {
    const category = await client.inventoryCategory.findUnique({
        where: { id: categoryId },
        select: { sellingPrice: true, costPrice: true },
    });
    return Number(category?.sellingPrice ?? category?.costPrice ?? 0);
}
async function loadVariant(client, variantId) {
    return client.productVariant.findUnique({
        where: { id: variantId },
        select: { label: true, priceOverride: true },
    });
}
/**
 * Works out what one unit of a product (optionally, one specific variant of
 * it) costs this customer at this quantity. Six tiers, most specific first —
 * see priceResolutionService's earlier revisions for the full cascade
 * rationale; unchanged here except for accepting a caller-supplied client so
 * this can run inside a `prisma.$transaction` instead of always hitting the
 * pool directly.
 */
export async function resolvePriceDetailed(tenantId, categoryId, customerId, quantity, variantId = null, client = prisma) {
    const variant = variantId ? await loadVariant(client, variantId) : null;
    const variantLabel = variant?.label;
    async function fallbackPrice() {
        if (variant?.priceOverride != null) {
            return { unitPrice: Number(variant.priceOverride), source: 'VARIANT', variantLabel };
        }
        return { unitPrice: await productPrice(client, categoryId), source: 'PRODUCT', variantLabel };
    }
    if (!customerId)
        return fallbackPrice();
    const customerPriceList = await client.customerPriceList.findFirst({
        where: { customerId, priceList: { tenantId } },
        include: {
            priceList: {
                include: { rules: { where: { categoryId }, orderBy: { minQuantity: 'desc' } } },
            },
        },
    });
    if (customerPriceList?.priceList) {
        const { variantRules, productRules } = splitRules(customerPriceList.priceList.rules, variantId);
        const rule = applicableRule(variantRules, quantity) ?? applicableRule(productRules, quantity);
        if (rule) {
            return {
                unitPrice: Number(rule.unitPrice),
                source: 'CUSTOMER_LIST',
                priceListId: customerPriceList.priceList.id,
                priceListName: customerPriceList.priceList.name,
                variantLabel,
            };
        }
    }
    const defaultList = await client.priceList.findFirst({
        where: { tenantId, isDefault: true },
        include: { rules: { where: { categoryId }, orderBy: { minQuantity: 'desc' } } },
    });
    if (defaultList) {
        const { variantRules, productRules } = splitRules(defaultList.rules, variantId);
        const rule = applicableRule(variantRules, quantity) ?? applicableRule(productRules, quantity);
        if (rule) {
            return {
                unitPrice: Number(rule.unitPrice),
                source: 'DEFAULT_LIST',
                priceListId: defaultList.id,
                priceListName: defaultList.name,
                variantLabel,
            };
        }
    }
    return fallbackPrice();
}
/** Price only, for callers that do not care where it came from. */
export async function resolvePrice(tenantId, categoryId, customerId, quantity, variantId = null, client = prisma) {
    return (await resolvePriceDetailed(tenantId, categoryId, customerId, quantity, variantId, client)).unitPrice;
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
export async function resolvePricesForSale(tenantId, customerId, lines, client = prisma) {
    const categoryIds = [...new Set(lines.map((l) => l.categoryId))];
    const variantIds = [...new Set(lines.filter((l) => l.variantId).map((l) => l.variantId))];
    const [customerPriceList, defaultList, variants, categories] = await Promise.all([
        customerId
            ? client.customerPriceList.findFirst({
                where: { customerId, priceList: { tenantId } },
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
            select: { id: true, sellingPrice: true, costPrice: true },
        }),
    ]);
    // Explicit value types: the `variantIds.length ? ... : Promise.resolve([])`
    // branch above makes TS infer the empty arm as never[], which would leave
    // Map#get returning {} and lose label/priceOverride.
    const variantById = new Map(variants.map((v) => [v.id, v]));
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    return lines.map((line) => {
        const variant = line.variantId ? variantById.get(line.variantId) : undefined;
        const variantLabel = variant?.label;
        const category = categoryById.get(line.categoryId);
        const productPriceForLine = Number(category?.sellingPrice ?? category?.costPrice ?? 0);
        function fallback() {
            if (variant?.priceOverride != null) {
                return { unitPrice: Number(variant.priceOverride), source: 'VARIANT', variantLabel };
            }
            return { unitPrice: productPriceForLine, source: 'PRODUCT', variantLabel };
        }
        if (!customerId)
            return fallback();
        if (customerPriceList?.priceList) {
            const rulesForCategory = customerPriceList.priceList.rules.filter((r) => r.categoryId === line.categoryId);
            const { variantRules, productRules } = splitRules(rulesForCategory, line.variantId ?? null);
            const rule = applicableRule(variantRules, line.quantity) ?? applicableRule(productRules, line.quantity);
            if (rule) {
                return {
                    unitPrice: Number(rule.unitPrice),
                    source: 'CUSTOMER_LIST',
                    priceListId: customerPriceList.priceList.id,
                    priceListName: customerPriceList.priceList.name,
                    variantLabel,
                };
            }
        }
        if (defaultList) {
            const rulesForCategory = defaultList.rules.filter((r) => r.categoryId === line.categoryId);
            const { variantRules, productRules } = splitRules(rulesForCategory, line.variantId ?? null);
            const rule = applicableRule(variantRules, line.quantity) ?? applicableRule(productRules, line.quantity);
            if (rule) {
                return {
                    unitPrice: Number(rule.unitPrice),
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
