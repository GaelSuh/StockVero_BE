import { z } from 'zod';
import { prisma } from '../db.js';
import { broadcastToModule } from '../services/notificationService.js';
import { recordIncome, recordExpense, reverseIncome, reverseExpense } from '../services/balanceService.js';
import { logAudit, extractRequestContext, buildDiff, AuditActorType } from '../services/auditService.js';
const TransactionSchema = z.object({
    type: z.enum(['INCOME', 'EXPENSE']),
    amount: z.number().positive(),
    currency: z.string().optional(),
    description: z.string().min(1),
    category: z.string().optional(),
    moduleRef: z.string().optional(),
    entityId: z.string().optional(),
    recordedAt: z.string().datetime().optional(),
    status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED']).optional(),
});
export const createTransaction = async (req, res) => {
    try {
        const parsed = TransactionSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
        }
        const data = parsed.data;
        const isOwner = req.user?.accountType === 'owner';
        const nextStatus = isOwner ? (data.status ?? 'PENDING') : 'PENDING';
        const transaction = await prisma.$transaction(async (tx) => {
            if (nextStatus === 'ACCEPTED') {
                if (data.type === 'INCOME') {
                    await recordIncome(req.tenantId, data.amount, tx);
                }
                else {
                    await recordExpense(req.tenantId, data.amount, tx);
                }
            }
            return tx.transaction.create({
                data: {
                    tenantId: req.tenantId,
                    type: data.type,
                    status: nextStatus,
                    amount: data.amount,
                    currency: data.currency || 'XAF',
                    description: data.description,
                    category: data.category,
                    moduleRef: data.moduleRef,
                    entityId: data.entityId,
                    recordedAt: data.recordedAt ? new Date(data.recordedAt) : new Date(),
                    isAutomatic: false,
                },
            });
        });
        await broadcastToModule(req.tenantId, 'finance', {
            type: 'finance.transaction.created',
            title: 'Manual Transaction Recorded',
            message: `${transaction.type}: ${transaction.amount} ${transaction.currency} for ${transaction.description}`,
            link: '/finances',
        });
        void logAudit({
            tenantId: req.tenantId,
            actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
            actorId: req.user?.id,
            action: 'TRANSACTION_CREATED',
            module: 'finance',
            entityType: 'Transaction',
            entityId: transaction.id,
            entityLabel: transaction.description ?? undefined,
            details: { type: transaction.type, amount: transaction.amount, status: transaction.status, currency: transaction.currency },
            ...extractRequestContext(req),
        });
        return res.status(201).json({ success: true, message: 'Transaction created successfully', data: transaction });
    }
    catch (error) {
        console.error('Error creating transaction:', error);
        return res.status(500).json({ success: false, message: 'Failed to create transaction', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};
export const listTransactions = async (req, res) => {
    try {
        const page = req.query.page ? parseInt(req.query.page, 10) : 1;
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
        const type = req.query.type ? String(req.query.type) : undefined;
        const includeInternal = String(req.query.includeInternal ?? 'false').toLowerCase() === 'true';
        const from = req.query.from ? new Date(String(req.query.from)) : undefined;
        const to = req.query.to ? new Date(String(req.query.to)) : undefined;
        const skip = (page - 1) * limit;
        const where = { tenantId: req.tenantId };
        if (type === 'INTERNAL' && !includeInternal) {
            where.AND = [{ type: 'INTERNAL' }, { type: { not: 'INTERNAL' } }];
        }
        else if (type) {
            where.type = type;
        }
        else if (!includeInternal) {
            where.type = { not: 'INTERNAL' };
        }
        if (from || to) {
            where.recordedAt = {};
            if (from)
                where.recordedAt.gte = from;
            if (to)
                where.recordedAt.lte = to;
        }
        const [rawTxs, total] = await Promise.all([
            prisma.transaction.findMany({ where, orderBy: { recordedAt: 'desc' }, skip, take: limit }),
            prisma.transaction.count({ where }),
        ]);
        const invoiceIds = rawTxs.filter((tx) => tx.invoiceId).map((tx) => tx.invoiceId);
        const invoiceMap = {};
        if (invoiceIds.length > 0) {
            const invs = await prisma.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNumber: true } });
            for (const inv of invs)
                invoiceMap[inv.id] = inv.invoiceNumber;
        }
        const transactions = rawTxs.map((tx) => ({ ...tx, invoiceNumber: tx.invoiceId ? (invoiceMap[tx.invoiceId] ?? null) : null }));
        return res.json({ success: true, message: 'Transactions retrieved successfully', data: transactions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    }
    catch (error) {
        console.error('Error listing transactions:', error);
        return res.status(500).json({ success: false, message: 'Failed to retrieve transactions', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};
export const getTransaction = async (req, res) => {
    try {
        const tx = await prisma.transaction.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
            include: {
                project: {
                    select: {
                        id: true,
                        name: true,
                        status: true,
                        customer: { select: { id: true, name: true } },
                    },
                },
                invoicePayment: {
                    select: {
                        id: true,
                        invoiceId: true,
                        percentageApproved: true,
                        amountApproved: true,
                        approvedBy: true,
                        createdAt: true,
                    },
                },
            },
        });
        if (!tx)
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        // Fetch customer directly (no prisma relation defined on Transaction model)
        let customer = null;
        if (tx.customerId) {
            customer = await prisma.customer.findFirst({
                where: { id: tx.customerId, tenantId: req.tenantId },
                select: { id: true, name: true, email: true, status: true },
            });
        }
        // Fetch invoice (no prisma relation defined on Transaction model)
        let invoice = null;
        if (tx.invoiceId) {
            invoice = await prisma.invoice.findUnique({
                where: { id: tx.invoiceId },
                select: {
                    id: true,
                    invoiceNumber: true,
                    type: true,
                    status: true,
                    total: true,
                    totalApproved: true,
                    approvedAt: true,
                    reviewedBy: true,
                },
            });
        }
        // If invoicePayment links to an invoice but tx.invoiceId is not set, fetch that invoice too
        let invoicePaymentInvoice = null;
        if (!invoice && tx.invoicePayment?.invoiceId) {
            invoicePaymentInvoice = await prisma.invoice.findUnique({
                where: { id: tx.invoicePayment.invoiceId },
                select: {
                    id: true,
                    invoiceNumber: true,
                    type: true,
                    status: true,
                    total: true,
                    totalApproved: true,
                    approvedAt: true,
                    reviewedBy: true,
                },
            });
        }
        const resolvedInvoice = invoice ?? invoicePaymentInvoice;
        // Resolve UUID fields to human-readable names
        const uuidsToResolve = [
            resolvedInvoice?.reviewedBy,
            tx.invoicePayment?.approvedBy,
        ].filter(Boolean);
        const uniqueUuids = [...new Set(uuidsToResolve)];
        const nameMap = {};
        if (uniqueUuids.length > 0) {
            const [users, employees] = await Promise.all([
                prisma.user.findMany({
                    where: { id: { in: uniqueUuids } },
                    select: { id: true, firstName: true, lastName: true },
                }),
                prisma.employee.findMany({
                    where: { id: { in: uniqueUuids } },
                    select: { id: true, firstName: true, lastName: true },
                }),
            ]);
            for (const u of [...users, ...employees]) {
                nameMap[u.id] = `${u.firstName} ${u.lastName}`.trim();
            }
        }
        const enrichedInvoice = resolvedInvoice
            ? {
                ...resolvedInvoice,
                reviewedByName: resolvedInvoice.reviewedBy
                    ? (nameMap[resolvedInvoice.reviewedBy] ?? 'Unknown')
                    : null,
            }
            : null;
        const enrichedInvoicePayment = tx.invoicePayment
            ? {
                ...tx.invoicePayment,
                approvedByName: tx.invoicePayment.approvedBy
                    ? (nameMap[tx.invoicePayment.approvedBy] ?? 'Unknown')
                    : null,
            }
            : null;
        return res.json({
            success: true,
            message: 'Transaction retrieved successfully',
            data: {
                ...tx,
                customer,
                invoice: enrichedInvoice,
                invoicePayment: enrichedInvoicePayment,
            },
        });
    }
    catch (error) {
        console.error('Error fetching transaction:', error);
        return res.status(500).json({ success: false, message: 'Failed to retrieve transaction', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};
export const updateTransaction = async (req, res) => {
    try {
        const parsed = TransactionSchema.partial().safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
        const existing = await prisma.transaction.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
        if (!existing)
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        if (existing.isAutomatic)
            return res.status(400).json({ success: false, message: 'Cannot modify automatic transactions' });
        const data = parsed.data;
        const isOwner = req.user?.accountType === 'owner';
        if (data.status && !isOwner)
            return res.status(403).json({ success: false, message: 'Only the tenant owner can update transaction status' });
        const transaction = await prisma.$transaction(async (tx) => {
            const wasAccepted = existing.status === 'ACCEPTED';
            const nextType = data.type ?? existing.type;
            const nextAmount = data.amount ?? Number(existing.amount);
            const nextStatus = data.status ?? existing.status;
            const willBeAccepted = nextStatus === 'ACCEPTED';
            if (wasAccepted) {
                if (existing.type === 'INCOME') {
                    await reverseIncome(req.tenantId, Number(existing.amount), tx);
                }
                else {
                    await reverseExpense(req.tenantId, Number(existing.amount), tx);
                }
            }
            if (willBeAccepted) {
                if (nextType === 'INCOME') {
                    await recordIncome(req.tenantId, nextAmount, tx);
                }
                else {
                    await recordExpense(req.tenantId, nextAmount, tx);
                }
            }
            return tx.transaction.update({
                where: { id: req.params.id },
                data: {
                    ...data,
                    type: data.type ? data.type : undefined,
                    amount: data.amount !== undefined ? data.amount : undefined,
                    recordedAt: data.recordedAt ? new Date(data.recordedAt) : undefined,
                    status: data.status ? data.status : undefined,
                },
            });
        });
        await broadcastToModule(req.tenantId, 'finance', { type: 'finance.transaction.updated', title: 'Transaction Updated', message: `Transaction info was modified for: ${transaction.description}`, link: '/finances' });
        void logAudit({
            tenantId: req.tenantId,
            actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
            actorId: req.user?.id,
            action: 'TRANSACTION_UPDATED',
            module: 'finance',
            entityType: 'Transaction',
            entityId: transaction.id,
            entityLabel: transaction.description ?? undefined,
            details: buildDiff(existing, transaction),
            ...extractRequestContext(req),
        });
        return res.json({ success: true, message: 'Transaction updated successfully', data: transaction });
    }
    catch (error) {
        console.error('Error updating transaction:', error);
        return res.status(500).json({ success: false, message: 'Failed to update transaction', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};
export const deleteTransaction = async (req, res) => {
    try {
        const existing = await prisma.transaction.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
        if (!existing)
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        if (existing.isAutomatic)
            return res.status(400).json({ success: false, message: 'Cannot delete automatic transactions' });
        await prisma.$transaction(async (tx) => {
            if (existing.status === 'ACCEPTED') {
                if (existing.type === 'INCOME') {
                    await reverseIncome(req.tenantId, Number(existing.amount), tx);
                }
                else {
                    await reverseExpense(req.tenantId, Number(existing.amount), tx);
                }
            }
            await tx.transaction.delete({ where: { id: req.params.id } });
        });
        await broadcastToModule(req.tenantId, 'finance', { type: 'finance.transaction.deleted', title: 'Transaction Deleted', message: `The manual transaction for ${existing.description} was removed.` });
        void logAudit({
            tenantId: req.tenantId,
            actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
            actorId: req.user?.id,
            action: 'TRANSACTION_DELETED',
            module: 'finance',
            entityType: 'Transaction',
            entityId: existing.id,
            entityLabel: existing.description ?? undefined,
            details: { type: existing.type, amount: existing.amount, status: existing.status },
            ...extractRequestContext(req),
        });
        return res.json({ success: true, message: 'Transaction deleted successfully' });
    }
    catch (error) {
        console.error('Error deleting transaction:', error);
        return res.status(500).json({ success: false, message: 'Failed to delete transaction', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};
export const getSummary = async (req, res) => {
    try {
        const from = req.query.from ? new Date(String(req.query.from)) : undefined;
        const to = req.query.to ? new Date(String(req.query.to)) : undefined;
        const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
        const where = { tenantId: req.tenantId, status: 'ACCEPTED' };
        if (projectId) {
            where.OR = [
                { projectId },
                { moduleRef: 'projects', entityId: projectId },
                { moduleRef: 'PROJECT', entityId: projectId },
            ];
        }
        if (from || to) {
            where.recordedAt = {};
            if (from)
                where.recordedAt.gte = from;
            if (to)
                where.recordedAt.lte = to;
        }
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        const [income, expense, pendingInvoiceCount, pendingInvoiceValue, approvedThisMonth, rejectedThisMonth, balanceRecord, pendingExpenseValue] = await Promise.all([
            prisma.transaction.aggregate({ where: { ...where, AND: [{ type: 'INCOME' }, { type: { not: 'INTERNAL' } }] }, _sum: { amount: true } }),
            prisma.transaction.aggregate({ where: { ...where, AND: [{ type: 'EXPENSE' }, { type: { not: 'INTERNAL' } }] }, _sum: { amount: true } }),
            prisma.invoice.count({ where: { tenantId: req.tenantId, status: 'PENDING' } }),
            prisma.invoice.aggregate({ where: { tenantId: req.tenantId, status: 'PENDING' }, _sum: { total: true } }),
            prisma.invoice.count({ where: { tenantId: req.tenantId, status: 'APPROVED', updatedAt: { gte: startOfMonth, lte: endOfMonth } } }),
            prisma.invoice.count({ where: { tenantId: req.tenantId, status: 'REJECTED', updatedAt: { gte: startOfMonth, lte: endOfMonth } } }),
            prisma.tenantFinanceBalance.findUnique({ where: { tenantId: req.tenantId } }),
            prisma.invoice.aggregate({ where: { tenantId: req.tenantId, status: 'PENDING', type: 'PURCHASE' }, _sum: { total: true } }),
        ]);
        const totalRevenue = income._sum.amount || 0;
        const totalExpenses = expense._sum.amount || 0;
        const netBalance = balanceRecord ? Number(balanceRecord.netBalance) : 0;
        const totalIncome = Number(income._sum.amount ?? 0);
        const totalExpense = Number(expense._sum.amount ?? 0);
        const pendingExpense = Number(pendingExpenseValue._sum?.total ?? 0);
        const balanceWarning = netBalance < pendingExpense;
        const summaryApprovedPurchases = await prisma.invoice.findMany({
            where: { tenantId: req.tenantId, type: 'PURCHASE', status: 'APPROVED' },
            include: { category: { select: { costPrice: true } } },
        });
        const summaryRemainingApprovedCost = summaryApprovedPurchases.reduce((sum, inv) => {
            const unitsRemaining = Math.max(0, (inv.authorisedQty ?? 0) - (inv.addedQty ?? 0));
            const costPerUnit = Number(inv.category?.costPrice ?? 0);
            return sum + unitsRemaining * costPerUnit;
        }, 0);
        const summaryEstimatedFreeBalance = netBalance - summaryRemainingApprovedCost;
        return res.json({
            success: true,
            message: 'Summary retrieved successfully',
            data: {
                totalRevenue,
                totalExpenses,
                net: totalRevenue - totalExpenses,
                netBalance,
                totalIncome,
                totalExpense,
                pendingExpenseValue: pendingExpense,
                remainingApprovedCost: summaryRemainingApprovedCost,
                estimatedFreeBalance: summaryEstimatedFreeBalance,
                balanceWarning,
                balanceWarningMessage: balanceWarning
                    ? `Warning: Net balance (${netBalance.toFixed(2)} XAF) is less than pending purchase expenses (${pendingExpense.toFixed(2)} XAF).`
                    : null,
                pendingInvoices: pendingInvoiceCount,
                pendingInvoiceValue: Number(pendingInvoiceValue._sum?.total ?? 0),
                approvedInvoicesThisMonth: approvedThisMonth,
                rejectedInvoicesThisMonth: rejectedThisMonth,
                period: { from, to },
            },
        });
    }
    catch (error) {
        console.error('Error fetching summary:', error);
        return res.status(500).json({ success: false, message: 'Failed to retrieve summary', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};
export const getMonthlySummary = async (req, res) => {
    try {
        const year = parseInt(req.params.year, 10);
        if (Number.isNaN(year))
            return res.status(400).json({ success: false, message: 'Invalid year' });
        const transactions = await prisma.transaction.findMany({
            where: {
                tenantId: req.tenantId,
                status: 'ACCEPTED',
                type: { not: 'INTERNAL' },
                recordedAt: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) },
            },
        });
        const months = Array(12).fill(null).map((_, i) => ({ month: i + 1, income: 0, expense: 0 }));
        for (const tx of transactions) {
            const monthIndex = tx.recordedAt.getMonth();
            if (tx.type === 'INCOME')
                months[monthIndex].income += Number(tx.amount);
            else if (tx.type === 'EXPENSE')
                months[monthIndex].expense += Number(tx.amount);
        }
        return res.json({ success: true, message: 'Monthly summary retrieved successfully', data: months.map(m => ({ ...m, net: m.income - m.expense })) });
    }
    catch (error) {
        console.error('Error fetching monthly summary:', error);
        return res.status(500).json({ success: false, message: 'Failed to retrieve monthly summary', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};
export const getWeeklySummary = async (req, res) => {
    try {
        const year = parseInt(req.params.year, 10);
        const month = parseInt(req.params.month, 10);
        if (Number.isNaN(year) || Number.isNaN(month))
            return res.status(400).json({ success: false, message: 'Invalid year or month' });
        const startOfMonth = new Date(year, month - 1, 1);
        const endOfMonth = new Date(year, month, 0);
        const transactions = await prisma.transaction.findMany({
            where: {
                tenantId: req.tenantId,
                status: 'ACCEPTED',
                type: { not: 'INTERNAL' },
                recordedAt: { gte: startOfMonth, lte: endOfMonth },
            },
        });
        const weeks = [
            { week: 'Week 1', income: 0, expense: 0 }, { week: 'Week 2', income: 0, expense: 0 },
            { week: 'Week 3', income: 0, expense: 0 }, { week: 'Week 4', income: 0, expense: 0 },
            { week: 'Week 5', income: 0, expense: 0 },
        ];
        for (const tx of transactions) {
            let weekIndex = Math.floor((tx.recordedAt.getDate() - 1) / 7);
            if (weekIndex > 4)
                weekIndex = 4;
            if (tx.type === 'INCOME')
                weeks[weekIndex].income += Number(tx.amount);
            else if (tx.type === 'EXPENSE')
                weeks[weekIndex].expense += Number(tx.amount);
        }
        return res.json({ success: true, message: 'Weekly summary retrieved successfully', data: weeks });
    }
    catch (error) {
        console.error('Error fetching weekly summary:', error);
        return res.status(500).json({ success: false, message: 'Failed to retrieve weekly summary', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};
// Alias so routes can import with a different name
export { listTransactions as listTransactionsController };
// ── getBalance ────────────────────────────────────────────────────────────────
export const getBalance = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const balance = await prisma.tenantFinanceBalance.findUnique({
            where: { tenantId },
        });
        const [pendingExpenses, incomeAgg, expenseAgg, approvedPurchaseInvoices] = await Promise.all([
            prisma.invoice.aggregate({
                where: { tenantId, status: 'PENDING', type: 'PURCHASE' },
                _sum: { total: true },
            }),
            prisma.transaction.aggregate({
                where: { tenantId, status: 'ACCEPTED', AND: [{ type: 'INCOME' }, { type: { not: 'INTERNAL' } }] },
                _sum: { amount: true },
            }),
            prisma.transaction.aggregate({
                where: { tenantId, status: 'ACCEPTED', AND: [{ type: 'EXPENSE' }, { type: { not: 'INTERNAL' } }] },
                _sum: { amount: true },
            }),
            prisma.invoice.findMany({
                where: { tenantId, type: 'PURCHASE', status: 'APPROVED' },
                include: { category: { select: { costPrice: true } } },
            }),
        ]);
        const totalIncome = Number(incomeAgg._sum?.amount ?? (balance ? balance.totalIncome : 0));
        const totalExpense = Number(expenseAgg._sum?.amount ?? (balance ? balance.totalExpense : 0));
        const netBalance = totalIncome - totalExpense;
        const pendingExpenseValue = Number(pendingExpenses._sum?.total ?? 0);
        const remainingApprovedCost = approvedPurchaseInvoices.reduce((sum, inv) => {
            const unitsRemaining = Math.max(0, (inv.authorisedQty ?? 0) - (inv.addedQty ?? 0));
            const costPerUnit = Number(inv.category?.costPrice ?? 0);
            return sum + unitsRemaining * costPerUnit;
        }, 0);
        const estimatedFreeBalance = netBalance - remainingApprovedCost;
        return res.json({
            success: true,
            message: 'Balance retrieved successfully',
            data: {
                netBalance,
                totalIncome,
                totalExpense,
                pendingExpenses: pendingExpenseValue,
                remainingApprovedCost,
                estimatedFreeBalance,
                updatedAt: balance?.updatedAt ?? null,
            },
        });
    }
    catch (error) {
        console.error('Error fetching balance:', error);
        return res.status(500).json({ success: false, message: 'Failed to retrieve balance', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};
// ── getAvailableTransactionsForLinking ────────────────────────────────────────
export const getAvailableTransactionsForLinking = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const customerId = req.query.customerId ? String(req.query.customerId) : undefined;
        const where = {
            tenantId,
            type: 'INCOME',
            status: 'ACCEPTED',
            invoicePaymentId: null,
        };
        if (customerId)
            where.customerId = customerId;
        const transactions = await prisma.transaction.findMany({
            where,
            orderBy: { recordedAt: 'desc' },
        });
        return res.json({ success: true, message: 'Available transactions retrieved successfully', data: transactions });
    }
    catch (error) {
        console.error('Error fetching available transactions:', error);
        return res.status(500).json({ success: false, message: 'Failed to retrieve transactions', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};
