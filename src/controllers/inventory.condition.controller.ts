import { Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { auditRequest } from '../services/auditService.js';
import { STOCK_CONDITIONS, StockConditionError, moveStockCondition, type StockCondition } from '../services/stockConditionService.js';

const isCondition = (v: unknown): v is StockCondition => STOCK_CONDITIONS.includes(v as StockCondition);

/** Stock-history events that are about condition, shown under "Recent status changes". */
const CONDITION_EVENTS = [
  'RETURN_FAULTY', 'RETURN_DAMAGED', 'MARKED_FAULTY', 'MARKED_DAMAGED', 'CONDITION_RESTORED',
  'FAULTY', 'MAINTENANCE', 'RETURNED', 'STATUS_CHANGE', 'REMOVED',
];

/**
 * GET /inventory/categories/:id/condition
 *
 * Per-status counts for the product, or for each of its variants: quantity
 * products from their sellable / faulty / damaged counts, serialized products
 * from their units' statuses. Plus the latest condition changes.
 */
export async function getStockCondition(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const product = await (prisma as any).inventoryCategory.findFirst({
      where: { id: req.params.id, tenantId },
      select: {
        id: true, name: true, type: true, stockTrackingMode: true, quantityOnHand: true, quantityFaulty: true, quantityDamaged: true,
        variants: { select: { id: true, label: true, quantityOnHand: true, quantityFaulty: true, quantityDamaged: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const quantityTracked = product.stockTrackingMode === 'QUANTITY';
    let rows: Array<{ variantId: string | null; label: string; counts: Record<string, number> }>;

    if (quantityTracked) {
      const counts = (h: any) => ({ GOOD: h.quantityOnHand ?? 0, FAULTY: h.quantityFaulty ?? 0, DAMAGED: h.quantityDamaged ?? 0 });
      rows = product.variants.length
        ? product.variants.map((v: any) => ({ variantId: v.id, label: v.label, counts: counts(v) }))
        : [{ variantId: null, label: product.name, counts: counts(product) }];
    } else {
      // Assets (type INVENTORY) track inventoryStatus; goods for sale track stockStatus.
      const field = product.type === 'INVENTORY' ? 'inventoryStatus' : 'stockStatus';
      const groups = await (prisma as any).productItem.groupBy({
        by: ['variantId', field],
        where: { tenantId, categoryId: product.id },
        _count: { id: true },
      });
      const byVariant = new Map<string | null, Record<string, number>>();
      for (const g of groups) {
        const status = g[field];
        if (!status) continue;
        const c = byVariant.get(g.variantId ?? null) ?? {};
        c[status] = (c[status] ?? 0) + g._count.id;
        byVariant.set(g.variantId ?? null, c);
      }
      rows = product.variants.length
        ? product.variants.map((v: any) => ({ variantId: v.id, label: v.label, counts: byVariant.get(v.id) ?? {} }))
        : [];
      const unassigned = byVariant.get(null);
      if (!product.variants.length || unassigned) rows.push({ variantId: null, label: product.name, counts: unassigned ?? {} });
    }

    const logs = await (prisma as any).categoryStockLog.findMany({
      where: { tenantId, categoryId: product.id, eventType: { in: CONDITION_EVENTS } },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, eventType: true, title: true, createdAt: true, performedBy: true, variantId: true },
    });
    const people = [...new Set(logs.map((l: any) => l.performedBy).filter(Boolean))] as string[];
    const [owners, staff] = people.length
      ? await Promise.all([
          (prisma as any).user.findMany({ where: { id: { in: people } }, select: { id: true, firstName: true, lastName: true } }),
          (prisma as any).employee.findMany({ where: { id: { in: people }, tenantId }, select: { id: true, firstName: true, lastName: true } }),
        ])
      : [[], []];
    const nameOf = new Map<string, string>([...owners, ...staff].map((p: any) => [p.id, [p.firstName, p.lastName].filter(Boolean).join(' ')]));

    return res.json({
      success: true,
      data: {
        mode: quantityTracked ? 'QUANTITY' : 'SERIALIZED',
        rows,
        recent: logs.map((l: any) => ({
          id: l.id,
          eventType: l.eventType,
          title: l.title,
          at: l.createdAt,
          by: l.performedBy ? nameOf.get(l.performedBy) ?? null : null,
        })),
      },
    });
  } catch (error) {
    console.error('Error reading stock condition:', error);
    return res.status(500).json({ success: false, message: 'Failed to load stock status' });
  }
}

/**
 * POST /inventory/categories/:id/condition
 * { from, to, quantity, variantId?, reason? }
 *
 * Moves part of a quantity product's stock between sellable, faulty and
 * damaged: items found broken on the shelf, a repair, a write-off.
 */
export async function changeStockCondition(req: AuthRequest, res: Response) {
  const { from, to, quantity, variantId, reason } = req.body ?? {};
  if (!isCondition(from) || !isCondition(to)) {
    return res.status(400).json({ success: false, message: 'from and to must be GOOD, FAULTY or DAMAGED' });
  }
  try {
    const result = await prisma.$transaction((tx) =>
      moveStockCondition(tx, {
        tenantId: req.tenantId!,
        categoryId: req.params.id,
        variantId: variantId || null,
        from,
        to,
        quantity: Number(quantity),
        reason: typeof reason === 'string' ? reason.trim() || null : null,
        performedBy: req.user?.id ?? null,
      }),
    );

    auditRequest(req, {
      action: 'STOCK_CONDITION_CHANGED',
      module: 'inventory',
      entityType: 'InventoryCategory',
      entityId: result.product.id,
      entityLabel: result.variant?.label ? `${result.product.name} (${result.variant.label})` : result.product.name,
      details: {
        before: { condition: from },
        after: { condition: to },
        quantity: Number(quantity),
        reason: reason || null,
        sellableNow: Number(result.counts.quantityOnHand),
        faultyNow: Number(result.counts.quantityFaulty),
        damagedNow: Number(result.counts.quantityDamaged),
      },
    });

    return res.json({ success: true, data: result.counts });
  } catch (error) {
    if (error instanceof StockConditionError) return res.status(400).json({ success: false, message: error.message });
    console.error('Error changing stock condition:', error);
    return res.status(500).json({ success: false, message: 'Failed to change stock condition' });
  }
}
