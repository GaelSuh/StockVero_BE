import { prisma } from '../../db.js';
import { doualaToday } from '../tenantMetrics.service.js';
import { AnalyticsFilters, bucketOf, changePct, daysBetween, doualaDay, round2 } from './period.js';
import { COUNTED_SALE_STATUSES } from './sales.js';

/**
 * Customers and money owed. Buyers are identified by their customer record, or
 * by the name typed on the sale when there is none (walk-in sales with no name
 * are not a customer and are left out).
 *
 * Money owed is the current position, not limited to the date range: it is
 * what customers owe today, aged by the sale's credit due date (or the sale
 * date when no due date was set).
 */

/** No purchase for this long, after buying at least once: a lapsed customer. */
const LAPSED_DAYS = 60;

export type AgeingBucket = 'notDue' | 'd1_30' | 'd31_60' | 'd61_plus';

export function ageingBucket(daysOverdue: number): AgeingBucket {
  if (daysOverdue <= 0) return 'notDue';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  return 'd61_plus';
}

/** The till's placeholder name, sometimes saved as if it were a customer. */
const WALK_IN = new Set(['walk-in customer', 'client de passage']);

const buyerKey = (s: { customerId: string | null; customerName: string | null }) => {
  if (s.customerId) return s.customerId;
  const name = s.customerName?.trim().toLowerCase();
  return name && !WALK_IN.has(name) ? `name:${name}` : null;
};

