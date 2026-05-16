import { Router } from 'express';
import { calculatePricingHandler } from '../controllers/pricing.controller.js';
const router = Router();
/**
 * @openapi
 * /api/v1/pricing/calculate:
 *   post:
 *     summary: Calculate pricing
 *     tags: [Pricing]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [modules, organisationSize, billingCycle]
 *             properties:
 *               modules:
 *                 type: array
 *                 items:
 *                   type: string
 *               organisationSize:
 *                 type: string
 *                 enum: ["1-10", "11-50", "51-200", "201+"]
 *               billingCycle:
 *                 type: string
 *                 enum: [MONTHLY, ANNUAL]
 *     responses:
 *       200:
 *         description: Pricing breakdown
 */
router.post('/calculate', calculatePricingHandler);
export default router;
