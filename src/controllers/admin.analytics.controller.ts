import { Response } from 'express';
import { prisma } from '../db.js';
import { AdminRequest } from '../types/index.js';
import { MODULE_KEYS } from '../config/modules.js';

function getLast12Months() {
  const months: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const label = date.toLocaleString('en-US', { month: 'short', year: 'numeric' });
    months.push({ key, label });
  }
  return months;
}

export const getGrowthAnalytics = async (req: AdminRequest, res: Response) => {
  try {
    const months = getLast12Months();
    const start = new Date(months[0].key + '-01T00:00:00.000Z');

    const tenants = await prisma.tenant.findMany({
      where: { createdAt: { gte: start } },
      select: { createdAt: true, status: true },
    });

    const byMonth = new Map(
      months.map(m => [
        m.key,
        { month: m.label, count: 0, approved: 0, denied: 0 },
      ]),
    );

    for (const tenant of tenants) {
      const key = `${tenant.createdAt.getFullYear()}-${String(
        tenant.createdAt.getMonth() + 1,
      ).padStart(2, '0')}`;
      const bucket = byMonth.get(key);
      if (!bucket) continue;
      bucket.count += 1;
      if (tenant.status === 'ACTIVE') bucket.approved += 1;
      if (tenant.status === 'INACTIVE') bucket.denied += 1;
    }

    return res.status(200).json({
      success: true,
      data: Array.from(byMonth.values()),
    });
  } catch (error) {
    console.error('Error fetching growth analytics:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load analytics',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getModuleAnalytics = async (req: AdminRequest, res: Response) => {
  try {
    const activeTenants = await prisma.tenant.count({ where: { status: 'ACTIVE' } });
    const moduleKeys = Object.values(MODULE_KEYS).filter(
      key => key !== MODULE_KEYS.SETTINGS && key !== MODULE_KEYS.BILLING,
    );

    // Single groupBy instead of N separate COUNT queries
    const grouped = await prisma.tenantModule.groupBy({
      by: ['moduleKey'],
      where: {
        moduleKey: { in: moduleKeys },
        isEnabled: true,
        tenant: { status: 'ACTIVE' },
      },
      _count: { _all: true },
    });
    const groupedMap: Record<string, number> = {};
    for (const g of grouped) groupedMap[g.moduleKey] = g._count._all;

    const data = moduleKeys.map((moduleKey) => {
      const enabledCount = groupedMap[moduleKey] ?? 0;
      const percentage = activeTenants > 0
        ? Math.round((enabledCount / activeTenants) * 1000) / 10
        : 0;
      return { moduleKey, enabledCount, percentage, totalActiveTenants: activeTenants };
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('Error fetching module analytics:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load analytics',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getPlanAnalytics = async (req: AdminRequest, res: Response) => {
  try {
    const planGroups = await prisma.tenant.groupBy({
      by: ['subscriptionPlan'],
      _count: { _all: true },
    });

    const data = planGroups.map(group => ({
      plan: group.subscriptionPlan,
      count: group._count._all,
    }));

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('Error fetching plan analytics:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load analytics',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getActivityAnalytics = async (req: AdminRequest, res: Response) => {
  try {
    const days = 30;
    const start = new Date();
    start.setDate(start.getDate() - days + 1);
    start.setHours(0, 0, 0, 0);

    const [projects, customers, transactions] = await Promise.all([
      prisma.project.findMany({
        where: { createdAt: { gte: start } },
        select: { createdAt: true },
      }),
      prisma.customer.findMany({
        where: { createdAt: { gte: start } },
        select: { createdAt: true },
      }),
      prisma.transaction.findMany({
        where: { createdAt: { gte: start } },
        select: { createdAt: true },
      }),
    ]);

    const buckets: Map<string, { date: string; projects: number; customers: number; transactions: number }> = new Map();
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, { date: key, projects: 0, customers: 0, transactions: 0 });
    }

    for (const p of projects) {
      const key = p.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(key);
      if (b) b.projects += 1;
    }
    for (const c of customers) {
      const key = c.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(key);
      if (b) b.customers += 1;
    }
    for (const t of transactions) {
      const key = t.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(key);
      if (b) b.transactions += 1;
    }

    return res.status(200).json({
      success: true,
      data: Array.from(buckets.values()),
    });
  } catch (error) {
    console.error('Error fetching activity analytics:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load analytics',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
