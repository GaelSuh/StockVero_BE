import { Router } from 'express';
import { adminGuard } from '../../middleware/adminAuth.js';
import {
  getGrowthAnalytics,
  getModuleAnalytics,
  getPlanAnalytics,
  getActivityAnalytics,
} from '../../controllers/admin.analytics.controller.js';

const router = Router();

/**
 * @openapi
 * /api/admin/v1/analytics/growth:
 *   get:
 *     summary: Tenant growth analytics
 *     tags: [Admin Analytics]
 *     responses:
 *       200:
 *         description: Growth analytics
 */
router.get('/analytics/growth', adminGuard, getGrowthAnalytics);

/**
 * @openapi
 * /api/admin/v1/analytics/modules:
 *   get:
 *     summary: Module adoption analytics
 *     tags: [Admin Analytics]
 *     responses:
 *       200:
 *         description: Module analytics
 */
router.get('/analytics/modules', adminGuard, getModuleAnalytics);

/**
 * @openapi
 * /api/admin/v1/analytics/plans:
 *   get:
 *     summary: Plan distribution analytics
 *     tags: [Admin Analytics]
 *     responses:
 *       200:
 *         description: Plan analytics
 */
router.get('/analytics/plans', adminGuard, getPlanAnalytics);

/**
 * @openapi
 * /api/admin/v1/analytics/activity:
 *   get:
 *     summary: Platform activity for last 30 days
 *     tags: [Admin Analytics]
 *     responses:
 *       200:
 *         description: Activity analytics
 */
router.get('/analytics/activity', adminGuard, getActivityAnalytics);

export default router;
