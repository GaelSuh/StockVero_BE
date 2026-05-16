import { Router } from 'express';
import { adminGuard } from '../../middleware/adminAuth.js';
import { listTenants, createTenant, getTenant, updateTenant, approveTenant, denyTenant, updateTenantStatus, deleteTenant, getTenantModules, updateTenantModules, updateTenantOwner, resetTenantOwnerPassword, } from '../../controllers/admin.tenants.controller.js';
const router = Router();
/**
 * @openapi
 * /api/admin/v1/tenants:
 *   get:
 *     summary: List tenants
 *     tags: [Admin Tenants]
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: plan
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
 *         description: Tenant list
 */
router.get('/tenants', adminGuard, listTenants);
/**
 * @openapi
 * /api/admin/v1/tenants:
 *   post:
 *     summary: Create tenant
 *     tags: [Admin Tenants]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, slug, ownerFirstName, ownerLastName, ownerEmail, modules]
 *     responses:
 *       201:
 *         description: Tenant created
 */
router.post('/tenants', adminGuard, createTenant);
/**
 * @openapi
 * /api/admin/v1/tenants/{id}:
 *   get:
 *     summary: Get tenant detail
 *     tags: [Admin Tenants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tenant detail
 */
router.get('/tenants/:id', adminGuard, getTenant);
/**
 * @openapi
 * /api/admin/v1/tenants/{id}:
 *   patch:
 *     summary: Update tenant
 *     tags: [Admin Tenants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tenant updated
 */
router.patch('/tenants/:id', adminGuard, updateTenant);
/**
 * @openapi
 * /api/admin/v1/tenants/{id}/approve:
 *   patch:
 *     summary: Approve tenant
 *     tags: [Admin Tenants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tenant approved
 */
router.patch('/tenants/:id/approve', adminGuard, approveTenant);
/**
 * @openapi
 * /api/admin/v1/tenants/{id}/deny:
 *   patch:
 *     summary: Deny tenant
 *     tags: [Admin Tenants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *     responses:
 *       200:
 *         description: Tenant denied
 */
router.patch('/tenants/:id/deny', adminGuard, denyTenant);
/**
 * @openapi
 * /api/admin/v1/tenants/{id}/status:
 *   patch:
 *     summary: Update tenant status
 *     tags: [Admin Tenants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Status updated
 */
router.patch('/tenants/:id/status', adminGuard, updateTenantStatus);
/**
 * @openapi
 * /api/admin/v1/tenants/{id}:
 *   delete:
 *     summary: Delete tenant
 *     tags: [Admin Tenants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tenant deleted
 */
router.delete('/tenants/:id', adminGuard, deleteTenant);
/**
 * @openapi
 * /api/admin/v1/tenants/{id}/modules:
 *   get:
 *     summary: Get tenant modules
 *     tags: [Admin Tenants]
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
router.get('/tenants/:id/modules', adminGuard, getTenantModules);
/**
 * @openapi
 * /api/admin/v1/tenants/{id}/modules:
 *   patch:
 *     summary: Update tenant modules
 *     tags: [Admin Tenants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tenant modules updated
 */
router.patch('/tenants/:id/modules', adminGuard, updateTenantModules);
/**
 * @openapi
 * /api/admin/v1/tenants/{id}/owner:
 *   patch:
 *     summary: Update tenant owner
 *     tags: [Admin Tenants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Owner updated
 */
router.patch('/tenants/:id/owner', adminGuard, updateTenantOwner);
/**
 * @openapi
 * /api/admin/v1/tenants/{id}/owner/reset-password:
 *   patch:
 *     summary: Reset tenant owner password
 *     tags: [Admin Tenants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Owner password reset
 */
router.patch('/tenants/:id/owner/reset-password', adminGuard, resetTenantOwnerPassword);
export default router;
