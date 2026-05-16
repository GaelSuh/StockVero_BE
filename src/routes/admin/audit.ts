import { Router } from 'express';
import { adminGuard } from '../../middleware/adminAuth.js';
import { getTenantAuditLog, getPlatformAuditLog } from '../../controllers/admin.audit.controller.js';

const router = Router();

/**
 * @openapi
 * /api/admin/v1/tenants/{id}/audit:
 *   get:
 *     summary: Tenant audit log
 *     tags: [Admin Audit]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Tenant audit log
 */
router.get('/tenants/:id/audit', adminGuard, getTenantAuditLog);

/**
 * @openapi
 * /api/admin/v1/audit:
 *   get:
 *     summary: Platform audit log
 *     tags: [Admin Audit]
 *     parameters:
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *       - in: query
 *         name: tenantId
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Platform audit log
 */
router.get('/audit', adminGuard, getPlatformAuditLog);

export default router;
