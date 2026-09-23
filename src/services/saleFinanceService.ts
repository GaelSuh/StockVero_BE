import { prisma } from '../db.js';
import { recordIncome } from './balanceService.js';

type PrismaWriteClient =
  | typeof prisma
  | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>
  | any;

export async function recordSaleAsIncome(
  tx: PrismaWriteClient,
  sale: { id: string; saleNumber: string; totalAmount: any; mode: string; createdAt: Date; customerId?: string | null },
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
      // Without this, a sale's income transaction was findable by sale id
      // but not by customer — the Finance tab on a customer's own page had
      // no way to show money tied to them at all.
      customerId: sale.customerId ?? null,
      isAutomatic: true,
      recordedAt: sale.createdAt,
    },
  });

  await recordIncome(tenantId, amount, tx);

  return transaction.id;
}

/**
 * Records a tip (money tendered beyond the sale total, per the shop's
 * "overpayment becomes a tip for the seller" policy) as its own income
 * transaction, so it shows up in reporting instead of being silently absorbed
 * into the sale total.
 */
export async function recordSaleTipAsIncome(
  tx: PrismaWriteClient,
  sale: { id: string; saleNumber: string; soldByName: string },
  tipAmount: number,
  tenantId: string,
): Promise<void> {
  if (tipAmount <= 0) return;

  await (tx as any).transaction.create({
    data: {
      tenantId,
      type: 'INCOME',
      status: 'ACCEPTED',
      amount: tipAmount,
      currency: 'XAF',
      description: `Tip on Sale #${sale.saleNumber} (${sale.soldByName})`,
      category: 'Tip',
      moduleRef: 'retail_sales',
      entityId: sale.id,
      isAutomatic: true,
      recordedAt: new Date(),
    },
  });

  await recordIncome(tenantId, tipAmount, tx);
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

  // applyExpense, not recordExpense: the money has already left the till.
  // Refusing to write it down because the recorded balance is short would only
  // stop the ledger ever catching up.
  const { applyExpense } = await import('./balanceService.js');
  await applyExpense(tenantId, amount, tx);
}
