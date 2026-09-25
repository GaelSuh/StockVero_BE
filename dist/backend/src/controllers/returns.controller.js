import { processReturn, ReturnValidationError } from '../services/returnService.js';
import { InsufficientStockError } from '../services/saleInventoryService.js';
import { prisma } from '../db.js';
export async function createReturn(req, res) {
    try {
        const tenantId = req.tenantId;
        const user = req.user;
        const { saleId, reason, returnType, items, exchangeItems, refundMethod } = req.body;
        if (!saleId || !reason || !returnType || !items?.length) {
            return res.status(400).json({ success: false, message: 'saleId, reason, returnType, and items are required' });
        }
        if (!['REFUND', 'EXCHANGE'].includes(returnType)) {
            return res.status(400).json({ success: false, message: 'returnType must be REFUND or EXCHANGE' });
        }
        // Resolved from the database like the sale flow does — this recorded an
        // email address where every other screen shows a person's name.
        const actor = await prisma.user.findUnique({
            where: { id: user.id },
            select: { firstName: true, lastName: true, email: true },
        });
        const processedByName = [actor?.firstName, actor?.lastName].filter(Boolean).join(' ').trim() ||
            actor?.email ||
            user.email;
        const result = await processReturn(tenantId, saleId, {
            reason,
            returnType,
            items,
            exchangeItems,
            refundMethod,
            processedById: user.id,
            processedByName,
        });
        const skipped = result.stockRestorationSkipped;
        return res.status(201).json({
            success: true,
            message: 'Return processed',
            data: result,
            // The return itself always succeeds — refund/exchange settlement never
            // depends on this — but if a line had no unit reference to restore
            // against (a sale from before units were tracked per line), the till
            // needs to know stock wasn't auto-adjusted for it.
            warning: skipped?.length
                ? `Stock was not automatically restored for: ${skipped.map((s) => s.productName).join(', ')}. Adjust inventory manually if needed.`
                : undefined,
        });
    }
    catch (error) {
        console.error('Error processing return:', error);
        // A return of more than was sold is the caller's mistake, not a server
        // fault — it needs to reach the till as a readable message.
        if (error instanceof ReturnValidationError || error instanceof InsufficientStockError) {
            return res.status(400).json({ success: false, message: error.message });
        }
        return res.status(500).json({
            success: false,
            message: error instanceof Error ? error.message : 'Failed to process return',
        });
    }
}
export async function listReturns(req, res) {
    try {
        const tenantId = req.tenantId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const where = { tenantId };
        if (req.query.saleId)
            where.saleId = req.query.saleId;
        const [returns, total] = await Promise.all([
            prisma.saleReturn.findMany({
                where,
                include: {
                    sale: { select: { saleNumber: true, mode: true } },
                    items: true,
                },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.saleReturn.count({ where }),
        ]);
        return res.json({
            success: true,
            data: returns,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to list returns' });
    }
}
export async function getReturn(req, res) {
    try {
        const saleReturn = await prisma.saleReturn.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
            include: {
                sale: {
                    select: {
                        id: true,
                        saleNumber: true,
                        mode: true,
                        customerName: true,
                        customer: { select: { name: true } },
                    },
                },
                items: true,
            },
        });
        if (!saleReturn)
            return res.status(404).json({ success: false, message: 'Return not found' });
        // An exchange handed goods over as its own sale. Without loading it the
        // return reads as though the customer got nothing back.
        const exchangeSale = saleReturn.exchangeSaleId
            ? await prisma.sale.findFirst({
                where: { id: saleReturn.exchangeSaleId, tenantId: req.tenantId },
                include: { items: true, payments: true },
            })
            : null;
        return res.json({ success: true, data: { ...saleReturn, exchangeSale } });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to get return' });
    }
}
/**
 * Headline figures and trends for the returns page.
 *
 * Everything is derived on request rather than stored: returns are low-volume
 * next to sales, and a stored rollup would need invalidating on every refund.
 */
export async function getReturnsAnalytics(req, res) {
    try {
        const tenantId = req.tenantId;
        const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
        const since = new Date();
        since.setDate(since.getDate() - (days - 1));
        since.setHours(0, 0, 0, 0);
        const where = { tenantId, createdAt: { gte: since } };
        if (req.query.mode)
            where.sale = { mode: req.query.mode };
        const [returns, salesInPeriod] = await Promise.all([
            prisma.saleReturn.findMany({
                where,
                include: { items: true, sale: { select: { mode: true } } },
                orderBy: { createdAt: 'asc' },
            }),
            prisma.sale.aggregate({
                where: {
                    tenantId,
                    createdAt: { gte: since },
                    status: { in: ['COMPLETED', 'PARTIAL'] },
                    ...(req.query.mode ? { mode: req.query.mode } : {}),
                },
                _sum: { totalAmount: true },
                _count: { _all: true },
            }),
        ]);
        const refunded = returns
            .filter((r) => r.returnType === 'REFUND')
            .reduce((sum, r) => sum + Number(r.refundAmount), 0);
        const exchanged = returns
            .filter((r) => r.returnType === 'EXCHANGE')
            .reduce((sum, r) => sum + Number(r.refundAmount), 0);
        const totalValue = refunded + exchanged;
        const salesValue = Number(salesInPeriod._sum.totalAmount ?? 0);
        // One bucket per day, including the empty ones — a line chart with gaps
        // silently rescales the axis and makes a quiet week look busy.
        const byDay = new Map();
        for (let i = 0; i < days; i++) {
            const d = new Date(since);
            d.setDate(since.getDate() + i);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            byDay.set(key, { date: key, count: 0, value: 0 });
        }
        for (const r of returns) {
            const d = r.createdAt;
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const bucket = byDay.get(key);
            if (bucket) {
                bucket.count += 1;
                bucket.value += Number(r.refundAmount);
            }
        }
        // Reasons are stored as "CODE: free text note", so the code is the part that
        // groups. Splitting here keeps the note without fragmenting the totals.
        const byReason = new Map();
        for (const r of returns) {
            const code = String(r.reason ?? 'OTHER').split(':')[0].trim() || 'OTHER';
            const entry = byReason.get(code) ?? { reason: code, count: 0, value: 0 };
            entry.count += 1;
            entry.value += Number(r.refundAmount);
            byReason.set(code, entry);
        }
        const byProduct = new Map();
        for (const r of returns) {
            for (const item of r.items) {
                const entry = byProduct.get(item.categoryId) ?? {
                    productName: item.productName,
                    quantity: 0,
                    value: 0,
                };
                entry.quantity += item.quantity;
                entry.value += Number(item.unitPrice) * item.quantity;
                byProduct.set(item.categoryId, entry);
            }
        }
        return res.json({
            success: true,
            data: {
                days,
                totalReturns: returns.length,
                refundCount: returns.filter((r) => r.returnType === 'REFUND').length,
                exchangeCount: returns.filter((r) => r.returnType === 'EXCHANGE').length,
                refundedValue: refunded,
                exchangedValue: exchanged,
                totalValue,
                salesValue,
                /** Share of takings handed back. The number that matters. */
                returnRate: salesValue > 0 ? (totalValue / salesValue) * 100 : 0,
                itemsReturned: returns.reduce((sum, r) => sum + r.items.reduce((s, i) => s + i.quantity, 0), 0),
                trend: [...byDay.values()],
                byReason: [...byReason.values()].sort((a, b) => b.count - a.count),
                topProducts: [...byProduct.values()].sort((a, b) => b.value - a.value).slice(0, 8),
            },
        });
    }
    catch (error) {
        console.error('Error building returns analytics:', error);
        return res.status(500).json({ success: false, message: 'Failed to build returns analytics' });
    }
}
