import { prisma } from '../db.js';
import { recordIncome } from './balanceService.js';

type PrismaWriteClient =
  | typeof prisma
  | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>
  | any;

export async function recordSaleAsIncome(
  tx: PrismaWriteClient,
  sale: { id: string; saleNumber: string; totalAmount: any; mode: string; createdAt: Date },
  tenantId: string,
): Promise<string> {
  const amount = Number(sale.totalAmount);

  const transaction = await (tx as any).transaction.create({
    data: {
      tenantId,
      type: 'INCOME',
      status: 'ACCEPTED',
      amount,
      currency: 'XAF',
      description: `Sale #${sale.saleNumber} (${sale.mode})`,
      category: sale.mode === 'RETAIL' ? 'Retail Sale' : 'Wholesale Sale',
      moduleRef: sale.mode === 'RETAIL' ? 'retail_sales' : 'wholesale_sales',
      entityId: sale.id,
      isAutomatic: true,
      recordedAt: sale.createdAt,
    },
  });

  await recordIncome(tenantId, amount, tx);

  return transaction.id;
}

export async function recordReturnAsExpense(
  tx: PrismaWriteClient,
  saleReturn: { id: string; refundAmount: any; saleId: string },
  saleNumber: string,
  tenantId: string,
): Promise<void> {
  const amount = Number(saleReturn.refundAmount);
  if (amount <= 0) return;

  await (tx as any).transaction.create({
    data: {
      tenantId,
      type: 'EXPENSE',
      status: 'ACCEPTED',
      amount,
      currency: 'XAF',
      description: `Return on Sale #${saleNumber}`,
      category: 'Sale Return',
      moduleRef: 'retail_sales',
      entityId: saleReturn.id,
      isAutomatic: true,
      recordedAt: new Date(),
    },
  });

  const { recordExpense } = await import('./balanceService.js');
  await recordExpense(tenantId, amount, tx);
}
