import { Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';

// GET /api/v1/audit
export const listAuditLogs = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const page = req.query.page ? Math.max(1, parseInt(req.query.page as string, 10)) : 1;
    const limit = req.query.limit ? Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10))) : 25;
    const skip = (page - 1) * limit;

    const module = req.query.module ? String(req.query.module) : undefined;
    const action = req.query.action ? String(req.query.action) : undefined;
    const actorId = req.query.actorId ? String(req.query.actorId) : undefined;
    const actorType = req.query.actorType ? String(req.query.actorType) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;

    const where: any = { tenantId };
    if (module) where.module = module;
    if (action) where.action = action;
    if (actorId) where.actorId = actorId;
    if (actorType) where.actorType = actorType;
    if (status) where.status = status;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }
    if (search) {
      where.OR = [
        { action: { contains: search, mode: 'insensitive' } },
        { actorName: { contains: search, mode: 'insensitive' } },
        { entityLabel: { contains: search, mode: 'insensitive' } },
        { entityType: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [logs, total] = await Promise.all([
      (prisma as any).auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      (prisma as any).auditLog.count({ where }),
    ]);

    return res.json({
      success: true,
      data: logs,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error listing audit logs:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve audit logs' });
  }
};

// GET /api/v1/audit/summary
export const getAuditSummary = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [totalEntries, todayEntries, failureCount, topActorsRaw, topModulesRaw] = await Promise.all([
      (prisma as any).auditLog.count({ where: { tenantId } }),
      (prisma as any).auditLog.count({ where: { tenantId, createdAt: { gte: todayStart } } }),
      (prisma as any).auditLog.count({ where: { tenantId, status: 'FAILURE' } }),
      (prisma as any).auditLog.groupBy({
        by: ['actorName', 'actorId'],
        where: { tenantId, actorName: { not: null } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
      (prisma as any).auditLog.groupBy({
        by: ['module'],
        where: { tenantId },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
    ]);

    const topActors = topActorsRaw.map((r: any) => ({ actorName: r.actorName, actorId: r.actorId, count: r._count.id }));
    const topModules = topModulesRaw.map((r: any) => ({ module: r.module, count: r._count.id }));

    return res.json({
      success: true,
      data: { totalEntries, todayEntries, failureCount, topActors, topModules },
    });
  } catch (error) {
    console.error('Error getting audit summary:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve audit summary' });
  }
};

// GET /api/v1/audit/actions
export const getAuditActions = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const actions = await (prisma as any).auditLog.findMany({
      where: { tenantId },
      select: { action: true },
      distinct: ['action'],
      orderBy: { action: 'asc' },
    });
    return res.json({ success: true, data: actions.map((a: any) => a.action) });
  } catch (error) {
    console.error('Error getting audit actions:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve audit actions' });
  }
};
