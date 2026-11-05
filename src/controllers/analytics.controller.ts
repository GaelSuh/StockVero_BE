import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
import { auditRequest } from '../services/auditService.js';
import { AnalyticsFilters, FilterError, parseFilters } from '../services/analytics/period.js';
import { salesAnalytics } from '../services/analytics/sales.js';
import { stockAnalytics } from '../services/analytics/stock.js';
import { customerAnalytics } from '../services/analytics/customers.js';
import { financeAnalytics, projectAnalytics } from '../services/analytics/finance.js';

/**
 * Analytics for a tenant's own business. Every endpoint takes the same filters
 * (from, to, compare, advanced, channel, categoryId; see services/analytics/period.ts).
 *
 * Profit, cost, stock value at cost, purchases and the finance figures are only
 * returned to the owner and to employees holding create + read + update on the
 * analytics module; the same users may export the PDF report.
 */

const SALES_MODULES = ['retail_sales', 'wholesale_sales'];

export const canSeeCosts = (req: AuthRequest): boolean => {
  if (req.user?.accountType === 'owner') return true;
  const p = req.permissions?.analytics;
  return Boolean(p?.canRead && p?.canCreate && p?.canUpdate);
};

const sections = (req: AuthRequest) => {
  const active = new Set(req.activeModules ?? []);
  const sales = SALES_MODULES.some((m) => active.has(m));
  return {
    sales,
    stock: active.has('inventory'),
    customers: sales || active.has('crm'),
    finance: active.has('finance') && canSeeCosts(req),
    projects: active.has('projects'),
  };
};
type Section = keyof ReturnType<typeof sections>;

/** Runs one section's report with shared filter parsing, gating and error handling. */
const report =
  (section: Section, run: (tenantId: string, f: AnalyticsFilters, costs: boolean) => Promise<unknown>) =>
  async (req: AuthRequest, res: Response) => {
    if (!sections(req)[section]) {
      return res.status(403).json({ success: false, code: 'SECTION_UNAVAILABLE', message: 'This report is not available for your account' });
    }
    try {
      const filters = parseFilters(req.query as Record<string, unknown>);
      const costs = canSeeCosts(req);
      const data = await run(req.tenantId!, filters, costs);
      return res.json({
        success: true,
        data: {
          ...(data as object),
          filters: {
            from: filters.from, to: filters.to, days: filters.days, granularity: filters.granularity,
            previous: { from: filters.previous.from, to: filters.previous.to },
            compare: filters.compare, advanced: filters.advanced, channel: filters.channel, categoryId: filters.categoryId,
          },
          access: { canSeeCosts: costs },
        },
      });
    } catch (error) {
      if (error instanceof FilterError) return res.status(400).json({ success: false, message: error.message });
      console.error(`[analytics] ${section} failed:`, error);
      return res.status(500).json({ success: false, message: 'Failed to load analytics' });
    }
  };

/** Which sections this user can open, and whether they see costs (and may export). */
export const getAnalyticsAccess = (req: AuthRequest, res: Response) => {
  const active = new Set(req.activeModules ?? []);
  return res.json({
    success: true,
    data: {
      sections: sections(req),
      channels: { retail: active.has('retail_sales'), wholesale: active.has('wholesale_sales') },
      canSeeCosts: canSeeCosts(req),
      canExport: canSeeCosts(req),
    },
  });
};

const REPORT_TYPES = new Set(['summary', 'sales', 'stock', 'customers', 'full']);

/**
 * The PDF is built in the browser, so the server never sees it being made; the
 * export page reports each download here for the audit log.
 */
export const logReportDownload = (req: AuthRequest, res: Response) => {
  if (!canSeeCosts(req)) return res.status(403).json({ success: false, code: 'PERMISSION_DENIED' });
  const { type, from, to, advanced, channel, language } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof type !== 'string' || !REPORT_TYPES.has(type)) {
    return res.status(400).json({ success: false, message: 'Unknown report type' });
  }
  auditRequest(req, {
    action: 'ANALYTICS_REPORT_DOWNLOADED',
    module: 'analytics',
    entityType: 'AnalyticsReport',
    entityLabel: `${type} · ${String(from ?? '')} – ${String(to ?? '')}`,
    details: { type, from, to, advanced: Boolean(advanced), channel: channel ?? null, language: language ?? null },
  });
  return res.status(204).end();
};

export const getSalesAnalytics = report('sales', salesAnalytics);
export const getStockAnalytics = report('stock', stockAnalytics);
export const getCustomerAnalytics = report('customers', (tenantId, f) => customerAnalytics(tenantId, f));
export const getFinanceAnalytics = report('finance', (tenantId, f) => financeAnalytics(tenantId, f));
export const getProjectAnalytics = report('projects', projectAnalytics);
