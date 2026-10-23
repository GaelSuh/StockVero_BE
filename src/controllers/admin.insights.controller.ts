import { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AdminRequest } from '../types/index.js';
import { insightsConfig as cfg } from '../config/insights.config.js';
import { addDays, isDay } from '../services/tenantMetrics.service.js';
import {
  CSV_MAX_ROWS, CURRENCY, filterAndSort, loadInsights, resolveAsOf, summary, tenantDetail, toCsv, toRow,
} from '../services/insights/index.js';
import { dayDiff } from '../services/insights/score.js';

// TODO(admin-roles): list/detail/summary are read-only; allow the read-only analyst role too.
// TODO(admin-roles): restrict CSV export to roles allowed to take customer data out of the console.

const noData = (res: Response) =>
  res.status(200).json({ success: true, data: null, meta: { asOf: null, message: 'No snapshot data yet; the nightly metrics job has not run.' } });

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const FilterSchema = z.object({
  plan: z.enum(['STARTER', 'GROWTH', 'ENTERPRISE']).optional(),
  tier: z.enum(['KEY_ACCOUNT', 'GROWTH', 'STANDARD']).optional(),
  band: z.enum(['HEALTHY', 'NEEDS_ATTENTION', 'AT_RISK', 'ONBOARDING', 'INSUFFICIENT_DATA', 'SUSPENDED', 'INACTIVE']).optional(),
  module: z.string().min(1).max(40).optional(),
  moduleState: z.enum(['enabled', 'used']).default('enabled'),
  minDaysInactive: z.coerce.number().int().min(0).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE']).optional(),
  tenantType: z.enum(['CUSTOMER', 'INTERNAL', 'DEMO', 'TEST']).optional(),
  includeInternal: bool.default(false),
  /** 'me', 'none' (unassigned) or an admin id. */
  accountOwner: z.string().min(1).max(64).optional(),
  flag: z.enum(['DORMANT', 'DECLINING', 'PAST_DUE', 'TRIAL_ENDING', 'TRIAL_CONVERSION_OPPORTUNITY', 'HIGH_RETURNS', 'FEW_USERS_ACTIVE']).optional(),
  search: z.string().max(100).optional(),
  sort: z.enum(['value', 'health', 'lastActivity', 'trend']).default('value'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
const ListSchema = FilterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(cfg.api.maxLimit).default(cfg.api.defaultLimit),
});

/** Picking a non-customer tenant type implies including those tenants. */
const resolveFilters = <T extends z.infer<typeof FilterSchema>>(q: T, adminId: string): T => ({
  ...q,
  includeInternal: q.includeInternal || (q.tenantType !== undefined && q.tenantType !== 'CUSTOMER'),
  accountOwner: q.accountOwner === 'me' ? adminId : q.accountOwner,
});

/** GET /api/admin/v1/insights/tenants */
export const listInsights = async (req: AdminRequest, res: Response) => {
  const parsed = ListSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid query' });
  try {
    const asOf = await resolveAsOf();
    if (!asOf) return noData(res);
    const q = resolveFilters(parsed.data, req.admin!.id);
    const { total, rows } = filterAndSort(await loadInsights(asOf, { includeInternal: q.includeInternal }), q);
    return res.status(200).json({
      success: true,
      data: rows.map(toRow),
      meta: {
        asOf, currency: CURRENCY, total, page: q.page, limit: q.limit, totalPages: Math.max(1, Math.ceil(total / q.limit)),
        sort: q.sort, order: q.order, includeInternal: q.includeInternal,
      },
    });
  } catch (error: unknown) {
    console.error('listInsights error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load insights', error: (error as Error).message });
  }
};

/** GET /api/admin/v1/insights/tenants/export: CSV of the current filter, all pages (capped). */
export const exportInsights = async (req: AdminRequest, res: Response) => {
  const parsed = FilterSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid query' });
  try {
    const asOf = await resolveAsOf();
    if (!asOf) return res.status(409).json({ success: false, message: 'No snapshot data yet; nothing to export.' });
    const q = resolveFilters(parsed.data, req.admin!.id);
    const { total, all } = filterAndSort(await loadInsights(asOf, { includeInternal: q.includeInternal }), { ...q, page: 1, limit: CSV_MAX_ROWS });
    const rows = all.slice(0, CSV_MAX_ROWS);
    await prisma.adminActivityLog.create({
      data: {
        adminId: req.admin!.id,
        action: 'INSIGHTS_EXPORTED',
        details: { filters: parsed.data, rowCount: rows.length, totalMatched: total, truncated: total > rows.length, asOf },
      },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="stockvero-insights-${asOf}.csv"`);
    res.setHeader('X-Row-Count', String(rows.length));
    res.setHeader('X-Total-Matched', String(total));
    return res.status(200).send(toCsv(rows));
  } catch (error: unknown) {
    console.error('exportInsights error:', error);
    return res.status(500).json({ success: false, message: 'Export failed', error: (error as Error).message });
  }
};

/** GET /api/admin/v1/insights/tenants/:id?from=YYYY-MM-DD&to=YYYY-MM-DD */
export const getTenantInsight = async (req: AdminRequest, res: Response) => {
  try {
    const asOf = await resolveAsOf();
    if (!asOf) return noData(res);
    const to = typeof req.query.to === 'string' ? req.query.to : asOf;
    const from = typeof req.query.from === 'string' ? req.query.from : addDays(to, -(cfg.api.seriesDefaultDays - 1));
    if (!isDay(from) || !isDay(to) || from > to) {
      return res.status(400).json({ success: false, message: 'from and to must be YYYY-MM-DD with from <= to' });
    }
    if (dayDiff(from, to) + 1 > cfg.api.seriesMaxDays) {
      return res.status(400).json({ success: false, message: `At most ${cfg.api.seriesMaxDays} days of series per request` });
    }
    // Ranked among customers; an internal/demo/test tenant is still viewable by id (ranked among all).
    let [insight] = await loadInsights(asOf, { onlyIds: [req.params.id] });
    if (!insight) [insight] = await loadInsights(asOf, { onlyIds: [req.params.id], includeInternal: true });
    if (!insight) return res.status(404).json({ success: false, message: 'Tenant not found or not eligible (pending and denied tenants are excluded)' });
    return res.status(200).json({ success: true, data: await tenantDetail(insight, from, to), meta: { asOf, currency: CURRENCY } });
  } catch (error: unknown) {
    console.error('getTenantInsight error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load tenant insight', error: (error as Error).message });
  }
};

/** GET /api/admin/v1/insights/summary?includeInternal=true|false */
export const getInsightsSummary = async (req: AdminRequest, res: Response) => {
  const includeInternal = req.query.includeInternal === 'true';
  try {
    const asOf = await resolveAsOf();
    if (!asOf) return noData(res);
    return res.status(200).json({ success: true, data: summary(await loadInsights(asOf, { includeInternal })), meta: { asOf, currency: CURRENCY, includeInternal } });
  } catch (error: unknown) {
    console.error('getInsightsSummary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load insights summary', error: (error as Error).message });
  }
};
