import { Router } from 'express';
import { tenantGuard, mustChangePasswordGuard, moduleGuard, permissionGuard } from '../middleware/auth.js';
import {
  getAnalyticsAccess,
  getSalesAnalytics,
  getStockAnalytics,
  getCustomerAnalytics,
  getFinanceAnalytics,
  getProjectAnalytics,
  logReportDownload,
} from '../controllers/analytics.controller.js';

const router = Router();

router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('analytics'), permissionGuard('analytics', 'canRead'));

router.get('/access', getAnalyticsAccess);
router.get('/sales', getSalesAnalytics);
router.get('/stock', getStockAnalytics);
router.get('/customers', getCustomerAnalytics);
router.get('/finance', getFinanceAnalytics);
router.get('/projects', getProjectAnalytics);
router.post('/report-downloads', logReportDownload);

export default router;
