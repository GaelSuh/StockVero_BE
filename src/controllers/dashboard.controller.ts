import { Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { getAvailableStock } from '../lib/stock.js';

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
    const retailEnabled = canRead('retail_sales');
    const wholesaleEnabled = canRead('wholesale_sales');
    const salesEnabled = retailEnabled || wholesaleEnabled;

    const [
      customerCount,
      activeProjectsCount,
      lowStockItems,
      recentProjects,
      summary,
      inventoryValue,
      bestSellingProducts,
      retailStats,
      wholesaleStats,
      recentSales,
      salesChartData,
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
              select: {
                id: true,
                name: true,
                type: true,
                reorderThreshold: true,
                stockTrackingMode: true,
                quantityOnHand: true,
              },
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
                const units = cat.type === 'INVENTORY'
                  ? (invCounts.find((g: any) => g.categoryId === cat.id)?._count?.id ?? 0)
                  : (stockCounts.find((g: any) => g.categoryId === cat.id)?._count?.id ?? 0);
                // Quantity-tracked products have no unit rows to count.
                const available = getAvailableStock(cat, units);
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
      // Retail sales stats (today)
      retailEnabled
        ? getSalesTodayStats(tenantId, 'RETAIL')
        : Promise.resolve({ count: 0, revenue: 0, credit: 0 }),
      // Wholesale sales stats (today)
      wholesaleEnabled
        ? getSalesTodayStats(tenantId, 'WHOLESALE')
        : Promise.resolve({ count: 0, revenue: 0, credit: 0 }),
      // Recent sales (last 5)
      salesEnabled
        ? (prisma as any).sale.findMany({
            where: {
              tenantId,
              ...(retailEnabled && wholesaleEnabled
                ? {}
                : { mode: retailEnabled ? 'RETAIL' : 'WHOLESALE' }),
            },
            select: {
              id: true,
              saleNumber: true,
              mode: true,
              customerName: true,
              totalAmount: true,
              paymentStatus: true,
              createdAt: true,
              customer: { select: { name: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 5,
          })
        : Promise.resolve([]),
      // Sales chart data (last 7 days, daily revenue by mode)
      salesEnabled
        ? getSalesChartData(tenantId, retailEnabled, wholesaleEnabled)
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
          retailSalesToday: retailStats.count,
          retailRevenueToday: retailStats.revenue,
          retailCreditOutstanding: retailStats.credit,
          wholesaleSalesToday: wholesaleStats.count,
          wholesaleRevenueToday: wholesaleStats.revenue,
          wholesaleCreditOutstanding: wholesaleStats.credit,
        },
        lowStockAlerts: lowStockItems,
        recentProjects: recentProjectsWithStatus,
        bestSellingProducts,
        recentSales: recentSales.map((s: any) => ({
          id: s.id,
          saleNumber: s.saleNumber,
          mode: s.mode,
          customerName: s.customer?.name ?? s.customerName ?? null,
          totalAmount: Number(s.totalAmount),
          paymentStatus: s.paymentStatus,
          createdAt: s.createdAt,
        })),
        salesChartData,
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

async function getSalesTodayStats(tenantId: string, mode: 'RETAIL' | 'WHOLESALE') {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [countAndRevenue, creditOutstanding] = await Promise.all([
    (prisma as any).sale.aggregate({
      where: {
        tenantId,
        mode,
        createdAt: { gte: todayStart },
      },
      _count: { id: true },
      _sum: { totalAmount: true },
    }),
    (prisma as any).sale.aggregate({
      where: {
        tenantId,
        mode,
        paymentStatus: { in: ['CREDIT', 'PARTIAL'] },
      },
      _sum: { amountOwed: true },
    }),
  ]);

  return {
    count: countAndRevenue._count.id ?? 0,
    revenue: Number(countAndRevenue._sum.totalAmount ?? 0),
    credit: Number(creditOutstanding._sum.amountOwed ?? 0),
  };
}

async function getSalesChartData(
  tenantId: string,
  retailEnabled: boolean,
  wholesaleEnabled: boolean,
) {
  const days = 7;
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - (days - 1));
  startDate.setHours(0, 0, 0, 0);

  const sales = await (prisma as any).sale.findMany({
    where: {
      tenantId,
      createdAt: { gte: startDate },
      ...(retailEnabled && wholesaleEnabled
        ? {}
        : { mode: retailEnabled ? 'RETAIL' : 'WHOLESALE' }),
    },
    select: {
      mode: true,
      totalAmount: true,
      createdAt: true,
    },
  });

  // Bucket by the shop's own calendar day, not by UTC. The window starts at local
  // midnight, so converting to an ISO string here shifted every key back a day in
  // any timezone ahead of UTC — which silently dropped today's sales, the ones a
  // shop owner most wants to see.
  const dayKey = (date: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };

  const chartMap: Record<string, { retail: number; wholesale: number; count: number }> = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    chartMap[dayKey(d)] = { retail: 0, wholesale: 0, count: 0 };
  }

  for (const sale of sales) {
    const key = dayKey(new Date(sale.createdAt));
    if (!chartMap[key]) continue;
    chartMap[key].count++;
    if (sale.mode === 'RETAIL') {
      chartMap[key].retail += Number(sale.totalAmount);
    } else {
      chartMap[key].wholesale += Number(sale.totalAmount);
    }
  }

  return Object.entries(chartMap).map(([date, data]) => ({
    date,
    retail: data.retail,
    wholesale: data.wholesale,
    count: data.count,
  }));
}
