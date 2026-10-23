import { Router } from 'express';
import { adminGuard } from '../../middleware/adminAuth.js';
import { exportInsights, getInsightsSummary, getTenantInsight, listInsights } from '../../controllers/admin.insights.controller.js';

const router = Router();

// TODO(admin-roles): read-only routes; extend access to the read-only analyst role when roles exist.

/**
 * @openapi
 * /api/admin/v1/insights/summary:
 *   get:
 *     summary: Platform insights for the dashboard (totals, bands, tiers, top/at-risk/dormant/trials)
 *     tags: [Admin Insights]
 */
router.get('/insights/summary', adminGuard, getInsightsSummary);

/**
 * @openapi
 * /api/admin/v1/insights/tenants:
 *   get:
 *     summary: Tenant insights list (filters plan, tier, band, module, minDaysInactive, status, search; sorts value, health, lastActivity, trend)
 *     tags: [Admin Insights]
 */
router.get('/insights/tenants', adminGuard, listInsights);

/**
 * @openapi
 * /api/admin/v1/insights/tenants/export:
 *   get:
 *     summary: CSV of the filtered insights list (all pages, max 5000 rows); logged to admin_activity_logs
 *     tags: [Admin Insights]
 */
router.get('/insights/tenants/export', adminGuard, exportInsights);

/**
 * @openapi
 * /api/admin/v1/insights/tenants/{id}:
 *   get:
 *     summary: One tenant's insight with factor breakdown, tier reasons, daily series, modules, users and milestones
 *     tags: [Admin Insights]
 */
router.get('/insights/tenants/:id', adminGuard, getTenantInsight);

export default router;
