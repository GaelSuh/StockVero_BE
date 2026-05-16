import { Router } from 'express';
import { tenantGuard, moduleGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import { prisma } from '../db.js';
import {
  createTransaction,
  listTransactionsController as listTransactionsCtrl,
  getTransaction,
  updateTransaction,
  deleteTransaction,
  getSummary,
  getMonthlySummary,
  getWeeklySummary,
  getBalance,
  getAvailableTransactionsForLinking,
} from '../controllers/finance.controller.js';

const router = Router();
router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('finance'));

/**
 * @openapi
 * /api/v1/finance/transactions:
 *   get:
 *     summary: List transactions
 *     tags: [Finance]
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
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *       - in: query
 *         name: includeInternal
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: Paginated ledger
 */
router.get('/transactions', permissionGuard('finance', 'canRead'), async (req, res) => {
  const hasCustomer = typeof req.query.customerId === 'string' && req.query.customerId.length > 0;
  const hasProject = typeof req.query.projectId === 'string' && req.query.projectId.length > 0;
  const hasSearch = typeof req.query.search === 'string' && req.query.search.length > 0;

  if (!hasCustomer && !hasProject && !hasSearch) {
    return listTransactionsCtrl(req, res);
  }

  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const type = req.query.type ? String(req.query.type) : undefined;
    const includeInternal = String(req.query.includeInternal ?? 'false').toLowerCase() === 'true';
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    const search = hasSearch ? String(req.query.search) : undefined;
    const customerId = hasCustomer ? String(req.query.customerId) : undefined;
    const projectId = hasProject ? String(req.query.projectId) : undefined;
    const skip = (page - 1) * limit;
    const tenantId = (req as any).tenantId as string;

    const where: any = { tenantId };
    if (type === 'INTERNAL' && !includeInternal) {
      where.AND = [{ type: 'INTERNAL' }, { type: { not: 'INTERNAL' } }];
    } else if (type) {
      where.type = type;
    } else if (!includeInternal) {
      where.type = { not: 'INTERNAL' };
    }
    if (from || to) {
      where.recordedAt = {};
      if (from) where.recordedAt.gte = from;
      if (to) where.recordedAt.lte = to;
    }
    if (search) {
      where.OR = [
        { description: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (customerId) {
      const customerProjects = await prisma.project.findMany({
        where: { tenantId, customerId },
        select: { id: true },
      });
      const projectIds = customerProjects.map((p) => p.id);
      where.OR = [
        { moduleRef: 'crm', entityId: customerId },
        ...(projectIds.length > 0 ? [{ moduleRef: 'projects', entityId: { in: projectIds } }] : []),
        ...(projectIds.length > 0 ? [{ projectId: { in: projectIds } }] : []),
      ];
    }
    if (projectId) {
      where.OR = [
        { projectId },
        { moduleRef: 'projects', entityId: projectId },
        { moduleRef: 'PROJECT', entityId: projectId },
      ];
    }

    const [rawTxs, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: { recordedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ]);

    // Enrich with invoice numbers (batch lookup)
    const invoiceIds = (rawTxs as any[]).filter((tx) => tx.invoiceId).map((tx) => tx.invoiceId as string);
    const invoiceMap: Record<string, string> = {};
    if (invoiceIds.length > 0) {
      const invs = await (prisma as any).invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNumber: true } });
      for (const inv of invs) invoiceMap[inv.id] = inv.invoiceNumber;
    }
    const transactions = (rawTxs as any[]).map((tx) => ({ ...tx, invoiceNumber: tx.invoiceId ? (invoiceMap[tx.invoiceId] ?? null) : null }));

    return res.json({
      success: true,
      message: 'Transactions retrieved successfully',
      data: transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error listing transactions:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve transactions',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * @openapi
 * /api/v1/finance/transactions:
 *   post:
 *     summary: Create a transaction
 *     tags: [Finance]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, amount, description]
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [INCOME, EXPENSE]
 *               amount:
 *                 type: number
 *               currency:
 *                 type: string
 *               description:
 *                 type: string
 *               category:
 *                 type: string
 *               moduleRef:
 *                 type: string
 *               entityId:
 *                 type: string
 *               recordedAt:
 *                 type: string
 *                 format: date-time
 *               status:
 *                 type: string
 *                 enum: [PENDING, ACCEPTED, REJECTED]
 *     responses:
 *       201:
 *         description: Transaction created
 */
router.post('/transactions', permissionGuard('finance', 'canCreate'), createTransaction);

/**
 * @openapi
 * /api/v1/finance/transactions/{id}:
 *   get:
 *     summary: Get a transaction
 *     tags: [Finance]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Transaction detail
 */
router.get('/transactions/:id', permissionGuard('finance', 'canRead'), getTransaction);

/**
 * @openapi
 * /api/v1/finance/transactions/{id}:
 *   patch:
 *     summary: Update a transaction
 *     tags: [Finance]
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
 *     responses:
 *       200:
 *         description: Transaction updated
 */
router.patch('/transactions/:id', permissionGuard('finance', 'canUpdate'), updateTransaction);

/**
 * @openapi
 * /api/v1/finance/transactions/{id}:
 *   delete:
 *     summary: Delete a transaction
 *     tags: [Finance]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Transaction deleted
 */
router.delete('/transactions/:id', permissionGuard('finance', 'canDelete'), deleteTransaction);

/**
 * @openapi
 * /api/v1/finance/summary:
 *   get:
 *     summary: Get finance summary
 *     tags: [Finance]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Summary totals
 */
router.get('/summary', permissionGuard('finance', 'canRead'), getSummary);
router.get('/balance', permissionGuard('finance', 'canRead'), getBalance);
router.get('/transactions/available-for-linking', permissionGuard('finance', 'canRead'), getAvailableTransactionsForLinking);

// NOTE: Finance queue routes removed — replaced by /api/v1/invoices

router.get('/monthly/:year', permissionGuard('finance', 'canRead'), getMonthlySummary);
router.get('/weekly/:year/:month', permissionGuard('finance', 'canRead'), getWeeklySummary);

export default router;
