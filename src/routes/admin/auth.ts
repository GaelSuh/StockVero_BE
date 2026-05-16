import { Router } from 'express';
import { adminLogin, adminLogout, adminMe } from '../../controllers/admin.auth.controller.js';
import { adminGuard } from '../../middleware/adminAuth.js';

const router = Router();

/**
 * @openapi
 * /api/admin/v1/auth/login:
 *   post:
 *     summary: Admin login
 *     tags: [Admin Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 */
router.post('/auth/login', adminLogin);

/**
 * @openapi
 * /api/admin/v1/auth/me:
 *   get:
 *     summary: Get current admin profile
 *     tags: [Admin Auth]
 *     responses:
 *       200:
 *         description: Admin profile
 */
router.get('/auth/me', adminGuard, adminMe);

/**
 * @openapi
 * /api/admin/v1/auth/logout:
 *   post:
 *     summary: Admin logout
 *     tags: [Admin Auth]
 *     responses:
 *       200:
 *         description: Logged out
 */
router.post('/auth/logout', adminGuard, adminLogout);

export default router;
