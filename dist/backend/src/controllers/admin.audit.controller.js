import { prisma } from '../db.js';
import { parsePagination, buildPaginationMeta } from '../lib/pagination.js';
export const getTenantAuditLog = async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 20);
        const action = req.query.action ? String(req.query.action) : undefined;
        const where = { tenantId: req.params.id };
        if (action)
            where.action = action;
        const [logs, total] = await Promise.all([
            prisma.tenantAuditLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                include: { admin: { select: { id: true, firstName: true, lastName: true, email: true } } },
            }),
            prisma.tenantAuditLog.count({ where }),
        ]);
        return res.status(200).json({
            success: true,
            data: logs,
            meta: buildPaginationMeta(total, page, limit),
        });
    }
    catch (error) {
        console.error('Error fetching tenant audit log:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve audit log',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const getPlatformAuditLog = async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 20);
        const action = req.query.action ? String(req.query.action) : undefined;
        const tenantId = req.query.tenantId ? String(req.query.tenantId) : undefined;
        const where = {};
        if (action)
            where.action = action;
        if (tenantId)
            where.tenantId = tenantId;
        const [logs, total] = await Promise.all([
            prisma.tenantAuditLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                include: {
                    admin: { select: { id: true, firstName: true, lastName: true, email: true } },
                    tenant: { select: { id: true, name: true, subdomain: true } },
                },
            }),
            prisma.tenantAuditLog.count({ where }),
        ]);
        return res.status(200).json({
            success: true,
            data: logs,
            meta: buildPaginationMeta(total, page, limit),
        });
    }
    catch (error) {
        console.error('Error fetching platform audit log:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve audit log',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
