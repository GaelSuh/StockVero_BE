import { Router } from 'express';
import { tenantGuard, mustChangePasswordGuard, adminGuard } from '../middleware/auth.js';
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
router.use(tenantGuard, mustChangePasswordGuard, adminGuard);

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
router.get('/', listEmployees);

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
router.post('/', createEmployee);

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
router.get('/:id', getEmployee);

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
router.patch('/:id', updateEmployee);

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
router.patch('/:id/role', updateEmployeeRole);

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
router.patch('/:id/reset-password', resetEmployeePassword);

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
router.delete('/:id', deleteEmployee);

export default router;
