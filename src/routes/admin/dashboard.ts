import { Router } from 'express';
import { getAdminDashboard } from '../../controllers/admin.dashboard.controller.js';
import { adminGuard } from '../../middleware/adminAuth.js';

const router = Router();

/**
 * @openapi
 * /api/admin/v1/dashboard:
 *   get:
 *     summary: Admin dashboard metrics
 *     tags: [Admin Dashboard]
 *     responses:
 *       200:
 *         description: Dashboard data
 */
router.get('/dashboard', adminGuard, getAdminDashboard);

export default router;
