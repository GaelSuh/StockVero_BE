import { Router } from 'express';
import { tenantGuard, moduleGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import {
  createCustomer,
  listCustomers,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerInvoices,
  listCustomerPurchases,
  addCustomerPurchase,
  deleteCustomerPurchase,
} from '../controllers/crm.controller.js';

const router = Router();
router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('crm'));

/**
 * @openapi
 * /api/v1/crm/customers:
 *   get:
 *     summary: List customers
 *     tags: [CRM]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Paginated customer list
 */
router.get('/customers', permissionGuard('crm', 'canRead'), listCustomers);

/**
 * @openapi
 * /api/v1/crm/customers:
 *   post:
 *     summary: Create a customer
 *     tags: [CRM]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               phone:
 *                 type: string
 *               location:
 *                 type: string
 *               address:
 *                 type: string
 *               initialRevenue:
 *                 type: number
 *               status:
 *                 type: string
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Customer created
 */
router.post('/customers', permissionGuard('crm', 'canCreate'), createCustomer);

/**
 * @openapi
 * /api/v1/crm/customers/{id}:
 *   get:
 *     summary: Get a customer
 *     tags: [CRM]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Customer details
 */
router.get('/customers/:id', permissionGuard('crm', 'canRead'), getCustomer);

/**
 * @openapi
 * /api/v1/crm/customers/{id}:
 *   patch:
 *     summary: Update a customer
 *     tags: [CRM]
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
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               phone:
 *                 type: string
 *               location:
 *                 type: string
 *               address:
 *                 type: string
 *               initialRevenue:
 *                 type: number
 *               status:
 *                 type: string
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Customer updated
 */
router.patch('/customers/:id', permissionGuard('crm', 'canUpdate'), updateCustomer);

/**
 * @openapi
 * /api/v1/crm/customers/{id}:
 *   delete:
 *     summary: Delete a customer
 *     tags: [CRM]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Customer deleted
 */
router.delete('/customers/:id', permissionGuard('crm', 'canDelete'), deleteCustomer);

router.get('/customers/:id/invoices', permissionGuard('crm', 'canRead'), getCustomerInvoices);

// ── Customer Purchases ───────────────────────────────────────────────────────
router.get('/customers/:id/purchases', permissionGuard('crm', 'canRead'), listCustomerPurchases);
router.post('/customers/:id/purchases', permissionGuard('crm', 'canCreate'), addCustomerPurchase);
router.delete('/customers/:id/purchases/:purchaseId', permissionGuard('crm', 'canDelete'), deleteCustomerPurchase);

export default router;
