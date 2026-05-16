import { prisma } from '../db.js';

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
    where: { tenantId },
    update: {
      totalIncome: { increment: amount },
      netBalance: { increment: amount },
    },
    create: {
      tenantId,
      totalIncome: amount,
      totalExpense: 0,
      netBalance: amount,
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
    where: { tenantId },
  });
  const currentBalance = Number(current?.netBalance ?? 0);
  if (currentBalance < amount) {
    throw new InsufficientFundsError(currentBalance, amount);
  }

  await (tx as any).tenantFinanceBalance.update({
    where: { tenantId },
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
    where: { tenantId },
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
    where: { tenantId },
    data: {
      totalIncome: { decrement: amount },
      netBalance: { decrement: amount },
    },
  });
}
