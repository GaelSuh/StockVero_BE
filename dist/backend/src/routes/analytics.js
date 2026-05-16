import { Router } from 'express';
import { tenantGuard, mustChangePasswordGuard, moduleGuard } from '../middleware/auth.js';
import { getAnalyticsOverview, exportAnalyticsPdf } from '../controllers/analytics.controller.js';
const router = Router();
router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('analytics'));
router.get('/', getAnalyticsOverview);
router.get('/export', exportAnalyticsPdf);
export default router;
