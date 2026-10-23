import { Router } from 'express';
import adminAuthRoutes from './auth.js';
import adminDashboardRoutes from './dashboard.js';
import adminTenantsRoutes from './tenants.js';
import adminAnalyticsRoutes from './analytics.js';
import adminAuditRoutes from './audit.js';
import adminAdminsRoutes from './admins.js';
import adminMetricsRoutes from './metrics.js';
import adminInsightsRoutes from './insights.js';
import adminAccountsRoutes from './accounts.js';

const router = Router();

router.use(adminAuthRoutes);
router.use(adminDashboardRoutes);
router.use(adminAccountsRoutes);
router.use(adminTenantsRoutes);
router.use(adminAnalyticsRoutes);
router.use(adminAuditRoutes);
router.use(adminAdminsRoutes);
router.use(adminMetricsRoutes);
router.use(adminInsightsRoutes);

export default router;

