import { prisma } from '../../db.js';
import { getAvailableStock, isQuantityTracked } from '../../lib/stock.js';
import { addDays, doualaToday } from '../tenantMetrics.service.js';
import { AnalyticsFilters, bucketOf, dayStart, round2 } from './period.js';
import { COUNTED_SALE_STATUSES } from './sales.js';

/**
 * Stock analytics: what is on the shelf, what it is worth, what needs buying,
 * and what is not moving. "Stock" is products of type STOCK (goods for sale);
 * type INVENTORY (assets the business uses itself) is summarised separately.
 *
 * Position figures (on hand, value, reorder, dead stock) are as of now; the
 * date range drives movements, purchases, turnover and the history trend.
 */

const VELOCITY_DAYS = 30;
/** Reorder suggestions aim to cover this many days of sales. */
const COVER_DAYS = 30;
/** Same threshold as the nightly metrics' dead-stock count. */
const DEAD_DAYS = 60;
const RUNNING_OUT_DAYS = 7;
const UNCATEGORISED = 'Uncategorised';

const MOVEMENT_KIND: Record<string, 'added' | 'sold' | 'returned' | 'deployed' | 'damaged' | 'removed'> = {
  NEW_UNIT: 'added',
  STOCK_PURCHASE: 'added',
  OPENING_STOCK: 'added',
  BULK_IMPORT: 'added',
  SALE_DEDUCTION: 'sold',
  RETURN_RESTORATION: 'returned',
  RETURNED: 'returned',
  DEPLOYED: 'deployed',
  FAULTY: 'damaged',
  MARKED_FAULTY: 'damaged',
  MARKED_DAMAGED: 'damaged',
  MAINTENANCE: 'damaged',
  REMOVED: 'removed',
};
type MovementKind = (typeof MOVEMENT_KIND)[string];
const emptyMovements = (): Record<MovementKind, number> => ({ added: 0, sold: 0, returned: 0, deployed: 0, damaged: 0, removed: 0 });

/** Reorder quantity: enough for COVER_DAYS of sales plus the safety threshold. */
export function suggestedReorder(onHand: number, avgDaily: number, threshold: number): number {
  const target = Math.ceil(avgDaily * COVER_DAYS) + threshold;
  return Math.max(0, target - onHand);
}

