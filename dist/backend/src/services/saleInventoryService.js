import { prisma } from '../db.js';
import { isQuantityTracked } from '../lib/stock.js';
/** Thrown to abort the sale transaction outright — nothing gets sold on credit
 * against stock that isn't there. Caught in the controller and reported as a
 * plain 400, not a server error. */
export class InsufficientStockError extends Error {
    constructor(items) {
        super(`Not enough stock: ${items.map((i) => `${i.productName} (requested ${i.requested}, ${i.available} available)`).join('; ')}`);
        this.items = items;
        this.name = 'InsufficientStockError';
    }
}
/**
 * A category-level line and a variant-level line for the same product must
 * never collide in the same remaining-stock map, so every lookup goes through
 * this composite key — a plain no-variant line keys on `${categoryId}::`, a
 * variant line on `${categoryId}::${variantId}`.
 */
function stockKey(categoryId, variantId) {
    return `${categoryId}::${variantId ?? ''}`;
}
/**
 * Deducts sold stock. Rejects (throws InsufficientStockError, rolling back the
 * whole sale) rather than letting a count go negative — a shop only ever has
 * one till per account, so there is no legitimate race to make room for.
 */
export async function deductStockForSale(tx, items, saleNumber, tenantId, performedBy) {
    const soldUnitIds = new Array(items.length).fill(null);
    const lowStock = [];
    const logs = [];
    // One read for the whole cart rather than one per line. Each round trip to a
    // managed database in another region costs real time, and this runs inside a
    // transaction that must not outlive its timeout.
    const categoryIds = [...new Set(items.map((i) => i.categoryId))];
    const categories = await tx.inventoryCategory.findMany({
        where: { id: { in: categoryIds } },
        select: {
            id: true,
            name: true,
            quantityOnHand: true,
            stockTrackingMode: true,
            reorderThreshold: true,
        },
    });
    const byId = new Map(categories.map((c) => [c.id, c]));
    // Every distinct variant referenced, fetched once up front — needed both for
    // the QUANTITY case (its own quantityOnHand counter) and to give every log
    // and low-stock line the variant's own label.
    const variantIds = [...new Set(items.map((i) => i.variantId).filter((v) => !!v))];
    const variants = variantIds.length
        ? await tx.productVariant.findMany({
            where: { id: { in: variantIds }, tenantId },
            select: { id: true, label: true, quantityOnHand: true, categoryId: true },
        })
        : [];
    const variantById = new Map(variants.map((v) => [v.id, v]));
    // Serialised stock is *read* as the count of AVAILABLE unit rows, never
    // `plannedQty` — that column is the quantity an invoice authorised, an
    // unrelated planning number. Mixing the two is what let a product with
    // zero physical units left still show as sellable. One grouped count for
    // the whole cart, then tracked down as lines consume it below.
    //
    // Grouped by variantId as well now: a serialized product with variants must
    // never let one variant's units be counted as another's.
    const serializedIds = categories
        .filter((c) => !isQuantityTracked(c))
        .map((c) => c.id);
    const availableCounts = serializedIds.length
        ? await tx.productItem.groupBy({
            by: ['categoryId', 'variantId'],
            where: { tenantId, categoryId: { in: serializedIds }, stockStatus: 'AVAILABLE' },
            _count: { _all: true },
        })
        : [];
    // Seeded for both tracking modes, so two cart lines for the same product —
    // quantity or serialised — are checked against how much is left after the
    // first line, not each independently against the original total.
    const remaining = new Map();
    for (const row of availableCounts) {
        remaining.set(stockKey(row.categoryId, row.variantId), row._count._all);
    }
    for (const category of categories) {
        if (!isQuantityTracked(category))
            continue;
        // QUANTITY-tracked, no variant: the category's own counter — unchanged.
        remaining.set(stockKey(category.id, null), category.quantityOnHand);
    }
    for (const variant of variants) {
        const category = byId.get(variant.categoryId);
        if (category && isQuantityTracked(category)) {
            // QUANTITY-tracked variant: its own counter, never the parent
            // category's — see the schema note on ProductVariant.quantityOnHand.
            remaining.set(stockKey(variant.categoryId, variant.id), variant.quantityOnHand);
        }
    }
    // Checked up front, across the whole cart, before anything is written —
    // two lines for the same out-of-stock product/variant must both be caught,
    // not just the first.
    const insufficient = [];
    for (const item of items) {
        const category = byId.get(item.categoryId);
        if (!category)
            continue;
        const key = stockKey(item.categoryId, item.variantId);
        const available = remaining.get(key) ?? 0;
        if (item.quantity > available) {
            insufficient.push({ productName: item.productName, requested: item.quantity, available });
            continue;
        }
        remaining.set(key, available - item.quantity);
    }
    if (insufficient.length > 0) {
        throw new InsufficientStockError(insufficient);
    }
    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const category = byId.get(item.categoryId);
        if (!category)
            continue;
        const quantityTracked = isQuantityTracked(category);
        const key = stockKey(item.categoryId, item.variantId);
        const variant = item.variantId ? variantById.get(item.variantId) : null;
        const displayName = variant ? `${item.productName} (${variant.label})` : item.productName;
        if (quantityTracked) {
            if (item.variantId && variant) {
                const before = variant.quantityOnHand;
                const settled = before - item.quantity;
                await tx.productVariant.update({
                    where: { id: item.variantId },
                    data: { quantityOnHand: settled },
                });
                // Two lines can name the same variant — without tracking the running
                // total here, a second line would deduct from stock the first spent.
                variant.quantityOnHand = settled;
                logs.push({
                    tenantId,
                    categoryId: item.categoryId,
                    variantId: item.variantId,
                    eventType: 'SALE_DEDUCTION',
                    stockBefore: before,
                    stockAfter: settled,
                    delta: -item.quantity,
                    title: `Sale #${saleNumber} - ${displayName}`,
                    performedBy,
                });
                // Variants carry no reorderThreshold of their own — the parent
                // category's threshold is reused for every one of its variants.
                if (category.reorderThreshold > 0 && settled <= category.reorderThreshold) {
                    lowStock.push({ name: displayName, remaining: settled });
                }
            }
            else {
                const currentStock = category.quantityOnHand;
                const settled = currentStock - item.quantity;
                await tx.inventoryCategory.update({
                    where: { id: item.categoryId },
                    data: { quantityOnHand: settled },
                });
                // Two lines can name the same product — without tracking the running
                // total here, a second line would deduct from the stock the first
                // already spent.
                category.quantityOnHand = settled;
                logs.push({
                    tenantId,
                    categoryId: item.categoryId,
                    eventType: 'SALE_DEDUCTION',
                    stockBefore: currentStock,
                    stockAfter: settled,
                    delta: -item.quantity,
                    title: `Sale #${saleNumber} - ${displayName}`,
                    performedBy,
                });
                if (category.reorderThreshold > 0 && settled <= category.reorderThreshold) {
                    lowStock.push({ name: displayName, remaining: settled });
                }
            }
            continue;
        }
        // The cashier picked one specific physical unit — that exact one must be
        // the one marked DEPLOYED (the same terminal "gone" status a project
        // deployment uses — a sold unit is never coming back through this
        // category's stock any more than a deployed one is), not just whichever
        // happens to be oldest. The conditional `stockStatus: 'AVAILABLE'` in the
        // where-clause makes this claim atomic: if the unit was already taken,
        // the update matches zero rows instead of silently double-selling it —
        // caught as insufficient stock just like a plain quantity shortfall. A
        // return restores this exact unit by its id (SaleItem.productItemId),
        // never by searching for "the oldest deployed one" — so merging this
        // status with a project deployment's is safe.
        //
        // `variantId` is matched EXACTLY (null included), not left unfiltered:
        // the pre-check above counted this line against `${categoryId}::${variantId}`,
        // so the claim has to consume from that same bucket. Leaving it
        // unfiltered would let a no-variant line claim a variant's unit that the
        // pre-check never counted, overselling that variant.
        let soldSystemIds = [];
        if (item.unitId) {
            const claim = await tx.productItem.updateMany({
                where: {
                    id: item.unitId,
                    tenantId,
                    categoryId: item.categoryId,
                    variantId: item.variantId ?? null,
                    stockStatus: 'AVAILABLE',
                },
                data: { stockStatus: 'DEPLOYED' },
            });
            if (claim.count === 0) {
                throw new InsufficientStockError([{ productName: displayName, requested: 1, available: 0 }]);
            }
            soldUnitIds[idx] = item.unitId;
            // Fetched after the claim rather than carried on the request — the
            // history log should say what actually left, not what was asked for.
            const claimed = await tx.productItem.findUnique({
                where: { id: item.unitId },
                select: { systemId: true },
            });
            if (claimed?.systemId)
                soldSystemIds = [claimed.systemId];
        }
        else {
            // No unit picked (legacy/manual entry) — consume the oldest available,
            // scoped to exactly this variant bucket.
            const consumed = await tx.productItem.findMany({
                where: {
                    tenantId,
                    categoryId: item.categoryId,
                    variantId: item.variantId ?? null,
                    stockStatus: 'AVAILABLE',
                },
                orderBy: { createdAt: 'asc' },
                take: item.quantity,
                select: { id: true, systemId: true },
            });
            if (consumed.length < item.quantity) {
                throw new InsufficientStockError([
                    { productName: displayName, requested: item.quantity, available: consumed.length },
                ]);
            }
            await tx.productItem.updateMany({
                where: { id: { in: consumed.map((u) => u.id) } },
                data: { stockStatus: 'DEPLOYED' },
            });
            soldUnitIds[idx] = consumed[0]?.id ?? null;
            soldSystemIds = consumed.map((u) => u.systemId).filter(Boolean);
        }
        const after = remaining.get(key) ?? 0;
        logs.push({
            tenantId,
            categoryId: item.categoryId,
            variantId: item.variantId ?? null,
            eventType: 'SALE_DEDUCTION',
            // A log row is one row regardless of quantity, so with more than one
            // unit on this line only the first serial is attributed here — the
            // rest still moved the count, just without their own named entry.
            unitSystemId: soldSystemIds[0] ?? null,
            stockBefore: after + item.quantity,
            stockAfter: after,
            delta: -item.quantity,
            title: `Sale #${saleNumber} - ${displayName}`,
            performedBy,
        });
        if (category.reorderThreshold > 0 && after <= category.reorderThreshold) {
            lowStock.push({ name: displayName, remaining: after });
        }
    }
    // Written in one statement instead of one per line.
    if (logs.length > 0) {
        await tx.categoryStockLog.createMany({ data: logs });
    }
    if (lowStock.length > 0) {
        await tx.notification.createMany({
            data: lowStock.map((entry) => ({
                tenantId,
                userId: performedBy,
                userType: 'OWNER',
                type: 'LOW_STOCK_ALERT',
                title: `Low Stock: ${entry.name}`,
                message: `Only ${entry.remaining} units remaining after sale #${saleNumber}`,
            })),
        });
    }
    return { soldUnitIds };
}
export async function restoreStockForReturn(tx, items, returnNumber, tenantId, performedBy) {
    const skipped = [];
    for (const item of items) {
        const category = await tx.inventoryCategory.findUnique({
            where: { id: item.categoryId },
            select: { id: true, quantityOnHand: true, stockTrackingMode: true },
        });
        if (!category)
            continue;
        const quantityTracked = isQuantityTracked(category);
        // The exact units this return names — resolved by the caller from the
        // original sale line, never FIFO-guessed here. A unit not currently
        // DEPLOYED (already returned once, or since moved for some other reason)
        // is silently excluded rather than double-restored.
        if (!quantityTracked) {
            const before = await tx.productItem.count({
                where: {
                    tenantId,
                    categoryId: item.categoryId,
                    variantId: item.variantId ?? null,
                    stockStatus: 'AVAILABLE',
                },
            });
            if (!item.unitIds?.length) {
                skipped.push({ categoryId: item.categoryId, productName: item.productName });
                continue;
            }
            // Scoped by id, so the unit's own variantId is authoritative — no
            // variant filter needed here, and adding one would only risk refusing
            // to restore a unit the sale genuinely sold.
            const returned = await tx.productItem.findMany({
                where: { id: { in: item.unitIds }, tenantId, categoryId: item.categoryId, stockStatus: 'DEPLOYED' },
                select: { id: true, systemId: true },
            });
            if (returned.length > 0) {
                await tx.productItem.updateMany({
                    where: { id: { in: returned.map((u) => u.id) } },
                    data: { stockStatus: 'AVAILABLE' },
                });
            }
            await tx.categoryStockLog.create({
                data: {
                    tenantId,
                    categoryId: item.categoryId,
                    variantId: item.variantId ?? null,
                    eventType: 'RETURN_RESTORATION',
                    unitSystemId: returned[0]?.systemId ?? null,
                    stockBefore: before,
                    stockAfter: before + returned.length,
                    delta: returned.length,
                    title: `Return #${returnNumber} - ${item.productName}`,
                    performedBy,
                },
            });
            continue;
        }
        // QUANTITY-tracked variant: restore to the variant's own counter, never
        // the parent category's — otherwise a returned "Red / L" would top up
        // the product as a whole and quietly inflate every other variant.
        if (item.variantId) {
            const variant = await tx.productVariant.findUnique({
                where: { id: item.variantId },
                select: { quantityOnHand: true },
            });
            const currentStock = variant?.quantityOnHand ?? 0;
            const newStock = currentStock + item.quantity;
            await tx.productVariant.update({
                where: { id: item.variantId },
                data: { quantityOnHand: newStock },
            });
            await tx.categoryStockLog.create({
                data: {
                    tenantId,
                    categoryId: item.categoryId,
                    variantId: item.variantId,
                    eventType: 'RETURN_RESTORATION',
                    stockBefore: currentStock,
                    stockAfter: newStock,
                    delta: item.quantity,
                    title: `Return #${returnNumber} - ${item.productName}`,
                    performedBy,
                },
            });
            continue;
        }
        const currentStock = category.quantityOnHand;
        const newStock = currentStock + item.quantity;
        await tx.inventoryCategory.update({
            where: { id: item.categoryId },
            data: { quantityOnHand: newStock },
        });
        await tx.categoryStockLog.create({
            data: {
                tenantId,
                categoryId: item.categoryId,
                eventType: 'RETURN_RESTORATION',
                stockBefore: currentStock,
                stockAfter: newStock,
                delta: item.quantity,
                title: `Return #${returnNumber} - ${item.productName}`,
                performedBy,
            },
        });
    }
    return { skipped };
}
/**
 * Live stock for one product, or for one variant of it — the same rule
 * deductStockForSale enforces.
 *
 * Note the deliberate difference from the deduction path: omitting variantId
 * here counts every unit of the product across all its variants, because the
 * question being asked is "does this product have N available". The deduction
 * path instead matches variantId exactly, because there it must consume from
 * the same bucket its pre-check counted.
 */
export async function validateStockAvailability(categoryId, quantity, variantId) {
    const category = await prisma.inventoryCategory.findUnique({
        where: { id: categoryId },
        select: { quantityOnHand: true, stockTrackingMode: true, tenantId: true },
    });
    if (!category)
        return { available: false, currentStock: 0 };
    if (isQuantityTracked(category)) {
        if (variantId) {
            const variant = await prisma.productVariant.findUnique({
                where: { id: variantId },
                select: { quantityOnHand: true },
            });
            const currentStock = variant?.quantityOnHand ?? 0;
            return { available: currentStock >= quantity, currentStock };
        }
        return { available: category.quantityOnHand >= quantity, currentStock: category.quantityOnHand };
    }
    const currentStock = await prisma.productItem.count({
        where: {
            categoryId,
            tenantId: category.tenantId,
            variantId: variantId ?? undefined,
            stockStatus: 'AVAILABLE',
        },
    });
    return { available: currentStock >= quantity, currentStock };
}
