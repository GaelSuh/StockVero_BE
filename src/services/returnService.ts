import { prisma } from '../db.js';
import { deductStockForSale, restoreStockForReturn } from './saleInventoryService.js';
import { recordSaleAsIncome } from './saleFinanceService.js';
import { getNextReturnNumber } from './saleService.js';
import { recordReturnAsExpense } from './saleFinanceService.js';

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

export async function processReturn(
  tenantId: string,
  saleId: string,
  input: {
    reason: string;
    returnType: 'REFUND' | 'EXCHANGE';
    items: ReturnItemInput[];
    refundMethod?: string;
    processedById: string;
    processedByName: string;
  },
) {
  return prisma.$transaction(async (tx: PrismaWriteClient) => {
    const sale = await (tx as any).sale.findFirst({
      where: { id: saleId, tenantId },
    });
    if (!sale) throw new Error('Sale not found');

    const returnNumber = await getNextReturnNumber(tenantId, tx);
    const refundAmount = input.items.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity, 0,
    );

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

    if (input.returnType === 'REFUND' && refundAmount > 0) {
      await recordReturnAsExpense(tx, saleReturn, sale.saleNumber, tenantId);
    }

    const allReturns = await (tx as any).saleReturn.findMany({
      where: { saleId },
      include: { items: true },
    });
    const totalReturned = allReturns.reduce(
      (sum: number, r: any) => sum + Number(r.refundAmount), 0,
    );
    if (totalReturned >= Number(sale.totalAmount)) {
      await (tx as any).sale.update({
        where: { id: saleId },
        data: { status: 'RETURNED' },
      });
    }

    return saleReturn;
  });
}
