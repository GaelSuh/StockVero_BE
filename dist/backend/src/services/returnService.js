import { prisma } from '../db.js';
import { deductStockForSale, restoreStockForReturn } from './saleInventoryService.js';
import { getNextReturnNumber, getNextSaleNumber } from './saleService.js';
import { recordReturnAsExpense, recordSaleAsIncome } from './saleFinanceService.js';
/**
 * Sold/returned tallies are kept per option, not per product: one sale can
 * carry "Red / L" and "Blue / M" of the same product, and merging them lets a
 * return of one exhaust the other's allowance. Mirrors the backend stockKey
 * and the frontend cartLineKey.
 */
const lineKey = (categoryId, variantId) => `${categoryId}::${variantId ?? ''}`;
export class ReturnValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReturnValidationError';
    }
}
/**
 * Records a return against a sale.
 *
 * REFUND  — goods come back, stock is restored, money goes out (or the debt
 *           shrinks, if the customer never paid).
 * EXCHANGE — goods come back and replacement goods go out. The replacement is
 *           raised as a normal linked sale so it deducts stock, prices, and
 *           reports exactly like any other sale, rather than being a second
 *           half-implemented path through this file. Only the difference in
 *           value is settled.
 */
export async function processReturn(tenantId, saleId, input) {
    return prisma.$transaction(async (tx) => {
        const sale = await tx.sale.findFirst({
            where: { id: saleId, tenantId },
            include: { items: true },
        });
        if (!sale)
            throw new ReturnValidationError('Sale not found');
        // ── Nothing may be returned that was not sold ────────────────────────────
        // Without this a return could refund money and create stock out of thin
        // air: there was no check at all against what the sale actually contained.
        const soldByCategory = new Map();
        // The price a return refunds at is what this sale actually charged —
        // never whatever the request claims. Without this, `input.items[].unitPrice`
        // went straight into refundAmount unchecked: a caller could return one
        // unit of a 500 XAF item at a self-declared "unitPrice" of 5,000,000 and
        // walk away with a refund the sale never earned.
        const soldUnitPriceByCategory = new Map();
        for (const line of sale.items) {
            const key = lineKey(line.categoryId, line.variantId);
            soldByCategory.set(key, (soldByCategory.get(key) ?? 0) + line.quantity);
            if (!soldUnitPriceByCategory.has(key)) {
                soldUnitPriceByCategory.set(key, Number(line.unitPrice));
            }
        }
        const priorReturns = await tx.saleReturn.findMany({
            where: { saleId },
            include: { items: true },
        });
        const alreadyReturned = new Map();
        for (const r of priorReturns) {
            for (const line of r.items) {
                const key = lineKey(line.categoryId, line.variantId);
                alreadyReturned.set(key, (alreadyReturned.get(key) ?? 0) + line.quantity);
            }
        }
        for (const item of input.items) {
            if (item.quantity <= 0) {
                throw new ReturnValidationError(`Return quantity for ${item.productName} must be at least 1.`);
            }
            const key = lineKey(item.categoryId, item.variantId);
            const sold = soldByCategory.get(key) ?? 0;
            if (sold === 0) {
                throw new ReturnValidationError(`${item.productName} was not part of sale ${sale.saleNumber}.`);
            }
            const returnable = sold - (alreadyReturned.get(key) ?? 0);
            if (item.quantity > returnable) {
                throw new ReturnValidationError(`Cannot return ${item.quantity} of ${item.productName}: ${sold} sold, ` +
                    `${sold - returnable} already returned, ${Math.max(0, returnable)} left.`);
            }
        }
        // Overwrite whatever price the request carried with what the sale
        // actually charged, for every remaining calculation and record below —
        // one substitution here rather than a second check duplicated at each
        // place `unitPrice` gets used.
        const trustedItems = input.items.map((item) => ({
            ...item,
            unitPrice: soldUnitPriceByCategory.get(lineKey(item.categoryId, item.variantId)) ?? item.unitPrice,
        }));
        const returnNumber = await getNextReturnNumber(tenantId, tx);
        const refundAmount = trustedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
        // ── Exchange: replacement goods leave as their own sale ──────────────────
        let exchangeSaleId = null;
        let exchangeTotal = 0;
        if (input.returnType === 'EXCHANGE') {
            const outgoing = input.exchangeItems ?? [];
            if (outgoing.length === 0) {
                throw new ReturnValidationError('An exchange needs at least one replacement item.');
            }
            exchangeTotal = outgoing.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
            const replacementNumber = await getNextSaleNumber(tenantId, tx);
            const difference = exchangeTotal - refundAmount;
            const replacement = await tx.sale.create({
                data: {
                    tenantId,
                    saleNumber: replacementNumber,
                    mode: sale.mode,
                    status: 'COMPLETED',
                    customerId: sale.customerId,
                    customerName: sale.customerName,
                    soldById: input.processedById,
                    soldByType: sale.soldByType,
                    soldByName: input.processedByName,
                    subtotal: exchangeTotal,
                    discountAmount: 0,
                    taxAmount: 0,
                    totalAmount: exchangeTotal,
                    // The goods coming back pay for the goods going out; only a positive
                    // difference is money the customer still has to hand over.
                    paymentStatus: difference > 0 ? 'PAID' : 'PAID',
                    amountPaid: exchangeTotal,
                    amountOwed: 0,
                    notes: `Exchange for return #${returnNumber} on sale #${sale.saleNumber}`,
                    items: {
                        create: outgoing.map((i) => ({
                            categoryId: i.categoryId,
                            productName: i.productName,
                            sku: i.sku ?? null,
                            unitPrice: i.unitPrice,
                            quantity: i.quantity,
                            discountAmount: 0,
                            lineTotal: i.unitPrice * i.quantity,
                            // The replacement is a real sale, so its lines have to record
                            // which option went out — otherwise returning the replacement
                            // later hits the same ambiguity this pass just closed.
                            variantId: i.variantId ?? null,
                        })),
                    },
                    // Only the difference is fresh money; the rest is paid for by the
                    // returned goods, so recording the full total as a payment would
                    // overstate the day's takings.
                    payments: difference > 0
                        ? {
                            create: [
                                {
                                    method: input.refundMethod || 'CASH',
                                    amount: difference,
                                    recordedById: input.processedById,
                                    recordedByName: input.processedByName,
                                },
                            ],
                        }
                        : undefined,
                },
                include: { items: true },
            });
            exchangeSaleId = replacement.id;
            await deductStockForSale(tx, outgoing.map((i) => ({
                categoryId: i.categoryId,
                productName: i.productName,
                quantity: i.quantity,
                // Replacement goods are a fresh sale, so the variant comes from
                // the exchange request, not the returned line. Null until the
                // exchange UI sends one — same behaviour as before variants.
                variantId: i.variantId ?? null,
            })), replacementNumber, tenantId, input.processedById);
            // An exchange really is a sale, so it books its full value as income and
            // the goods coming back book their full value as an expense. The two net
            // to the difference the customer actually settled. Recording only the
            // difference would leave the sale missing from revenue reports entirely.
            await recordSaleAsIncome(tx, replacement, tenantId);
        }
        const saleReturn = await tx.saleReturn.create({
            data: {
                tenantId,
                saleId,
                returnNumber,
                reason: input.reason,
                returnType: input.returnType,
                refundAmount,
                refundMethod: input.returnType === 'REFUND' ? (input.refundMethod || 'CASH') : null,
                processedById: input.processedById,
                processedByName: input.processedByName,
                exchangeSaleId,
                items: {
                    create: trustedItems.map((item) => ({
                        categoryId: item.categoryId,
                        productName: item.productName,
                        quantity: item.quantity,
                        unitPrice: item.unitPrice,
                        // Straight from the validated request item — the caller names
                        // which option came back, rather than it being guessed from the
                        // sale's first matching line.
                        variantId: item.variantId ?? null,
                    })),
                },
            },
            include: { items: true },
        });
        // Which exact units to give back — resolved from this sale's own line
        // items, never guessed. Narrowed to units still DEPLOYED *before*
        // slicing to quantity, so an earlier partial return (which flipped its
        // unit back to AVAILABLE already) is skipped over rather than
        // re-counted here and starving a still-deployed unit of its turn.
        const candidateIds = [
            ...new Set(sale.items.filter((si) => si.productItemId).map((si) => si.productItemId)),
        ];
        const stillDeployed = candidateIds.length
            ? new Set((await tx.productItem.findMany({
                where: { id: { in: candidateIds }, tenantId, stockStatus: 'DEPLOYED' },
                select: { id: true },
            })).map((u) => u.id))
            : new Set();
        const restoreItems = input.items.map((item) => {
            const unitIds = sale.items
                .filter((si) => si.categoryId === item.categoryId &&
                // Matched on the option too, so restoring "Red / L" cannot hand
                // back a unit from "Blue / M"'s pool.
                (si.variantId ?? null) === (item.variantId ?? null) &&
                si.productItemId &&
                stillDeployed.has(si.productItemId))
                .map((si) => si.productItemId)
                .slice(0, item.quantity);
            // Restock has to land on the same variant the sale took it from —
            // for a QUANTITY product that means the variant's own counter, not
            // the parent category's.
            return { ...item, unitIds, variantId: item.variantId ?? null };
        });
        const restoreResult = await restoreStockForReturn(tx, restoreItems, returnNumber, tenantId, input.processedById);
        // ── Settlement ──────────────────────────────────────────────────────────
        let debtReduced = 0;
        let cashRefunded = 0;
        if (input.returnType === 'EXCHANGE' && refundAmount > 0) {
            // The returned goods are paid for by the replacement, not by the till, so
            // this is the expense side of the swap rather than money handed over.
            await recordReturnAsExpense(tx, saleReturn, sale.saleNumber, tenantId);
        }
        if (input.returnType === 'REFUND' && refundAmount > 0) {
            // Money the customer never handed over cannot be handed back. Clear the
            // debt first; only what they actually paid can be refunded in cash.
            const owed = Number(sale.amountOwed ?? 0);
            debtReduced = Math.min(owed, refundAmount);
            cashRefunded = refundAmount - debtReduced;
            if (debtReduced > 0) {
                const newOwed = owed - debtReduced;
                await tx.sale.update({
                    where: { id: saleId },
                    data: {
                        amountOwed: newOwed,
                        paymentStatus: newOwed <= 0
                            ? Number(sale.amountPaid ?? 0) > 0
                                ? 'PAID'
                                : 'PAID'
                            : 'PARTIAL',
                    },
                });
            }
            if (cashRefunded > 0) {
                await recordReturnAsExpense(tx, { ...saleReturn, refundAmount: cashRefunded }, sale.saleNumber, tenantId);
            }
        }
        // ── Mark the sale returned once everything has come back ─────────────────
        const totalReturned = [...priorReturns, saleReturn].reduce((sum, r) => sum + Number(r.refundAmount), 0);
        if (totalReturned >= Number(sale.totalAmount)) {
            await tx.sale.update({
                where: { id: saleId },
                data: { status: 'RETURNED' },
            });
        }
        return {
            ...saleReturn,
            exchangeTotal,
            priceDifference: exchangeTotal - refundAmount,
            debtReduced,
            cashRefunded,
            stockRestorationSkipped: restoreResult.skipped,
        };
    }, 
    // Restoring stock, raising a replacement sale and settling money is more
    // work than the 5s default allows against a database in another region.
    { timeout: 30000, maxWait: 10000 });
}
