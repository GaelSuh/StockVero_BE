import { Router } from 'express';
import { tenantGuard, roleGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import { getTenantModules, updateTenantModule, updateMyTenant, updateMyTenantTheme } from '../controllers/tenants.controller.js';

const router = Router();
router.use(tenantGuard, mustChangePasswordGuard);

/**
 * @openapi
 * /api/v1/tenants/{id}/modules:
 *   get:
 *     summary: List tenant modules
 *     tags: [Tenants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tenant modules
 */
router.patch('/me', permissionGuard('settings', 'canUpdate'), updateMyTenant);
router.patch('/me/theme', permissionGuard('settings', 'canUpdate'), updateMyTenantTheme);
router.get('/:id/modules', roleGuard(['SUPER_ADMIN', 'CLIENT_OWNER']), getTenantModules);

/**
 * @openapi
 * /api/v1/tenants/{id}/modules/{key}:
 *   patch:
 *     summary: Update tenant module access
 *     tags: [Tenants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isEnabled]
 *             properties:
 *               isEnabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Module updated
 */
router.patch('/:id/modules/:key', roleGuard(['SUPER_ADMIN', 'CLIENT_OWNER']), updateTenantModule);

export default router;
