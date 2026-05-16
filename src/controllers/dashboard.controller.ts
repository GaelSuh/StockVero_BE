import { Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';

export const getStats = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const activeModules = req.activeModules ?? [];
    const permissions = req.permissions ?? {};
    const isOwner = req.user?.accountType === 'owner';

    const canRead = (moduleKey: string) => {
      if (isOwner) return activeModules.includes(moduleKey);
      const perm = permissions[moduleKey];
      return Boolean(perm?.canRead);
    };

    const crmEnabled = canRead('crm');
    const projectsEnabled = canRead('projects');
    const inventoryEnabled = canRead('inventory');
    const financeEnabled = canRead('finance');

    const [
      customerCount,
      activeProjectsCount,
      lowStockItems,
      recentProjects,
      summary,
      inventoryValue,
      bestSellingProducts,
    ] = await Promise.all([
      crmEnabled
        ? prisma.customer.count({ where: { tenantId } })
        : Promise.resolve(0),
      projectsEnabled
        ? prisma.project.count({
            where: {
              tenantId,
              status: { in: ['PENDING', 'IN_PROGRESS', 'TESTING'] },
            },
          })
        : Promise.resolve(0),
      inventoryEnabled
        ? (async () => {
            const categories = await (prisma as any).inventoryCategory.findMany({
              where: { tenantId, reorderThreshold: { gt: 0 } },
              select: { id: true, name: true, type: true, reorderThreshold: true },
            });
            if (categories.length === 0) return [];

            const categoryIds = categories.map((c: any) => c.id);
            // Single groupBy for STOCK AVAILABLE counts
            const stockCounts = await (prisma as any).productItem.groupBy({
              by: ['categoryId'],
              where: { tenantId, categoryId: { in: categoryIds }, stockStatus: 'AVAILABLE' },
              _count: { id: true },
            });
            // Single groupBy for INVENTORY AVAILABLE counts
            const invCounts = await (prisma as any).productItem.groupBy({
              by: ['categoryId'],
              where: { tenantId, categoryId: { in: categoryIds }, inventoryStatus: 'AVAILABLE' },
              _count: { id: true },
            });

            const countMap: Record<string, number> = {};
            for (const g of stockCounts) countMap[g.categoryId] = g._count.id;
            for (const g of invCounts) countMap[g.categoryId] = (countMap[g.categoryId] ?? 0) + g._count.id;

            return categories
              .map((cat: any) => {
                const available = cat.type === 'INVENTORY'
                  ? (invCounts.find((g: any) => g.categoryId === cat.id)?._count?.id ?? 0)
                  : (stockCounts.find((g: any) => g.categoryId === cat.id)?._count?.id ?? 0);
                return { id: cat.id, name: cat.name, type: cat.type, available, reorderThreshold: cat.reorderThreshold };
              })
              .filter((r: any) => r.available <= r.reorderThreshold)
              .sort((a: any, b: any) => a.available - b.available)
              .slice(0, 10);
          })()
        : Promise.resolve([]),
      projectsEnabled
        ? prisma.project.findMany({
            where: { tenantId },
            include: { customer: { select: { name: true } } },
            orderBy: { createdAt: 'desc' },
            take: 3,
          })
        : Promise.resolve([]),
      financeEnabled
        ? getFinancialSummary(tenantId)
        : Promise.resolve({ monthlyNet: 0 }),
      inventoryEnabled
        ? (async () => {
            const categories = await (prisma as any).inventoryCategory.findMany({
              where: { tenantId },
              select: { id: true, type: true, sellingPrice: true, costPrice: true },
            });
            if (categories.length === 0) return 0;

            const categoryIds = categories.map((c: any) => c.id);
            // Two groupBy queries instead of N individual counts
            const [stockAvail, invAvail] = await Promise.all([
              (prisma as any).productItem.groupBy({
                by: ['categoryId'],
                where: { tenantId, categoryId: { in: categoryIds }, stockStatus: 'AVAILABLE' },
                _count: { id: true },
              }),
              (prisma as any).productItem.groupBy({
                by: ['categoryId'],
                where: { tenantId, categoryId: { in: categoryIds }, inventoryStatus: 'AVAILABLE' },
                _count: { id: true },
              }),
            ]);

            const countMap: Record<string, number> = {};
            for (const g of stockAvail) countMap[g.categoryId] = g._count.id;
            for (const g of invAvail) countMap[g.categoryId] = g._count.id;

            let total = 0;
            for (const cat of categories) {
              const count = countMap[cat.id] ?? 0;
              const unitPrice = Number(cat.sellingPrice ?? cat.costPrice ?? 0);
              total += count * unitPrice;
            }
            return total;
          })()
        : Promise.resolve(0),
      inventoryEnabled
        ? (async () => {
            // Best selling = STOCK categories with the most DEPLOYED units
            const groups = await (prisma as any).productItem.groupBy({
              by: ['categoryId'],
              where: {
                tenantId,
                stockStatus: 'DEPLOYED',
              },
              _count: { id: true },
              orderBy: { _count: { id: 'desc' } },
              take: 5,
            });
            if (groups.length === 0) return [];
            const categoryIds = groups.map((g: any) => g.categoryId);
            const cats = await (prisma as any).inventoryCategory.findMany({
              where: { id: { in: categoryIds }, type: 'STOCK' },
              select: { id: true, name: true },
            });
            const catMap: Record<string, string> = {};
            for (const c of cats) catMap[c.id] = c.name;
            return groups
              .filter((g: any) => catMap[g.categoryId])
              .map((g: any) => ({
                name: catMap[g.categoryId],
                sales: g._count.id,
              }));
          })()
        : Promise.resolve([]),
    ]);

    const applyOverdue = (status: string, dueDate?: Date | null) => {
      if (status === 'COMPLETED' || status === 'CANCELLED') return status;
      if (dueDate && dueDate.getTime() < Date.now()) return 'OVERDUE';
      return status;
    };

    const recentProjectsWithStatus = recentProjects.map((project) => ({
      ...project,
      status: applyOverdue(project.status, project.dueDate),
    }));

    return res.json({
      success: true,
      message: 'Dashboard stats retrieved successfully',
      data: {
        stats: {
          totalCustomers: customerCount,
          activeProjects: activeProjectsCount,
          inventoryValue,
          monthlyNet: Number(summary.monthlyNet),
        },
        lowStockAlerts: lowStockItems,
        recentProjects: recentProjectsWithStatus,
        bestSellingProducts,
      },
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve dashboard stats',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

async function getFinancialSummary(tenantId: string) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [monthlyIncome, monthlyExpense] = await Promise.all([
    prisma.transaction.aggregate({
      where: {
        tenantId,
        type: 'INCOME',
        status: 'ACCEPTED',
        recordedAt: { gte: monthStart },
      },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: {
        tenantId,
        type: 'EXPENSE',
        status: 'ACCEPTED',
        recordedAt: { gte: monthStart },
      },
      _sum: { amount: true },
    }),
  ]);

  const income = Number(monthlyIncome._sum.amount ?? 0);
  const expense = Number(monthlyExpense._sum.amount ?? 0);

  return {
    monthlyNet: income - expense,
  };
}
