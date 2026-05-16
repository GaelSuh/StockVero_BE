/**
 * seedBalances.ts
 *
 * One-time script: compute the correct TenantFinanceBalance for every tenant
 * based on existing ACCEPTED transactions.
 *
 * Run via:
 *   npx tsx backend/prisma/scripts/seedBalances.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  console.log(`Found ${tenants.length} tenant(s). Computing balances...`);

  for (const tenant of tenants) {
    const [incomeAgg, expenseAgg] = await Promise.all([
      prisma.transaction.aggregate({
        where: {
          tenantId: tenant.id,
          status: 'ACCEPTED',
          AND: [{ type: 'INCOME' }, { type: { not: 'INTERNAL' } }],
        },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: {
          tenantId: tenant.id,
          status: 'ACCEPTED',
          AND: [{ type: 'EXPENSE' }, { type: { not: 'INTERNAL' } }],
        },
        _sum: { amount: true },
      }),
    ]);

    const totalIncome = Number(incomeAgg._sum.amount ?? 0);
    const totalExpense = Number(expenseAgg._sum.amount ?? 0);
    const netBalance = totalIncome - totalExpense;

    await (prisma as any).tenantFinanceBalance.upsert({
      where: { tenantId: tenant.id },
      update: {
        totalIncome: totalIncome as any,
        totalExpense: totalExpense as any,
        netBalance: netBalance as any,
      },
      create: {
        tenantId: tenant.id,
        totalIncome: totalIncome as any,
        totalExpense: totalExpense as any,
        netBalance: netBalance as any,
      },
    });

    console.log(
      `  [${tenant.name}] income=${totalIncome.toFixed(2)}, expense=${totalExpense.toFixed(2)}, net=${netBalance.toFixed(2)}`,
    );
  }

  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
