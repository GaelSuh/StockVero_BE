import { prisma } from '../../db.js';
import { AnalyticsFilters, Period, bucketKeys, bucketOf, changePct, doualaDay, doualaDayHour, round2 } from './period.js';

/**
 * Sales analytics: retail and wholesale, from Sale / SaleItem / SaleReturn.
 *
 * Counted sales are COMPLETED, PARTIAL and RETURNED, as in the nightly metrics:
 * a sale refunded later still happened, and its refund is subtracted as a return
 * in the period the refund was made. Revenue is allocated to lines in proportion
 * to their share of the sale, so it still adds up to Sale.totalAmount when a
 * whole-sale discount was given and when results are filtered by category.
 *
 * Profit uses each line's unitCost (snapshotted at sale time or backfilled);
 * lines not backfilled yet fall back to the product's current cost price and
 * count towards `estimatedCostShare`.
 *
 * ponytail: aggregated in memory; move the heavy parts to SQL GROUP BY if a
 * tenant reaches ~100k sale lines in one range.
 */

export const COUNTED_SALE_STATUSES = ['COMPLETED', 'PARTIAL', 'RETURNED'] as const;
const UNCATEGORISED = 'Uncategorised';

export interface ProductInfo {
  id: string;
  name: string;
  costPrice: number;
  productCategoryId: string | null;
  categoryName: string;
}

export async function loadProducts(tenantId: string): Promise<Map<string, ProductInfo>> {
  const rows = await (prisma as any).inventoryCategory.findMany({
    where: { tenantId },
    select: { id: true, name: true, costPrice: true, productCategoryId: true, productCategory: { select: { name: true } } },
  });
  return new Map(
    rows.map((r: any) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        costPrice: Number(r.costPrice ?? 0),
        productCategoryId: r.productCategoryId,
        categoryName: r.productCategory?.name ?? UNCATEGORISED,
      },
    ]),
  );
}

interface LineAgg { quantity: number; revenue: number; cost: number }
const emptyAgg = (): LineAgg => ({ quantity: 0, revenue: 0, cost: 0 });

export interface SalesKpis {
  grossRevenue: number;
  returnsValue: number;
  returnsCount: number;
  netRevenue: number;
  orders: number;
  itemsSold: number;
  averageOrder: number;
  itemsPerOrder: number;
  discounts: number;
  discountedOrdersShare: number;
  creditGiven: number;
  grossProfit?: number;
  marginPct?: number | null;
}

/** Shares used for both the current and the previous period. */
async function loadPeriod(tenantId: string, p: Period, f: AnalyticsFilters) {
  const modeFilter = f.channel ? { mode: f.channel } : {};
  const [sales, returns] = await Promise.all([
    (prisma as any).sale.findMany({
      where: { tenantId, status: { in: COUNTED_SALE_STATUSES }, createdAt: { gte: p.start, lte: p.end }, ...modeFilter },
      select: {
        id: true, mode: true, createdAt: true, subtotal: true, discountAmount: true, totalAmount: true,
        amountOwed: true, customerId: true, customerName: true, soldById: true, soldByName: true, deliveryStatus: true,
        items: { select: { categoryId: true, productName: true, quantity: true, lineTotal: true, discountAmount: true, unitCost: true, costSource: true } },
        payments: { select: { method: true, amount: true } },
      },
    }),
    (prisma as any).saleReturn.findMany({
      where: { tenantId, createdAt: { gte: p.start, lte: p.end }, ...(f.channel ? { sale: { mode: f.channel } } : {}) },
      select: {
        reason: true, createdAt: true,
        items: { select: { categoryId: true, productName: true, quantity: true, unitPrice: true } },
        sale: { select: { items: { select: { categoryId: true, unitCost: true } } } },
      },
    }),
  ]);
  return { sales, returns };
}

