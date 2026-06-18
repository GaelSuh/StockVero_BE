import { Router, Response } from 'express';
import { tenantGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import { AuthRequest } from '../types/index.js';
import { checkRoleDependencies } from '../services/dependencyCheckService.js';
import {
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
} from '../controllers/roles.controller.js';

const router = Router();
router.use(tenantGuard, mustChangePasswordGuard);

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
router.get('/', permissionGuard('administration', 'canRead'), listRoles);

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
router.post('/', permissionGuard('administration', 'canCreate'), createRole);

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
router.get('/:id', permissionGuard('administration', 'canRead'), getRole);

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
router.patch('/:id', permissionGuard('administration', 'canCreate'), updateRole);

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
router.get('/:id/can-delete', permissionGuard('administration', 'canCreate'), async (req: AuthRequest, res: Response) => {
  try {
    const report = await checkRoleDependencies(req.params.id, req.tenantId!);
    return res.json({ success: true, data: report });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Dependency check failed' });
  }
});

router.delete('/:id', permissionGuard('administration', 'canCreate'), async (req: AuthRequest, res: Response) => {
  const report = await checkRoleDependencies(req.params.id, req.tenantId!);
  if (!report.canDelete) {
    return res.status(409).json({ success: false, message: 'Cannot delete: unresolved dependencies', data: report });
  }
  return deleteRole(req, res);
});

export default router;
