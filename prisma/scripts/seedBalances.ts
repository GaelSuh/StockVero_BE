/**
 * seedBalances.ts
 *
 * One-time script: compute the correct finance balance for every branch of
 * every tenant based on existing ACCEPTED transactions (each branch keeps its
 * own cash box).
 *
 * Run via:
 *   npx tsx backend/prisma/scripts/seedBalances.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const branches = await prisma.branch.findMany({
    select: { id: true, name: true, tenantId: true, tenant: { select: { name: true } } },
  });
  console.log(`Found ${branches.length} branch(es). Computing balances...`);

  for (const branch of branches) {
    const scope = { tenantId: branch.tenantId, branchId: branch.id, status: 'ACCEPTED' as const };
    const [incomeAgg, expenseAgg] = await Promise.all([
      prisma.transaction.aggregate({
        where: { ...scope, AND: [{ type: 'INCOME' }, { type: { not: 'INTERNAL' } }] },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { ...scope, AND: [{ type: 'EXPENSE' }, { type: { not: 'INTERNAL' } }] },
        _sum: { amount: true },
      }),
    ]);

    const totalIncome = Number(incomeAgg._sum.amount ?? 0);
    const totalExpense = Number(expenseAgg._sum.amount ?? 0);
    const netBalance = totalIncome - totalExpense;

    await prisma.tenantFinanceBalance.upsert({
      where: { tenantId_branchId: { tenantId: branch.tenantId, branchId: branch.id } },
      update: { totalIncome, totalExpense, netBalance },
      create: { tenantId: branch.tenantId, branchId: branch.id, totalIncome, totalExpense, netBalance },
    });

    console.log(
      `  [${branch.tenant.name} / ${branch.name}] income=${totalIncome.toFixed(2)}, expense=${totalExpense.toFixed(2)}, net=${netBalance.toFixed(2)}`,
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
