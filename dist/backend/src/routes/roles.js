import { Router } from 'express';
import { tenantGuard, mustChangePasswordGuard, adminGuard } from '../middleware/auth.js';
import { listRoles, getRole, createRole, updateRole, deleteRole, } from '../controllers/roles.controller.js';
const router = Router();
router.use(tenantGuard, mustChangePasswordGuard, adminGuard);
/**
 * @openapi
 * /api/v1/roles:
 *   get:
 *     summary: List roles
 *     tags: [Roles]
 *     responses:
 *       200:
 *         description: Roles retrieved
 */
router.get('/', listRoles);
/**
 * @openapi
 * /api/v1/roles:
 *   post:
 *     summary: Create a role
 *     tags: [Roles]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, abbreviation, permissions]
 *             properties:
 *               name:
 *                 type: string
 *               abbreviation:
 *                 type: string
 *                 maxLength: 8
 *               description:
 *                 type: string
 *               isDefault:
 *                 type: boolean
 *               isAdmin:
 *                 type: boolean
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [moduleKey, canRead, canCreate, canUpdate, canDelete]
 *                   properties:
 *                     moduleKey:
 *                       type: string
 *                     canRead:
 *                       type: boolean
 *                     canCreate:
 *                       type: boolean
 *                     canUpdate:
 *                       type: boolean
 *                     canDelete:
 *                       type: boolean
 *     responses:
 *       201:
 *         description: Role created
 */
router.post('/', createRole);
/**
 * @openapi
 * /api/v1/roles/{id}:
 *   get:
 *     summary: Get a role
 *     tags: [Roles]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Role retrieved
 */
router.get('/:id', getRole);
/**
 * @openapi
 * /api/v1/roles/{id}:
 *   patch:
 *     summary: Update a role
 *     tags: [Roles]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, abbreviation, permissions]
 *             properties:
 *               name:
 *                 type: string
 *               abbreviation:
 *                 type: string
 *                 maxLength: 8
 *               description:
 *                 type: string
 *               isDefault:
 *                 type: boolean
 *               isAdmin:
 *                 type: boolean
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [moduleKey, canRead, canCreate, canUpdate, canDelete]
 *                   properties:
 *                     moduleKey:
 *                       type: string
 *                     canRead:
 *                       type: boolean
 *                     canCreate:
 *                       type: boolean
 *                     canUpdate:
 *                       type: boolean
 *                     canDelete:
 *                       type: boolean
 *     responses:
 *       200:
 *         description: Role updated
 */
router.patch('/:id', updateRole);
/**
 * @openapi
 * /api/v1/roles/{id}:
 *   delete:
 *     summary: Delete a role
 *     tags: [Roles]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Role deleted
 */
router.delete('/:id', deleteRole);
export default router;