function summarise(
  data: Awaited<ReturnType<typeof loadPeriod>>,
  products: Map<string, ProductInfo>,
  f: AnalyticsFilters,
  bucket: (at: Date) => string | null,
) {
  const inCategory = (categoryId: string) => !f.categoryId || products.get(categoryId)?.productCategoryId === f.categoryId;
  const lineCost = (item: { categoryId: string; unitCost: unknown }) =>
    item.unitCost === null || item.unitCost === undefined ? products.get(item.categoryId)?.costPrice ?? 0 : Number(item.unitCost);

  const k = { gross: 0, returns: 0, returnsCount: 0, returnsCost: 0, cost: 0, estimatedRevenue: 0, orders: 0, items: 0, discounts: 0, discounted: 0, credit: 0 };
  const series = new Map<string, { retail: number; wholesale: number; orders: number; cost: number; returns: number }>();
  const byChannel = { RETAIL: { revenue: 0, orders: 0, cost: 0 }, WHOLESALE: { revenue: 0, orders: 0, cost: 0 } };
  const byProduct = new Map<string, LineAgg & { name: string }>();
  const byCategory = new Map<string, LineAgg>();
  const byEmployee = new Map<string, { name: string; orders: number; revenue: number }>();
  const payments = new Map<string, { amount: number; count: number }>();
  const wholesaleCustomers = new Map<string, { customerId: string | null; name: string; orders: number; revenue: number }>();
  const delivery = new Map<string, number>();
  const heat = new Map<string, { dow: number; hour: number; orders: number; revenue: number }>();
  const daily = new Map<string, number>();

  for (const sale of data.sales) {
    const lines = sale.items.filter((i: any) => inCategory(i.categoryId));
    if (lines.length === 0) continue;

    const subtotal = Number(sale.subtotal);
    const factor = subtotal > 0 ? Number(sale.totalAmount) / subtotal : 0;
    let revenue = 0;
    let cost = 0;
    let quantity = 0;
    let lineDiscount = 0;

    for (const line of lines) {
      const r = Number(line.lineTotal) * factor;
      const c = lineCost(line) * line.quantity;
      revenue += r;
      cost += c;
      quantity += line.quantity;
      lineDiscount += Number(line.discountAmount ?? 0);
      if (line.costSource !== 'SALE' && line.costSource !== 'PURCHASE_HISTORY') k.estimatedRevenue += r;

      const product = products.get(line.categoryId);
      const p = byProduct.get(line.categoryId) ?? { ...emptyAgg(), name: product?.name ?? line.productName };
      p.quantity += line.quantity; p.revenue += r; p.cost += c;
      byProduct.set(line.categoryId, p);

      const catKey = product?.categoryName ?? UNCATEGORISED;
      const cat = byCategory.get(catKey) ?? emptyAgg();
      cat.quantity += line.quantity; cat.revenue += r; cat.cost += c;
      byCategory.set(catKey, cat);
    }

    const discount = lineDiscount + Number(sale.discountAmount ?? 0);
    k.gross += revenue; k.cost += cost; k.orders += 1; k.items += quantity; k.discounts += discount;
    if (discount > 0) k.discounted += 1;
    k.credit += Number(sale.amountOwed ?? 0);

    const ch = byChannel[sale.mode as 'RETAIL' | 'WHOLESALE'] ?? byChannel.RETAIL;
    ch.revenue += revenue; ch.orders += 1; ch.cost += cost;

    const key = bucket(sale.createdAt);
    if (key) {
      const s = series.get(key) ?? { retail: 0, wholesale: 0, orders: 0, cost: 0, returns: 0 };
      if (sale.mode === 'WHOLESALE') s.wholesale += revenue; else s.retail += revenue;
      s.orders += 1; s.cost += cost;
      series.set(key, s);
    }
    const day = doualaDay(sale.createdAt);
    daily.set(day, (daily.get(day) ?? 0) + revenue);

    const emp = byEmployee.get(sale.soldById) ?? { name: sale.soldByName, orders: 0, revenue: 0 };
    emp.orders += 1; emp.revenue += revenue;
    byEmployee.set(sale.soldById, emp);

    for (const pay of sale.payments) {
      const entry = payments.get(pay.method) ?? { amount: 0, count: 0 };
      entry.amount += Number(pay.amount); entry.count += 1;
      payments.set(pay.method, entry);
    }
    if (Number(sale.amountOwed) > 0) {
      const entry = payments.get('CREDIT') ?? { amount: 0, count: 0 };
      entry.amount += Number(sale.amountOwed); entry.count += 1;
      payments.set('CREDIT', entry);
    }

    if (sale.mode === 'WHOLESALE') {
      const custKey = sale.customerId ?? `name:${sale.customerName ?? ''}`;
      const c = wholesaleCustomers.get(custKey) ?? { customerId: sale.customerId, name: sale.customerName ?? '—', orders: 0, revenue: 0 };
      c.orders += 1; c.revenue += revenue;
      wholesaleCustomers.set(custKey, c);
      if (sale.deliveryStatus) delivery.set(sale.deliveryStatus, (delivery.get(sale.deliveryStatus) ?? 0) + 1);
    }

    const { dow, hour } = doualaDayHour(sale.createdAt);
    const h = heat.get(`${dow}-${hour}`) ?? { dow, hour, orders: 0, revenue: 0 };
    h.orders += 1; h.revenue += revenue;
    heat.set(`${dow}-${hour}`, h);
  }

  const reasons = new Map<string, number>();
  const returnedProducts = new Map<string, { name: string; quantity: number; value: number }>();
  for (const ret of data.returns) {
    const lines = ret.items.filter((i: any) => inCategory(i.categoryId));
    if (lines.length === 0) continue;
    k.returnsCount += 1;
    // Stored as "CODE" or "CODE: note"; group on the code (see FE lib/returnReasons.ts).
    const reasonCode = (ret.reason ?? '').split(':')[0].trim() || 'OTHER';
    reasons.set(reasonCode, (reasons.get(reasonCode) ?? 0) + 1);
    for (const line of lines) {
      const value = Number(line.unitPrice) * line.quantity;
      const original = ret.sale.items.find((i: any) => i.categoryId === line.categoryId);
      k.returns += value;
      k.returnsCost += (original ? lineCost(original) : products.get(line.categoryId)?.costPrice ?? 0) * line.quantity;
      const rp = returnedProducts.get(line.categoryId) ?? { name: line.productName, quantity: 0, value: 0 };
      rp.quantity += line.quantity; rp.value += value;
      returnedProducts.set(line.categoryId, rp);
      const key = bucket(ret.createdAt);
      if (key) {
        const s = series.get(key) ?? { retail: 0, wholesale: 0, orders: 0, cost: 0, returns: 0 };
        s.returns += value;
        series.set(key, s);
      }
    }
  }

  const netRevenue = k.gross - k.returns;
  const grossProfit = netRevenue - (k.cost - k.returnsCost);
  const kpis: Required<SalesKpis> = {
    grossRevenue: round2(k.gross),
    returnsValue: round2(k.returns),
    returnsCount: k.returnsCount,
    netRevenue: round2(netRevenue),
    orders: k.orders,
    itemsSold: k.items,
    averageOrder: k.orders ? round2(k.gross / k.orders) : 0,
    itemsPerOrder: k.orders ? round2(k.items / k.orders) : 0,
    discounts: round2(k.discounts),
    discountedOrdersShare: k.orders ? round2((k.discounted / k.orders) * 100) : 0,
    creditGiven: round2(k.credit),
    grossProfit: round2(grossProfit),
    marginPct: netRevenue > 0 ? round2((grossProfit / netRevenue) * 100) : null,
  };

  return {
    kpis, series, byChannel, byProduct, byCategory, byEmployee, payments, wholesaleCustomers, delivery, heat, daily,
    reasons, returnedProducts,
    estimatedCostShare: k.gross > 0 ? round2((k.estimatedRevenue / k.gross) * 100) : 0,
  };
}

