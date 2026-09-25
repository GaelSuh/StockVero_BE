import { Router } from 'express';
import { tenantGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import {
  getTenantModules,
  updateTenantModule,
  updateMyTenant,
  updateMyTenantTheme,
  listIndustries,
} from '../controllers/tenants.controller.js';

const router = Router();

/**
 * The catalogue of business types. Deliberately registered *before* tenantGuard:
 * the signup screen needs it while there is no tenant and no token, and a
 * guarded route would reject the one caller that matters most. It exposes
 * nothing tenant-specific — just the list of options and their suggested
 * modules.
 */
router.get('/industries', listIndustries);

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
// Same gate as the rest of Settings: owners always, employees with the settings
// permission. The old roleGuard(['SUPER_ADMIN', 'CLIENT_OWNER']) refused every
// employee (their tokens carry no role) even though the Settings screen offers
// them the Modules tab, so saving answered 403.
router.get('/:id/modules', permissionGuard('settings', 'canRead'), getTenantModules);

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
router.patch('/:id/modules/:key', permissionGuard('settings', 'canUpdate'), updateTenantModule);

export default router;
