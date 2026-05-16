import { Router } from 'express';
import { tenantGuard, mustChangePasswordGuard, moduleGuard, permissionGuard } from '../middleware/auth.js';
import { getStats } from '../controllers/dashboard.controller.js';

const router = Router();
router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('dashboard'));

/**
 * @openapi
 * /api/v1/dashboard/stats:
 *   get:
 *     summary: Dashboard stats
 *     tags: [Dashboard]
 *     responses:
 *       200:
 *         description: Aggregated stats
 */
router.get('/stats', permissionGuard('dashboard', 'canRead'), getStats);

export default router;
