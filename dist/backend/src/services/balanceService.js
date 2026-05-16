import { prisma } from '../db.js';
export class InsufficientFundsError extends Error {
    constructor(netBalance, required, shortfall = required - netBalance) {
        super(`Insufficient funds. Current net balance: ${netBalance.toFixed(2)} XAF. ` +
            `Required: ${required.toFixed(2)} XAF. Shortfall: ${shortfall.toFixed(2)} XAF.`);
        this.netBalance = netBalance;
        this.required = required;
        this.shortfall = shortfall;
        this.name = 'InsufficientFundsError';
    }
}
export async function getNetBalance(tenantId) {
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
export async function checkSufficientFunds(tenantId, amount) {
    const netBalance = await getNetBalance(tenantId);
    if (netBalance < amount) {
        throw new InsufficientFundsError(netBalance, amount);
    }
}
export async function recordIncome(tenantId, amount, tx = prisma) {
    if (amount <= 0)
        return;
    await tx.tenantFinanceBalance.upsert({
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
export async function recordExpense(tenantId, amount, tx = prisma) {
    if (amount <= 0)
        return;
    const current = await tx.tenantFinanceBalance.findUnique({
        where: { tenantId },
    });
    const currentBalance = Number(current?.netBalance ?? 0);
    if (currentBalance < amount) {
        throw new InsufficientFundsError(currentBalance, amount);
    }
    await tx.tenantFinanceBalance.update({
        where: { tenantId },
        data: {
            totalExpense: { increment: amount },
            netBalance: { decrement: amount },
        },
    });
}
export async function reverseExpense(tenantId, amount, tx = prisma) {
    if (amount <= 0)
        return;
    await tx.tenantFinanceBalance.update({
        where: { tenantId },
        data: {
            totalExpense: { decrement: amount },
            netBalance: { increment: amount },
        },
    });
}
export async function reverseIncome(tenantId, amount, tx = prisma) {
    if (amount <= 0)
        return;
    await tx.tenantFinanceBalance.update({
        where: { tenantId },
        data: {
            totalIncome: { decrement: amount },
            netBalance: { decrement: amount },
        },
    });
}