export async function stockAnalytics(tenantId: string, f: AnalyticsFilters, canSeeCosts: boolean) {
  const productWhere: Record<string, unknown> = { tenantId, type: 'STOCK' };
  if (f.categoryId) productWhere.productCategoryId = f.categoryId;
  if (f.channel === 'RETAIL') productWhere.retailEnabled = true;
  if (f.channel === 'WHOLESALE') productWhere.wholesaleEnabled = true;

  const products = await (prisma as any).inventoryCategory.findMany({
    where: productWhere,
    select: {
      id: true, name: true, sku: true, unit: true, costPrice: true, sellingPrice: true, reorderThreshold: true,
      stockTrackingMode: true, quantityOnHand: true, quantityFaulty: true, quantityDamaged: true, type: true,
      productCategory: { select: { name: true } },
      variants: { select: { quantityOnHand: true, quantityFaulty: true, quantityDamaged: true } },
    },
  });
  const ids = products.map((p: any) => p.id);
  const velocitySince = dayStart(addDays(doualaToday(), -(VELOCITY_DAYS - 1)));
  const countedSale = { status: { in: COUNTED_SALE_STATUSES } };

  const [unitGroups, velocity, lastSold, logs, rangeLines, purchases, history, assets] = await Promise.all([
    ids.length
      ? (prisma as any).productItem.groupBy({ by: ['categoryId', 'stockStatus'], where: { tenantId, categoryId: { in: ids } }, _count: { id: true } })
      : [],
    ids.length
      ? (prisma as any).saleItem.groupBy({ by: ['categoryId'], where: { categoryId: { in: ids }, sale: { ...countedSale, createdAt: { gte: velocitySince } } }, _sum: { quantity: true } })
      : [],
    ids.length
      ? (prisma as any).saleItem.groupBy({ by: ['categoryId'], where: { categoryId: { in: ids }, sale: countedSale }, _max: { createdAt: true } })
      : [],
    ids.length
      ? (prisma as any).categoryStockLog.findMany({
          where: { tenantId, categoryId: { in: ids }, createdAt: { gte: f.start, lte: f.end } },
          select: { eventType: true, delta: true, createdAt: true },
        })
      : [],
    f.advanced && canSeeCosts && ids.length
      ? (prisma as any).saleItem.findMany({
          where: { categoryId: { in: ids }, sale: { ...countedSale, createdAt: { gte: f.start, lte: f.end } } },
          select: { categoryId: true, quantity: true, unitCost: true },
        })
      : [],
    canSeeCosts
      ? (prisma as any).transaction.findMany({
          where: { tenantId, type: 'EXPENSE', status: 'ACCEPTED', category: 'Stock Purchase', recordedAt: { gte: f.start, lte: f.end } },
          select: { amount: true, recordedAt: true },
        })
      : [],
    // The nightly snapshot is tenant-wide, so it only matches an unfiltered view.
    !f.categoryId && !f.channel
      ? (prisma as any).tenantDailyMetric.findMany({
          where: { tenantId, day: { gte: new Date(`${f.from}T00:00:00Z`), lte: new Date(`${f.to}T00:00:00Z`) } },
          select: { day: true, serializedUnitsInStock: true, quantityUnitsInStock: true, stockValueAtCost: true, lowStockCount: true, outOfStockCount: true, deadStockCount: true },
          orderBy: { day: 'asc' },
        })
      : [],
    assetSummary(tenantId),
  ]);

  const units = new Map<string, Record<string, number>>();
  for (const g of unitGroups) {
    const m = units.get(g.categoryId) ?? {};
    m[g.stockStatus ?? 'NONE'] = g._count.id;
    units.set(g.categoryId, m);
  }
  const soldLast30 = new Map<string, number>(velocity.map((v: any) => [v.categoryId, Number(v._sum.quantity ?? 0)]));
  const lastSoldAt = new Map<string, Date>(lastSold.map((v: any) => [v.categoryId, v._max.createdAt]));
  const now = Date.now();

  const kpis = { products: products.length, unitsInStock: 0, valueAtCost: 0, valueAtPrice: 0, lowStock: 0, outOfStock: 0, deadStockValue: 0, deadStockProducts: 0, faultyUnits: 0, damagedUnits: 0, setAsideValueAtCost: 0 };
  const serialized: Record<string, number> = {};
  const byCategory = new Map<string, { products: number; units: number; valueAtCost: number; valueAtPrice: number }>();

  const rows = products.map((p: any) => {
    const statusCounts = units.get(p.id) ?? {};
    const onHand = isQuantityTracked(p)
      ? Number(p.quantityOnHand ?? 0) + p.variants.reduce((s: number, v: any) => s + Number(v.quantityOnHand ?? 0), 0)
      : getAvailableStock(p, statusCounts.AVAILABLE ?? 0);
    if (!isQuantityTracked(p)) for (const [status, n] of Object.entries(statusCounts)) serialized[status] = (serialized[status] ?? 0) + n;

    const cost = Number(p.costPrice ?? 0);
    const price = Number(p.sellingPrice ?? 0);
    const threshold = Number(p.reorderThreshold ?? 0);
    const status = onHand <= 0 ? 'OUT_OF_STOCK' : onHand <= threshold ? 'LOW_STOCK' : 'IN_STOCK';
    const avgDaily = (soldLast30.get(p.id) ?? 0) / VELOCITY_DAYS;
    const last = lastSoldAt.get(p.id) ?? null;
    const daysSinceSale = last ? Math.floor((now - new Date(last).getTime()) / 86_400_000) : null;
    const isDead = onHand > 0 && (daysSinceSale === null || daysSinceSale >= DEAD_DAYS);

    // Set aside (not sellable): quantity counts, or serialized units by status.
    const sum = (field: string) => Number(p[field] ?? 0) + p.variants.reduce((n: number, v: any) => n + Number(v[field] ?? 0), 0);
    const faulty = isQuantityTracked(p) ? sum("quantityFaulty") : statusCounts.FAULTY ?? 0;
    const damaged = isQuantityTracked(p) ? sum("quantityDamaged") : statusCounts.COMPLETELY_BAD ?? 0;
    kpis.faultyUnits += faulty;
    kpis.damagedUnits += damaged;
    kpis.setAsideValueAtCost += (faulty + damaged) * Number(p.costPrice ?? 0);

    kpis.unitsInStock += Math.max(0, onHand);
    kpis.valueAtCost += Math.max(0, onHand) * cost;
    kpis.valueAtPrice += Math.max(0, onHand) * price;
    if (status === 'LOW_STOCK') kpis.lowStock += 1;
    if (status === 'OUT_OF_STOCK') kpis.outOfStock += 1;
    if (isDead) { kpis.deadStockProducts += 1; kpis.deadStockValue += onHand * (canSeeCosts ? cost : price); }

    const category = p.productCategory?.name ?? UNCATEGORISED;
    const c = byCategory.get(category) ?? { products: 0, units: 0, valueAtCost: 0, valueAtPrice: 0 };
    c.products += 1; c.units += Math.max(0, onHand); c.valueAtCost += Math.max(0, onHand) * cost; c.valueAtPrice += Math.max(0, onHand) * price;
    byCategory.set(category, c);

    return {
      categoryId: p.id, name: p.name, sku: p.sku, unit: p.unit, category, onHand, threshold, status,
      cost, price, avgDaily: round2(avgDaily),
      daysLeft: avgDaily > 0 ? Math.floor(onHand / avgDaily) : null,
      suggestedQty: suggestedReorder(onHand, avgDaily, threshold),
      lastSoldAt: last, daysSinceSale, isDead,
    };
  });

  const money = (row: Record<string, any>) => {
    if (canSeeCosts) return row;
    const { cost: _c, valueAtCost: _v, setAsideValueAtCost: _s, ...rest } = row;
    return rest;
  };

  // Basic: products at or under their threshold. Advanced adds the ones that
  // will run out soon at their current pace, with how much to buy.
  const reorder = rows
    .filter((r: any) => r.status !== 'IN_STOCK' || (f.advanced && r.daysLeft !== null && r.daysLeft <= RUNNING_OUT_DAYS))
    .sort((a: any, b: any) => a.onHand - b.onHand || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999))
    .map((r: any) => {
      const base = { categoryId: r.categoryId, name: r.name, sku: r.sku, unit: r.unit, category: r.category, onHand: r.onHand, threshold: r.threshold, status: r.status };
      return f.advanced ? { ...base, avgDaily: r.avgDaily, daysLeft: r.daysLeft, suggestedQty: r.suggestedQty, ...(canSeeCosts ? { suggestedCost: round2(r.suggestedQty * r.cost) } : {}) } : base;
    });

  const movementTotals = emptyMovements();
  const movementSeries = new Map<string, Record<MovementKind, number>>();
  for (const log of logs) {
    const kind = MOVEMENT_KIND[log.eventType];
    if (!kind) continue;
    const qty = Math.abs(Number(log.delta ?? 0));
    movementTotals[kind] += qty;
    const key = bucketOf(log.createdAt, f.granularity);
    const s = movementSeries.get(key) ?? emptyMovements();
    s[kind] += qty;
    movementSeries.set(key, s);
  }

  const purchaseSeries = new Map<string, number>();
  let purchaseTotal = 0;
  for (const t of purchases) {
    purchaseTotal += Number(t.amount);
    const key = bucketOf(t.recordedAt, f.granularity);
    purchaseSeries.set(key, (purchaseSeries.get(key) ?? 0) + Number(t.amount));
  }

  const result: Record<string, unknown> = {
    kpis: money({
      products: kpis.products,
      unitsInStock: kpis.unitsInStock,
      valueAtCost: round2(kpis.valueAtCost),
      valueAtPrice: round2(kpis.valueAtPrice),
      potentialProfit: round2(kpis.valueAtPrice - kpis.valueAtCost),
      faultyUnits: kpis.faultyUnits,
      damagedUnits: kpis.damagedUnits,
      setAsideValueAtCost: round2(kpis.setAsideValueAtCost),
      lowStock: kpis.lowStock,
      outOfStock: kpis.outOfStock,
    }),
    categories: [...byCategory.entries()]
      .map(([name, c]) => money({ name, products: c.products, units: c.units, valueAtCost: round2(c.valueAtCost), valueAtPrice: round2(c.valueAtPrice) }))
      .sort((a: any, b: any) => b.valueAtPrice - a.valueAtPrice),
    reorder,
    movements: {
      totals: movementTotals,
      series: f.buckets.map((key) => ({ key, ...(movementSeries.get(key) ?? emptyMovements()) })),
    },
    serializedUnits: serialized,
    purchases: canSeeCosts
      ? { total: round2(purchaseTotal), series: f.buckets.map((key) => ({ key, amount: round2(purchaseSeries.get(key) ?? 0) })) }
      : undefined,
    history: history.map((h: any) => ({
      day: new Date(h.day).toISOString().slice(0, 10),
      units: Number(h.serializedUnitsInStock ?? 0) + Number(h.quantityUnitsInStock ?? 0),
      ...(canSeeCosts ? { valueAtCost: Number(h.stockValueAtCost ?? 0) } : {}),
      lowStock: h.lowStockCount,
      outOfStock: h.outOfStockCount,
    })),
    assets,
  };
  if (!canSeeCosts) delete (result.kpis as any).potentialProfit;

  if (f.advanced) {
    const cogs = new Map<string, number>();
    for (const line of rangeLines) {
      const product = rows.find((r: any) => r.categoryId === line.categoryId);
      const category = product?.category ?? UNCATEGORISED;
      const unitCost = line.unitCost === null ? product?.cost ?? 0 : Number(line.unitCost);
      cogs.set(category, (cogs.get(category) ?? 0) + unitCost * line.quantity);
    }
    result.advanced = {
      deadStock: {
        products: kpis.deadStockProducts,
        value: round2(kpis.deadStockValue),
        valueBasis: canSeeCosts ? 'cost' : 'price',
        items: rows
          .filter((r: any) => r.isDead)
          .map((r: any) => ({
            categoryId: r.categoryId, name: r.name, category: r.category, onHand: r.onHand,
            lastSoldAt: r.lastSoldAt, daysSinceSale: r.daysSinceSale,
            value: round2(r.onHand * (canSeeCosts ? r.cost : r.price)),
          }))
          .sort((a: any, b: any) => b.value - a.value)
          .slice(0, 100),
      },
      // ponytail: today's stock value stands in for the period's average stock.
      turnover: canSeeCosts
        ? [...byCategory.entries()].map(([name, c]) => {
            const sold = cogs.get(name) ?? 0;
            const perDay = sold / f.days;
            return {
              name,
              cogs: round2(sold),
              valueAtCost: round2(c.valueAtCost),
              turnover: c.valueAtCost > 0 ? round2(sold / c.valueAtCost) : null,
              daysOfStock: perDay > 0 ? Math.round(c.valueAtCost / perDay) : null,
            };
          }).sort((a, b) => b.cogs - a.cogs)
        : undefined,
    };
  }

  return result;
}

/** Assets the business keeps for itself (type INVENTORY), by unit status. */
async function assetSummary(tenantId: string) {
  const [products, groups] = await Promise.all([
    (prisma as any).inventoryCategory.count({ where: { tenantId, type: 'INVENTORY' } }),
    (prisma as any).productItem.groupBy({
      by: ['inventoryStatus'],
      where: { tenantId, category: { type: 'INVENTORY' } },
      _count: { id: true },
    }),
  ]);
  return {
    products,
    units: Object.fromEntries(groups.filter((g: any) => g.inventoryStatus).map((g: any) => [g.inventoryStatus, g._count.id])),
  };
}
