import { Router } from 'express';
import { tenantGuard, moduleGuard, mustChangePasswordGuard } from '../middleware/auth.js';
import { listAuditLogs, getAuditSummary, getAuditActions } from '../controllers/audit.controller.js';
const router = Router();
router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('audit'));
router.get('/', listAuditLogs);
router.get('/summary', getAuditSummary);
router.get('/actions', getAuditActions);
export default router;
