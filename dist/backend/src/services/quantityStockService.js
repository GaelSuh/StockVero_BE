import { applyExpense } from './balanceService.js';
/**
 * Books the cost of acquiring quantity-tracked stock.
 *
 * Serialised stock already does this per unit through `deductUnitCost`; quantity
 * stock had no equivalent, which is why bulk-imported inventory had no cost basis
 * in Finance at all. There is no setting that turns this off — if stock was
 * bought, the money left.
 */
export async function recordQuantityStockExpense(tx, params) {
    const { tenantId, categoryId, categoryName, amount, quantity, note } = params;
    if (amount <= 0)
        return;
    await tx.transaction.create({
        data: {
            tenantId,
            type: 'EXPENSE',
            status: 'ACCEPTED',
            amount: amount,
            currency: 'XAF',
            description: `Stock acquired: ${quantity} x ${categoryName}`,
            category: 'Stock Purchase',
            moduleRef: 'inventory',
            entityId: categoryId,
            isAutomatic: true,
            notes: note ?? null,
            recordedAt: new Date(),
        },
    });
    // applyExpense, not recordExpense: buying stock is a fact being recorded, not a
    // spend being authorised. A shop stocking up before its first sale has a zero
    // balance, and refusing the import there would be refusing the truth.
    await applyExpense(tenantId, amount, tx);
}
/**
 * The single entry point for increasing quantity-tracked stock. Every surface
 * that adds stock — product creation, bulk import, restock — goes through here so
 * the count and the ledger can never drift apart.
 */
export async function addQuantityStock({ tx, tenantId, categoryId, quantityAdded, costPrice, isNewPurchase = true, categoryName, note, offlineId, variantId, }) {
    if (quantityAdded <= 0)
        return;
    // A replayed sync must not receive the same delivery twice.
    if (offlineId) {
        const already = await tx.categoryStockLog.findFirst({
            where: { tenantId, offlineId },
            select: { id: true },
        });
        if (already)
            return;
    }
    // The variant arrives from a device payload, so it is checked rather than
    // trusted: one belonging to another product (or another tenant) would credit
    // stock to an option this product does not sell, where no stock read would
    // ever find it again.
    let variant = null;
    if (variantId) {
        variant = await tx.productVariant.findFirst({
            where: { id: variantId, tenantId, categoryId },
            select: { id: true, label: true, quantityOnHand: true },
        });
        if (!variant) {
            throw new Error('That variant does not belong to this product.');
        }
    }
    // Only one of the two counters moves. A variant's stock is its own; adding
    // to the parent as well would double-count the same delivery.
    const updated = await tx.inventoryCategory.update({
        where: { id: categoryId },
        data: variant ? {} : { quantityOnHand: { increment: quantityAdded } },
        select: { id: true, name: true, quantityOnHand: true },
    });
    let stockAfter = updated.quantityOnHand;
    if (variant) {
        const updatedVariant = await tx.productVariant.update({
            where: { id: variant.id },
            data: { quantityOnHand: { increment: quantityAdded } },
            select: { quantityOnHand: true },
        });
        stockAfter = updatedVariant.quantityOnHand;
    }
    const label = variant ? `${updated.name} (${variant.label})` : updated.name;
    await tx.categoryStockLog.create({
        data: {
            tenantId,
            categoryId,
            // So the product's stock history shows which option each delivery was
            // for, rather than a run of identical-looking rows.
            variantId: variant?.id ?? null,
            eventType: isNewPurchase ? 'STOCK_PURCHASE' : 'OPENING_STOCK',
            stockBefore: stockAfter - quantityAdded,
            stockAfter,
            delta: quantityAdded,
            title: isNewPurchase
                ? `Stock purchased — ${quantityAdded} unit(s)${variant ? ` · ${variant.label}` : ''}`
                : `Opening stock recorded — ${quantityAdded} unit(s)${variant ? ` · ${variant.label}` : ''}`,
            notes: note ?? null,
            offlineId: offlineId ?? null,
        },
    });
    if (!isNewPurchase)
        return;
    await recordQuantityStockExpense(tx, {
        tenantId,
        categoryId,
        // The expense is against the product — money does not belong to an option
        // — but the name says which one was bought so the ledger line is readable.
        categoryName: categoryName ?? label,
        amount: costPrice * quantityAdded,
        quantity: quantityAdded,
        note,
    });
}