/** A (top ~80% of revenue), B (next 15%), C (the rest). */
export function abcClasses<T extends { revenue: number }>(rows: T[]) {
  const total = rows.reduce((s, r) => s + r.revenue, 0);
  let running = 0;
  return [...rows]
    .sort((a, b) => b.revenue - a.revenue)
    .map((row) => {
      const before = total > 0 ? running / total : 0;
      running += row.revenue;
      const cls = before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';
      return { ...row, sharePct: total > 0 ? round2((row.revenue / total) * 100) : 0, cumulativePct: total > 0 ? round2((running / total) * 100) : 0, class: cls };
    });
}

/**
 * Next-30-days estimate: the recent daily average, nudged by the trend between
 * the two halves of the range.
 * ponytail: a straight-line trend, not seasonal; fine for "roughly what's coming".
 */
export function forecast(daily: Map<string, number>, days: string[]) {
  const values = days.map((d) => daily.get(d) ?? 0);
  if (values.length < 14) return null;
  const half = Math.floor(values.length / 2);
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
  const first = avg(values.slice(0, half));
  const second = avg(values.slice(half));
  const recent = avg(values.slice(-14));
  const trendPct = changePct(second, first);
  return { dailyAverage: round2(recent), next30Days: round2(recent * 30), trendPct };
}

const dropCosts = <T extends Record<string, unknown>>(row: T, canSeeCosts: boolean, keys: string[]) => {
  if (canSeeCosts) return row;
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
};

