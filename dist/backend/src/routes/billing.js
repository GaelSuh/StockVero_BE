import { Router } from 'express';
import { tenantGuard, mustChangePasswordGuard, moduleGuard, permissionGuard } from '../middleware/auth.js';
import { getBillingOverview, getBillingModules, addBillingModule, removeBillingModule, cancelModuleRemoval, getPaymentMethod, updatePaymentMethod, requestBillingCycleChange, getBillingTransactions, cancelSubscription, } from '../controllers/billing.controller.js';
const router = Router();
router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('billing'));
/**
 * @openapi
 * /api/v1/billing/overview:
 *   get:
 *     summary: Billing overview
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Billing overview data
 */
router.get('/overview', permissionGuard('billing', 'canRead'), getBillingOverview);
/**
 * @openapi
 * /api/v1/billing/modules:
 *   get:
 *     summary: Billing modules
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Billing modules
 */
router.get('/modules', permissionGuard('billing', 'canRead'), getBillingModules);
/**
 * @openapi
 * /api/v1/billing/modules/add:
 *   post:
 *     summary: Add billing module
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Module added
 */
router.post('/modules/add', permissionGuard('billing', 'canUpdate'), addBillingModule);
/**
 * @openapi
 * /api/v1/billing/modules/remove:
 *   post:
 *     summary: Remove billing module
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Module removal scheduled
 */
router.post('/modules/remove', permissionGuard('billing', 'canUpdate'), removeBillingModule);
/**
 * @openapi
 * /api/v1/billing/modules/cancel-removal:
 *   post:
 *     summary: Cancel billing module removal
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Removal cancelled
 */
router.post('/modules/cancel-removal', permissionGuard('billing', 'canUpdate'), cancelModuleRemoval);
/**
 * @openapi
 * /api/v1/billing/payment-method:
 *   get:
 *     summary: Get payment method
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Payment method
 */
router.get('/payment-method', permissionGuard('billing', 'canRead'), getPaymentMethod);
/**
 * @openapi
 * /api/v1/billing/payment-method:
 *   patch:
 *     summary: Update payment method
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Payment method updated
 */
router.patch('/payment-method', permissionGuard('billing', 'canUpdate'), updatePaymentMethod);
/**
 * @openapi
 * /api/v1/billing/cycle:
 *   patch:
 *     summary: Request billing cycle change
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Billing cycle change scheduled
 */
router.patch('/cycle', permissionGuard('billing', 'canUpdate'), requestBillingCycleChange);
/**
 * @openapi
 * /api/v1/billing/transactions:
 *   get:
 *     summary: Payment history
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Payment transactions
 */
router.get('/transactions', permissionGuard('billing', 'canRead'), getBillingTransactions);
/**
 * @openapi
 * /api/v1/billing/cancel:
 *   post:
 *     summary: Cancel subscription
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Subscription cancelled
 */
router.post('/cancel', permissionGuard('billing', 'canUpdate'), cancelSubscription);
export default router;