export async function customerAnalytics(tenantId: string, f: AnalyticsFilters) {
  const mode = f.channel ? { mode: f.channel } : {};
  const today = doualaToday();

  const [totalCustomers, newInRange, newInPrevious, rangeSales, earlierBuyers, debts, allBuyers] = await Promise.all([
    (prisma as any).customer.count({ where: { tenantId } }),
    (prisma as any).customer.findMany({ where: { tenantId, createdAt: { gte: f.start, lte: f.end } }, select: { createdAt: true } }),
    f.compare ? (prisma as any).customer.count({ where: { tenantId, createdAt: { gte: f.previous.start, lte: f.previous.end } } }) : null,
    (prisma as any).sale.findMany({
      where: { tenantId, status: { in: COUNTED_SALE_STATUSES }, createdAt: { gte: f.start, lte: f.end }, ...mode },
      select: { customerId: true, customerName: true, totalAmount: true, createdAt: true, customer: { select: { phone: true } } },
    }),
    (prisma as any).sale.findMany({
      where: { tenantId, status: { in: COUNTED_SALE_STATUSES }, createdAt: { lt: f.start }, ...mode },
      select: { customerId: true, customerName: true },
      distinct: ['customerId', 'customerName'],
    }),
    (prisma as any).sale.findMany({
      where: { tenantId, paymentStatus: { in: ['CREDIT', 'PARTIAL'] }, amountOwed: { gt: 0 }, ...mode },
      select: { customerId: true, customerName: true, amountOwed: true, creditDueDate: true, createdAt: true, customer: { select: { phone: true } } },
    }),
    f.advanced
      ? (prisma as any).sale.groupBy({
          by: ['customerId'],
          where: { tenantId, status: { in: COUNTED_SALE_STATUSES }, customerId: { not: null }, createdAt: { lte: f.end }, ...mode },
          _max: { createdAt: true },
          _sum: { totalAmount: true },
          _count: { id: true },
        })
      : [],
  ]);

  // ── Buyers in range ─────────────────────────────────────────────────────────
  const before = new Set(earlierBuyers.map(buyerKey).filter(Boolean));
  const buyers = new Map<string, { customerId: string | null; name: string; phone: string | null; orders: number; revenue: number; lastPurchase: Date }>();
  for (const s of rangeSales) {
    const key = buyerKey(s);
    if (!key) continue;
    const b = buyers.get(key) ?? { customerId: s.customerId, name: s.customerName ?? '—', phone: s.customer?.phone ?? null, orders: 0, revenue: 0, lastPurchase: s.createdAt };
    b.orders += 1;
    b.revenue += Number(s.totalAmount);
    if (s.createdAt > b.lastPurchase) b.lastPurchase = s.createdAt;
    buyers.set(key, b);
  }
  const returning = [...buyers.keys()].filter((k) => before.has(k)).length;
  const repeatInRange = [...buyers.values()].filter((b) => b.orders > 1).length;

  const newSeries = new Map<string, number>();
  for (const c of newInRange) {
    const key = bucketOf(c.createdAt, f.granularity);
    newSeries.set(key, (newSeries.get(key) ?? 0) + 1);
  }

  // ── Money owed ──────────────────────────────────────────────────────────────
  const ageing: Record<AgeingBucket, { amount: number; count: number }> = {
    notDue: { amount: 0, count: 0 }, d1_30: { amount: 0, count: 0 }, d31_60: { amount: 0, count: 0 }, d61_plus: { amount: 0, count: 0 },
  };
  const debtors = new Map<string, { customerId: string | null; name: string; phone: string | null; owed: number; sales: number; oldestDue: string; daysOverdue: number }>();
  for (const d of debts) {
    const owed = Number(d.amountOwed);
    const due = doualaDay(d.creditDueDate ?? d.createdAt);
    const overdue = due < today ? daysBetween(due, today) - 1 : 0;
    const bucket = ageingBucket(overdue);
    ageing[bucket].amount += owed;
    ageing[bucket].count += 1;

    const key = buyerKey(d) ?? 'unknown';
    const e = debtors.get(key) ?? { customerId: d.customerId, name: d.customerName ?? '—', phone: d.customer?.phone ?? null, owed: 0, sales: 0, oldestDue: due, daysOverdue: 0 };
    e.owed += owed;
    e.sales += 1;
    if (due < e.oldestDue) e.oldestDue = due;
    e.daysOverdue = Math.max(e.daysOverdue, overdue);
    debtors.set(key, e);
  }
  const owedTotal = debts.reduce((s: number, d: any) => s + Number(d.amountOwed), 0);
  const overdueTotal = ageing.d1_30.amount + ageing.d31_60.amount + ageing.d61_plus.amount;

  const kpis = {
    totalCustomers,
    newCustomers: newInRange.length,
    buyers: buyers.size,
    returningBuyers: returning,
    owedTotal: round2(owedTotal),
    overdueTotal: round2(overdueTotal),
    debtors: debtors.size,
  };

  const result: Record<string, unknown> = {
    kpis,
    change: newInPrevious === null ? null : { newCustomers: changePct(newInRange.length, newInPrevious) },
    newCustomersSeries: f.buckets.map((key) => ({ key, count: newSeries.get(key) ?? 0 })),
    topCustomers: [...buyers.values()]
      .map((b) => ({ ...b, revenue: round2(b.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 15),
    ageing: (Object.keys(ageing) as AgeingBucket[]).map((bucket) => ({ bucket, amount: round2(ageing[bucket].amount), count: ageing[bucket].count })),
    debtors: [...debtors.values()]
      .map((d) => ({ ...d, owed: round2(d.owed) }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue || b.owed - a.owed)
      .slice(0, 100),
  };

  if (f.advanced) {
    const lapsedBefore = Date.parse(f.end.toISOString()) - LAPSED_DAYS * 86_400_000;
    const lapsedRows = allBuyers.filter((g: any) => g._max.createdAt && new Date(g._max.createdAt).getTime() < lapsedBefore);
    const names = lapsedRows.length
      ? await (prisma as any).customer.findMany({ where: { tenantId, id: { in: lapsedRows.map((g: any) => g.customerId) } }, select: { id: true, name: true, phone: true } })
      : [];
    const byId = new Map(names.map((c: any) => [c.id, c]));
    result.advanced = {
      repeatRatePct: buyers.size ? round2((repeatInRange / buyers.size) * 100) : 0,
      returningRatePct: buyers.size ? round2((returning / buyers.size) * 100) : 0,
      lapsed: lapsedRows
        .map((g: any) => {
          const c: any = byId.get(g.customerId);
          return {
            customerId: g.customerId,
            name: c?.name ?? '—',
            phone: c?.phone ?? null,
            lastPurchase: g._max.createdAt,
            daysSince: Math.floor((Date.parse(f.end.toISOString()) - new Date(g._max.createdAt).getTime()) / 86_400_000),
            lifetimeRevenue: round2(Number(g._sum.totalAmount ?? 0)),
            orders: g._count.id,
          };
        })
        .sort((a: any, b: any) => b.lifetimeRevenue - a.lifetimeRevenue)
        .slice(0, 30),
    };
  }

  return result;
}
