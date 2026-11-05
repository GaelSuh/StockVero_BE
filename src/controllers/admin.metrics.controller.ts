import { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AdminRequest } from '../types/index.js';
import { logAuditAction } from '../services/audit.service.js';
import {
  METRICS_TZ,
  addDays,
  isDay,
  latestCompleteDay,
  runMetrics,
} from '../services/tenantMetrics.service.js';

const MAX_READ_DAYS = 366;
const MAX_REBUILD_DAYS = 400;
const dayString = z.string().refine(isDay, 'Expected a date as YYYY-MM-DD');

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

const toNumber = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * GET /api/admin/v1/tenants/:id/metrics/daily?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Newest first. Defaults to the 30 days ending with the latest complete Douala day.
 */
export const getTenantDailyMetrics = async (req: AdminRequest, res: Response) => {
  try {
    const latest = latestCompleteDay();
    const to = typeof req.query.to === 'string' ? req.query.to : latest;
    const from = typeof req.query.from === 'string' ? req.query.from : addDays(to, -29);
    if (!isDay(from) || !isDay(to) || from > to) {
      return res.status(400).json({ success: false, message: 'from and to must be YYYY-MM-DD with from <= to' });
    }
    if (daysBetween(from, to) > MAX_READ_DAYS) {
      return res.status(400).json({ success: false, message: `At most ${MAX_READ_DAYS} days per request` });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

    const [rows, lastRun] = await Promise.all([
      prisma.tenantDailyMetric.findMany({
        where: { tenantId: tenant.id, day: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
        orderBy: { day: 'desc' },
      }),
      prisma.metricsJobRun.findFirst({
        where: { kind: 'NIGHTLY', finishedAt: { not: null } },
        orderBy: { startedAt: 'desc' },
        select: { id: true, toDay: true, status: true, startedAt: true, finishedAt: true, tenantsProcessed: true, tenantsFailed: true },
      }),
    ]);

    return res.status(200).json({
      success: true,
      data: rows.map((r) => ({
        day: r.day.toISOString().slice(0, 10),
        salesCount: r.salesCount,
        salesValue: toNumber(r.salesValue),
        retailSalesCount: r.retailSalesCount,
        retailSalesValue: toNumber(r.retailSalesValue),
        wholesaleSalesCount: r.wholesaleSalesCount,
        wholesaleSalesValue: toNumber(r.wholesaleSalesValue),
        returnsCount: r.returnsCount,
        returnsValue: toNumber(r.returnsValue),
        activeUsers: r.activeUsers,
        userActions: r.userActions,
        productCount: r.productCount,
        variantCount: r.variantCount,
        serializedUnitsInStock: r.serializedUnitsInStock,
        quantityUnitsInStock: r.quantityUnitsInStock,
        stockValueAtCost: toNumber(r.stockValueAtCost),
        outOfStockCount: r.outOfStockCount,
        lowStockCount: r.lowStockCount,
        deadStockCount: r.deadStockCount,
        flowComputedAt: r.flowComputedAt,
        pointInTimeCapturedAt: r.pointInTimeCapturedAt,
      })),
      meta: {
        tenantId: tenant.id,
        from,
        to,
        count: rows.length,
        latestCompleteDay: latest,
        latestSnapshotDay: rows[0]?.day.toISOString().slice(0, 10) ?? null,
        timezone: METRICS_TZ,
        currency: 'XAF',
        lastNightlyRun: lastRun
          ? { ...lastRun, toDay: lastRun.toDay.toISOString().slice(0, 10) }
          : null,
      },
    });
  } catch (error: any) {
    console.error('getTenantDailyMetrics error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load metrics', error: error.message });
  }
};

const RebuildSchema = z
  .object({ from: dayString, to: dayString, tenantId: z.string().min(1).optional() })
  .refine((b) => b.from <= b.to, 'from must be on or before to')
  .refine((b) => daysBetween(b.from, b.to) <= MAX_REBUILD_DAYS, `At most ${MAX_REBUILD_DAYS} days per rebuild`)
  .refine((b) => b.to <= latestCompleteDay(), 'to cannot be later than the latest complete day');

/**
 * POST /api/admin/v1/metrics/rebuild  { from, to, tenantId? }
 * Recomputes flow metrics for the range (catalogue values already captured are kept).
 *
 * TODO(admin-roles): restrict to the owner admin role once admin roles exist. Today every
 * super admin passes adminGuard and can run this.
 */
export const rebuildMetrics = async (req: AdminRequest, res: Response) => {
  const parsed = RebuildSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
  }
  const { from, to, tenantId } = parsed.data;
  try {
    if (tenantId) {
      const exists = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
      if (!exists) return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    const adminId = req.admin!.id;
    const result = await runMetrics({ kind: 'REBUILD', from, to, tenantId, triggeredBy: `admin:${adminId}` });

    // TenantAuditLog is per tenant, so an all-tenant rebuild is recorded on each tenant it touched.
    await Promise.all(
      result.tenantIds.map((id) =>
        logAuditAction(adminId, id, 'METRICS_REBUILT', { from, to, runId: result.runId, scope: tenantId ? 'tenant' : 'all' }),
      ),
    );

    return res.status(result.status === 'FAILED' ? 500 : 200).json({ success: result.status !== 'FAILED', data: result });
  } catch (error: any) {
    console.error('rebuildMetrics error:', error);
    return res.status(500).json({ success: false, message: 'Rebuild failed', error: error.message });
  }
};