export async function salesAnalytics(tenantId: string, f: AnalyticsFilters, canSeeCosts: boolean) {
  const products = await loadProducts(tenantId);
  const [current, previous] = await Promise.all([
    loadPeriod(tenantId, f, f),
    f.compare ? loadPeriod(tenantId, f.previous, f) : Promise.resolve(null),
  ]);
  const s = summarise(current, products, f, (at) => bucketOf(at, f.granularity));
  const prev = previous ? summarise(previous, products, f, () => null).kpis : null;

  const costKeys = ['cost', 'profit', 'marginPct'];
  const withProfit = (a: LineAgg) => ({
    quantity: a.quantity,
    revenue: round2(a.revenue),
    cost: round2(a.cost),
    profit: round2(a.revenue - a.cost),
    marginPct: a.revenue > 0 ? round2(((a.revenue - a.cost) / a.revenue) * 100) : null,
  });
  const strip = (kpis: Required<SalesKpis>) => {
    if (canSeeCosts) return kpis;
    const { grossProfit: _gp, marginPct: _m, ...rest } = kpis;
    return rest;
  };

  const productRows = [...s.byProduct.entries()]
    .map(([categoryId, p]) => ({ categoryId, name: p.name, ...withProfit(p) }))
    .sort((a, b) => b.revenue - a.revenue);

  const change = prev
    ? Object.fromEntries(
        Object.entries(strip(s.kpis)).map(([key, value]) => [key, changePct(Number(value ?? 0), Number((prev as any)[key] ?? 0))]),
      )
    : null;

  const result: Record<string, unknown> = {
    kpis: strip(s.kpis),
    previous: prev ? strip(prev) : null,
    change,
    estimatedCostShare: canSeeCosts ? s.estimatedCostShare : undefined,
    series: f.buckets.map((key) => {
      const b = s.series.get(key) ?? { retail: 0, wholesale: 0, orders: 0, cost: 0, returns: 0 };
      const revenue = b.retail + b.wholesale;
      return dropCosts(
        { key, retail: round2(b.retail), wholesale: round2(b.wholesale), revenue: round2(revenue), returns: round2(b.returns), orders: b.orders, profit: round2(revenue - b.returns - b.cost) },
        canSeeCosts,
        ['profit'],
      );
    }),
    channels: (['RETAIL', 'WHOLESALE'] as const).map((mode) => {
      const c = s.byChannel[mode];
      return dropCosts({ mode, revenue: round2(c.revenue), orders: c.orders, profit: round2(c.revenue - c.cost) }, canSeeCosts, ['profit']);
    }),
    paymentMix: [...s.payments.entries()]
      .map(([method, p]) => ({ method, amount: round2(p.amount), count: p.count }))
      .sort((a, b) => b.amount - a.amount),
    // Capped: the screen shows the top and bottom of the list, the PDF the top.
    products: productRows.slice(0, 200).map((r) => dropCosts(r, canSeeCosts, costKeys)),
    productCount: productRows.length,
    categories: [...s.byCategory.entries()]
      .map(([name, c]) => dropCosts({ name, ...withProfit(c) }, canSeeCosts, costKeys))
      .sort((a: any, b: any) => b.revenue - a.revenue),
    returns: {
      count: s.kpis.returnsCount,
      value: s.kpis.returnsValue,
      ratePct: s.kpis.grossRevenue > 0 ? round2((s.kpis.returnsValue / s.kpis.grossRevenue) * 100) : 0,
      reasons: [...s.reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8),
      products: [...s.returnedProducts.values()].map((r) => ({ ...r, value: round2(r.value) })).sort((a, b) => b.quantity - a.quantity).slice(0, 10),
    },
    wholesale: {
      topCustomers: [...s.wholesaleCustomers.values()]
        .map((c) => ({ ...c, revenue: round2(c.revenue) }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10),
      delivery: [...s.delivery.entries()].map(([status, count]) => ({ status, count })),
    },
  };

  if (f.advanced) {
    const days = bucketKeys(f.from, f.to, 'day');
    result.advanced = {
      abc: abcClasses(productRows.map((r) => ({ categoryId: r.categoryId, name: r.name, revenue: r.revenue, quantity: r.quantity }))),
      heatmap: [...s.heat.values()].map((h) => ({ ...h, revenue: round2(h.revenue) })),
      employees: [...s.byEmployee.values()]
        .map((e) => ({ ...e, revenue: round2(e.revenue), averageOrder: e.orders ? round2(e.revenue / e.orders) : 0 }))
        .sort((a, b) => b.revenue - a.revenue),
      forecast: forecast(s.daily, days),
    };
  }

  return result;
}
