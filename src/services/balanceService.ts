import { prisma } from '../db.js';
import { activeBranchId } from '../lib/branchScope.js';

/** Each branch keeps its own running balance (one cash box per branch). */
const balanceKey = (tenantId: string) => ({
  tenantId_branchId: { tenantId, branchId: activeBranchId() },
});

type PrismaWriteClient =
  | typeof prisma
  | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>
  | any;

export class InsufficientFundsError extends Error {
  constructor(
    public readonly netBalance: number,
    public readonly required: number,
    public readonly shortfall: number = required - netBalance,
  ) {
    super(
      `Insufficient funds. Current net balance: ${netBalance.toFixed(2)} XAF. ` +
        `Required: ${required.toFixed(2)} XAF. Shortfall: ${shortfall.toFixed(2)} XAF.`,
    );
    this.name = 'InsufficientFundsError';
  }
}

/**
 * The stored running balance: the active branch's, or every branch summed in
 * the All branches view (the branch scope decides which rows are seen).
 * Null when nothing has been recorded yet.
 */
export async function getStoredBalance(tenantId: string): Promise<{
  totalIncome: number; totalExpense: number; netBalance: number; updatedAt: Date | null;
} | null> {
  const agg = await prisma.tenantFinanceBalance.aggregate({
    where: { tenantId },
    _sum: { totalIncome: true, totalExpense: true, netBalance: true },
    _max: { updatedAt: true },
    _count: true,
  });
  if (!agg._count) return null;
  return {
    totalIncome: Number(agg._sum.totalIncome ?? 0),
    totalExpense: Number(agg._sum.totalExpense ?? 0),
    netBalance: Number(agg._sum.netBalance ?? 0),
    updatedAt: agg._max.updatedAt,
  };
}

export async function getNetBalance(tenantId: string): Promise<number> {
  const [incomeAgg, expenseAgg] = await Promise.all([
    prisma.transaction.aggregate({
      where: {
        tenantId,
        status: 'ACCEPTED',
        AND: [{ type: 'INCOME' }, { type: { not: 'INTERNAL' } }],
      },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: {
        tenantId,
        status: 'ACCEPTED',
        AND: [{ type: 'EXPENSE' }, { type: { not: 'INTERNAL' } }],
      },
      _sum: { amount: true },
    }),
  ]);
  return Number(incomeAgg._sum.amount ?? 0) - Number(expenseAgg._sum.amount ?? 0);
}

export async function checkSufficientFunds(tenantId: string, amount: number): Promise<void> {
  const netBalance = await getNetBalance(tenantId);
  if (netBalance < amount) {
    throw new InsufficientFundsError(netBalance, amount);
  }
}

export async function recordIncome(
  tenantId: string,
  amount: number,
  tx: PrismaWriteClient = prisma,
): Promise<void> {
  if (amount <= 0) return;

  await (tx as any).tenantFinanceBalance.upsert({
    where: balanceKey(tenantId),
    update: {
      totalIncome: { increment: amount },
      netBalance: { increment: amount },
    },
    create: {
      tenantId,
      branchId: activeBranchId(),
      totalIncome: amount,
      totalExpense: 0,
      netBalance: amount,
    },
  });
}

/**
 * Books an expense that has already happened, without asking whether the tenant
 * could afford it.
 *
 * Use this for recording facts — stock bought and received, for instance. The
 * money left the business before StockVero was told about it, so refusing to
 * write it down would just mean the ledger can never catch up with reality, and
 * a shop that stocks up before its first sale could never record anything.
 *
 * For money the system is *authorising* to be spent (project materials, purchase
 * invoices), use `recordExpense`, which refuses to overdraw.
 */
export async function applyExpense(
  tenantId: string,
  amount: number,
  tx: PrismaWriteClient = prisma,
): Promise<void> {
  if (amount <= 0) return;

  await (tx as any).tenantFinanceBalance.upsert({
    where: balanceKey(tenantId),
    update: {
      totalExpense: { increment: amount },
      netBalance: { decrement: amount },
    },
    create: {
      tenantId,
      branchId: activeBranchId(),
      totalIncome: 0,
      totalExpense: amount,
      netBalance: -amount,
    },
  });
}

export async function recordExpense(
  tenantId: string,
  amount: number,
  tx: PrismaWriteClient = prisma,
): Promise<void> {
  if (amount <= 0) return;

  const current = await (tx as any).tenantFinanceBalance.findUnique({
    where: balanceKey(tenantId),
  });
  const currentBalance = Number(current?.netBalance ?? 0);
  if (currentBalance < amount) {
    throw new InsufficientFundsError(currentBalance, amount);
  }

  await (tx as any).tenantFinanceBalance.update({
    where: balanceKey(tenantId),
    data: {
      totalExpense: { increment: amount },
      netBalance: { decrement: amount },
    },
  });
}

export async function reverseExpense(
  tenantId: string,
  amount: number,
  tx: PrismaWriteClient = prisma,
): Promise<void> {
  if (amount <= 0) return;

  await (tx as any).tenantFinanceBalance.update({
    where: balanceKey(tenantId),
    data: {
      totalExpense: { decrement: amount },
      netBalance: { increment: amount },
    },
  });
}

export async function reverseIncome(
  tenantId: string,
  amount: number,
  tx: PrismaWriteClient = prisma,
): Promise<void> {
  if (amount <= 0) return;

  await (tx as any).tenantFinanceBalance.update({
    where: balanceKey(tenantId),
    data: {
      totalIncome: { decrement: amount },
      netBalance: { decrement: amount },
    },
  });
}
