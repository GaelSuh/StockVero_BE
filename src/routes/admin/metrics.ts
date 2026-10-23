import { Router } from 'express';
import { adminGuard } from '../../middleware/adminAuth.js';
import { getTenantDailyMetrics, rebuildMetrics } from '../../controllers/admin.metrics.controller.js';

const router = Router();

/**
 * @openapi
 * /api/admin/v1/tenants/{id}/metrics/daily:
 *   get:
 *     summary: Daily metrics snapshot rows for a tenant (newest first)
 *     tags: [Admin Metrics]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to, schema: { type: string, format: date } }
 *     responses:
 *       200:
 *         description: Rows plus meta.latestCompleteDay (Africa/Douala)
 */
router.get('/tenants/:id/metrics/daily', adminGuard, getTenantDailyMetrics);

/**
 * @openapi
 * /api/admin/v1/metrics/rebuild:
 *   post:
 *     summary: Recompute daily metrics (flow) for a date range, one tenant or all
 *     tags: [Admin Metrics]
 *     responses:
 *       200:
 *         description: Run summary
 */
router.post('/metrics/rebuild', adminGuard, rebuildMetrics);

export default router;
