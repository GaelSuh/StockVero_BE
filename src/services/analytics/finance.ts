import { prisma } from '../../db.js';
import { AnalyticsFilters, Period, bucketOf, changePct, round2 } from './period.js';

/** Money in and out, from accepted finance transactions. Shown only to users who may see costs. */

const OTHER = 'Other';

async function totals(tenantId: string, p: Period) {
  const groups = await (prisma as any).transaction.groupBy({
    by: ['type'],
    where: { tenantId, status: 'ACCEPTED', type: { in: ['INCOME', 'EXPENSE'] }, recordedAt: { gte: p.start, lte: p.end } },
    _sum: { amount: true },
  });
  const sum = (type: string) => Number(groups.find((g: any) => g.type === type)?._sum.amount ?? 0);
  const income = sum('INCOME');
  const expense = sum('EXPENSE');
  return { income: round2(income), expense: round2(expense), net: round2(income - expense) };
}

export async function financeAnalytics(tenantId: string, f: AnalyticsFilters) {
  const [rows, previous] = await Promise.all([
    (prisma as any).transaction.findMany({
      where: { tenantId, status: 'ACCEPTED', type: { in: ['INCOME', 'EXPENSE'] }, recordedAt: { gte: f.start, lte: f.end } },
      select: { type: true, amount: true, category: true, recordedAt: true },
    }),
    f.compare ? totals(tenantId, f.previous) : Promise.resolve(null),
  ]);

  const series = new Map<string, { income: number; expense: number }>();
  const incomeBy = new Map<string, number>();
  const expenseBy = new Map<string, number>();
  let income = 0;
  let expense = 0;
  for (const t of rows) {
    const amount = Number(t.amount);
    const key = bucketOf(t.recordedAt, f.granularity);
    const s = series.get(key) ?? { income: 0, expense: 0 };
    const label = t.category?.trim() || OTHER;
    if (t.type === 'INCOME') {
      income += amount; s.income += amount;
      incomeBy.set(label, (incomeBy.get(label) ?? 0) + amount);
    } else {
      expense += amount; s.expense += amount;
      expenseBy.set(label, (expenseBy.get(label) ?? 0) + amount);
    }
    series.set(key, s);
  }

  const breakdown = (m: Map<string, number>, total: number) =>
    [...m.entries()]
      .map(([category, amount]) => ({ category, amount: round2(amount), sharePct: total > 0 ? round2((amount / total) * 100) : 0 }))
      .sort((a, b) => b.amount - a.amount);

  const kpis = {
    income: round2(income),
    expense: round2(expense),
    net: round2(income - expense),
    netMarginPct: income > 0 ? round2(((income - expense) / income) * 100) : null,
  };

  return {
    kpis,
    previous,
    change: previous
      ? { income: changePct(kpis.income, previous.income), expense: changePct(kpis.expense, previous.expense), net: changePct(kpis.net, previous.net) }
      : null,
    series: f.buckets.map((key) => {
      const s = series.get(key) ?? { income: 0, expense: 0 };
      return { key, income: round2(s.income), expense: round2(s.expense), net: round2(s.income - s.expense) };
    }),
    incomeByCategory: breakdown(incomeBy, income),
    expenseByCategory: breakdown(expenseBy, expense),
  };
}

/** Projects started in the range, plus the live count. Budgets only when costs are visible. */
export async function projectAnalytics(tenantId: string, f: AnalyticsFilters, canSeeCosts: boolean) {
  const [projects, active] = await Promise.all([
    (prisma as any).project.findMany({
      where: { tenantId, createdAt: { gte: f.start, lte: f.end } },
      select: { id: true, name: true, status: true, progress: true, budget: true, spent: true, customer: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    (prisma as any).project.count({ where: { tenantId, status: 'IN_PROGRESS' } }),
  ]);

  const statuses = new Map<string, number>();
  for (const p of projects) statuses.set(p.status, (statuses.get(p.status) ?? 0) + 1);

  return {
    kpis: { started: projects.length, active },
    statuses: [...statuses.entries()].map(([status, count]) => ({ status, count })),
    projects: projects.map((p: any) => ({
      id: p.id,
      name: p.name,
      customer: p.customer?.name ?? null,
      status: p.status,
      progress: Number(p.progress ?? 0),
      ...(canSeeCosts ? { budget: Number(p.budget ?? 0), spent: Number(p.spent ?? 0) } : {}),
    })),
  };
}
