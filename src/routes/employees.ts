import { Router, Response } from 'express';
import { tenantGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import { AuthRequest } from '../types/index.js';
import { checkEmployeeDependencies } from '../services/dependencyCheckService.js';
import {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  updateEmployeeRole,
  updateEmployeeStatus,
  resetEmployeePassword,
  deleteEmployee,
} from '../controllers/employees.controller.js';

const router = Router();
router.use(tenantGuard, mustChangePasswordGuard);

/**
 * @openapi
 * /api/v1/employees:
 *   get:
 *     summary: List employees
 *     tags: [Employees]
 *     parameters:
 *       - in: query
 *         name: isActive
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: roleId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Employees retrieved
 */
router.get('/', permissionGuard('administration', 'canRead'), listEmployees);

/**
 * @openapi
 * /api/v1/employees:
 *   post:
 *     summary: Create an employee
 *     tags: [Employees]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [firstName, lastName, email, roleId]
 *             properties:
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               phone:
 *                 type: string
 *               jobTitle:
 *                 type: string
 *               roleId:
 *                 type: string
 *                 format: uuid
 *               avatarUrl:
 *                 type: string
 *                 format: uri
 *               isActive:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Employee created
 */
router.post('/', permissionGuard('administration', 'canCreate'), createEmployee);

/**
 * @openapi
 * /api/v1/employees/{id}:
 *   get:
 *     summary: Get an employee
 *     tags: [Employees]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Employee retrieved
 */
router.get('/:id', permissionGuard('administration', 'canRead'), getEmployee);

/**
 * @openapi
 * /api/v1/employees/{id}:
 *   patch:
 *     summary: Update an employee
 *     tags: [Employees]
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
 *             properties:
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               phone:
 *                 type: string
 *               jobTitle:
 *                 type: string
 *               roleId:
 *                 type: string
 *                 format: uuid
 *               avatarUrl:
 *                 type: string
 *                 format: uri
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Employee updated
 */
router.patch('/:id', permissionGuard('administration', 'canCreate'), updateEmployee);

/**
 * @openapi
 * /api/v1/employees/{id}/role:
 *   patch:
 *     summary: Update an employee role
 *     tags: [Employees]
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
 *             required: [roleId]
 *             properties:
 *               roleId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Employee role updated
 */
router.patch('/:id/role', permissionGuard('administration', 'canCreate'), updateEmployeeRole);

/**
 * @openapi
 * /api/v1/employees/{id}/status:
 *   patch:
 *     summary: Update an employee status
 *     tags: [Employees]
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
 *             required: [isActive]
 *             properties:
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Employee status updated
 */
router.patch('/:id/status', updateEmployeeStatus);

/**
 * @openapi
 * /api/v1/employees/{id}/reset-password:
 *   patch:
 *     summary: Reset an employee password
 *     tags: [Employees]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Password reset
 */
router.patch('/:id/reset-password', permissionGuard('administration', 'canCreate'), resetEmployeePassword);

/**
 * @openapi
 * /api/v1/employees/{id}:
 *   delete:
 *     summary: Deactivate an employee
 *     tags: [Employees]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Employee deactivated
 */
router.get('/:id/can-delete', permissionGuard('administration', 'canCreate'), async (req: AuthRequest, res: Response) => {
  try {
    const report = await checkEmployeeDependencies(req.params.id, req.tenantId!);
    return res.json({ success: true, data: report });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Dependency check failed' });
  }
});

router.delete('/:id', permissionGuard('administration', 'canCreate'), async (req: AuthRequest, res: Response) => {
  const report = await checkEmployeeDependencies(req.params.id, req.tenantId!);
  if (!report.canDelete) {
    return res.status(409).json({ success: false, message: 'Cannot delete: unresolved dependencies', data: report });
  }
  return deleteEmployee(req, res);
});

export default router;
