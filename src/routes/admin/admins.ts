import { Router } from 'express';
import { adminGuard } from '../../middleware/adminAuth.js';
import {
  listSuperAdmins,
  createSuperAdmin,
  changeSuperAdminPassword,
} from '../../controllers/admin.admins.controller.js';

const router = Router();

/**
 * @openapi
 * /api/admin/v1/admins:
 *   get:
 *     summary: List super admins
 *     tags: [Admin Management]
 *     responses:
 *       200:
 *         description: Admin list
 */
router.get('/admins', adminGuard, listSuperAdmins);

/**
 * @openapi
 * /api/admin/v1/admins:
 *   post:
 *     summary: Create super admin
 *     tags: [Admin Management]
 *     requestBody:
 *       required: true
 *     responses:
 *       201:
 *         description: Admin created
 */
router.post('/admins', adminGuard, createSuperAdmin);

/**
 * @openapi
 * /api/admin/v1/admins/{id}/password:
 *   patch:
 *     summary: Change own password
 *     tags: [Admin Management]
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
 *         description: Password updated
 */
router.patch('/admins/:id/password', adminGuard, changeSuperAdminPassword);

export default router;
