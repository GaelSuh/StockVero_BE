import { prisma } from '../db.js';
import { deductStockForSale, restoreStockForReturn } from './saleInventoryService.js';
import { getNextReturnNumber, getNextSaleNumber } from './saleService.js';
import { recordReturnAsExpense, recordSaleAsIncome } from './saleFinanceService.js';

type PrismaWriteClient =
  | typeof prisma
  | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>
  | any;

interface ReturnItemInput {
  categoryId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
}

/** Goods handed over in place of what came back. */
interface ExchangeItemInput extends ReturnItemInput {
  sku?: string | null;
}

export class ReturnValidationError extends Error {
  constructor(message: string) {
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
export async function processReturn(
  tenantId: string,
  saleId: string,
  input: {
    reason: string;
    returnType: 'REFUND' | 'EXCHANGE';
    items: ReturnItemInput[];
    exchangeItems?: ExchangeItemInput[];
    refundMethod?: string;
    processedById: string;
    processedByName: string;
  },
) {
  return prisma.$transaction(
    async (tx: PrismaWriteClient) => {
      const sale = await (tx as any).sale.findFirst({
        where: { id: saleId, tenantId },
        include: { items: true },
      });
      if (!sale) throw new ReturnValidationError('Sale not found');

      // ── Nothing may be returned that was not sold ────────────────────────────
      // Without this a return could refund money and create stock out of thin
      // air: there was no check at all against what the sale actually contained.
      const soldByCategory = new Map<string, number>();
      for (const line of sale.items) {
        soldByCategory.set(
          line.categoryId,
          (soldByCategory.get(line.categoryId) ?? 0) + line.quantity,
        );
      }

      const priorReturns = await (tx as any).saleReturn.findMany({
        where: { saleId },
        include: { items: true },
      });
      const alreadyReturned = new Map<string, number>();
      for (const r of priorReturns) {
        for (const line of r.items) {
          alreadyReturned.set(
            line.categoryId,
            (alreadyReturned.get(line.categoryId) ?? 0) + line.quantity,
          );
        }
      }

      for (const item of input.items) {
        if (item.quantity <= 0) {
          throw new ReturnValidationError(
            `Return quantity for ${item.productName} must be at least 1.`,
          );
        }
        const sold = soldByCategory.get(item.categoryId) ?? 0;
        if (sold === 0) {
          throw new ReturnValidationError(
            `${item.productName} was not part of sale ${sale.saleNumber}.`,
          );
        }
        const returnable = sold - (alreadyReturned.get(item.categoryId) ?? 0);
        if (item.quantity > returnable) {
          throw new ReturnValidationError(
            `Cannot return ${item.quantity} of ${item.productName}: ${sold} sold, ` +
              `${sold - returnable} already returned, ${Math.max(0, returnable)} left.`,
          );
        }
      }

      const returnNumber = await getNextReturnNumber(tenantId, tx);
      const refundAmount = input.items.reduce(
        (sum, item) => sum + item.unitPrice * item.quantity,
        0,
      );

      // ── Exchange: replacement goods leave as their own sale ──────────────────
      let exchangeSaleId: string | null = null;
      let exchangeTotal = 0;

      if (input.returnType === 'EXCHANGE') {
        const outgoing = input.exchangeItems ?? [];
        if (outgoing.length === 0) {
          throw new ReturnValidationError(
            'An exchange needs at least one replacement item.',
          );
        }
        exchangeTotal = outgoing.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

        const replacementNumber = await getNextSaleNumber(tenantId, tx);
        const difference = exchangeTotal - refundAmount;

        const replacement = await (tx as any).sale.create({
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
              })),
            },
            // Only the difference is fresh money; the rest is paid for by the
            // returned goods, so recording the full total as a payment would
            // overstate the day's takings.
            payments:
              difference > 0
                ? {
                    create: [
                      {
                        method: (input.refundMethod as any) || 'CASH',
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

        await deductStockForSale(
          tx,
          outgoing.map((i) => ({
            categoryId: i.categoryId,
            productName: i.productName,
            quantity: i.quantity,
          })) as any,
          replacementNumber,
          tenantId,
          input.processedById,
        );

        // An exchange really is a sale, so it books its full value as income and
        // the goods coming back book their full value as an expense. The two net
        // to the difference the customer actually settled. Recording only the
        // difference would leave the sale missing from revenue reports entirely.
        await recordSaleAsIncome(tx, replacement, tenantId);
      }

      const saleReturn = await (tx as any).saleReturn.create({
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
            create: input.items.map((item) => ({
              categoryId: item.categoryId,
              productName: item.productName,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            })),
          },
        },
        include: { items: true },
      });

      await restoreStockForReturn(
        tx,
        input.items,
        returnNumber,
        tenantId,
        input.processedById,
      );

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
          await (tx as any).sale.update({
            where: { id: saleId },
            data: {
              amountOwed: newOwed,
              paymentStatus:
                newOwed <= 0
                  ? Number(sale.amountPaid ?? 0) > 0
                    ? 'PAID'
                    : 'PAID'
                  : 'PARTIAL',
            },
          });
        }

        if (cashRefunded > 0) {
          await recordReturnAsExpense(
            tx,
            { ...saleReturn, refundAmount: cashRefunded },
            sale.saleNumber,
            tenantId,
          );
        }
      }

      // ── Mark the sale returned once everything has come back ─────────────────
      const totalReturned = [...priorReturns, saleReturn].reduce(
        (sum: number, r: any) => sum + Number(r.refundAmount),
        0,
      );
      if (totalReturned >= Number(sale.totalAmount)) {
        await (tx as any).sale.update({
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
      };
    },
    // Restoring stock, raising a replacement sale and settling money is more
    // work than the 5s default allows against a database in another region.
    { timeout: 30_000, maxWait: 10_000 },
  );
}
