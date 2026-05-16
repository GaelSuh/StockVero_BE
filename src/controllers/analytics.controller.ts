import { Response } from 'express';
import PDFDocument from 'pdfkit';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { broadcastToModule } from '../services/notificationService.js';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EXPORTABLE_MODULES = new Set(['crm', 'projects', 'inventory', 'finance']);

const parseDateInput = (value?: unknown) => {
  if (!value || Array.isArray(value)) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const resolveDateRange = (year: number, from?: unknown, to?: unknown) => {
  const fromDate = parseDateInput(from);
  const toDate = parseDateInput(to);

  if (fromDate || toDate) {
    const start = fromDate ?? new Date(0);
    const end = toDate ? new Date(toDate) : new Date();
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  return { start, end };
};

const formatDate = (value?: Date | string | null) => {
  if (!value) return '-';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString();
};

const formatCurrency = (value?: number | null) => {
  if (value === null || value === undefined) return '-';
  return `${Number(value).toLocaleString()} XAF`;
};

export const getAnalyticsOverview = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const year = req.query.year ? parseInt(String(req.query.year), 10) : new Date().getFullYear();
    const { start, end } = resolveDateRange(year, req.query.from, req.query.to);

    const [transactions, projects, customers, materials, inventoryItems, customerRevenueGroups] = await Promise.all([
      prisma.transaction.findMany({
        where: { tenantId, status: 'ACCEPTED', recordedAt: { gte: start, lte: end } },
        select: { type: true, amount: true, recordedAt: true },
      }),
      prisma.project.findMany({
        where: { tenantId, createdAt: { gte: start, lte: end } },
        select: {
          name: true,
          status: true,
          progress: true,
          budget: true,
          spent: true,
          startDate: true,
          createdAt: true,
          customer: { select: { name: true } },
        },
      }),
      prisma.customer.findMany({
        where: { tenantId, createdAt: { gte: start, lte: end } },
        select: { createdAt: true },
      }),
      prisma.projectMaterial.groupBy({
        by: ['name', 'sourceType'],
        where: { tenantId, createdAt: { gte: start, lte: end } },
        _sum: { totalCost: true, quantity: true },
        orderBy: { _sum: { totalCost: 'desc' } },
        take: 10,
      }),
      prisma.inventoryItem.findMany({
        where: { tenantId },
        select: { category: true, quantity: true, lowStockAt: true, status: true, unitCost: true },
      }),
      prisma.transaction.groupBy({
        by: ['entityId'],
        where: {
          tenantId,
          status: 'ACCEPTED',
          type: 'INCOME',
          moduleRef: 'crm',
          entityId: { not: null },
          recordedAt: { gte: start, lte: end },
        },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 10,
      }),
    ]);

    // Monthly performance
    const monthlyMap: Record<number, { income: number; expense: number; projects: number }> = {};
    for (let m = 0; m < 12; m++) {
      monthlyMap[m] = { income: 0, expense: 0, projects: 0 };
    }
    for (const tx of transactions) {
      const m = new Date(tx.recordedAt).getMonth();
      const amt = Number(tx.amount);
      if (tx.type === 'INCOME') monthlyMap[m].income += amt;
      else monthlyMap[m].expense += amt;
    }
    for (const p of projects) {
      const d = p.startDate ?? p.createdAt;
      if (d >= start && d <= end) {
        const m = new Date(d).getMonth();
        monthlyMap[m].projects += 1;
      }
    }
    const monthlyPerformance = MONTH_NAMES.map((name, i) => ({
      month: name,
      income: monthlyMap[i].income,
      expense: monthlyMap[i].expense,
      projects: monthlyMap[i].projects,
    }));

    // Project status
    const statusMap: Record<string, number> = {};
    for (const p of projects) {
      statusMap[p.status] = (statusMap[p.status] ?? 0) + 1;
    }
    const total = projects.length || 1;
    const projectStatus = Object.entries(statusMap).map(([status, count]) => ({
      status,
      count,
      percentage: Math.round((count / total) * 100),
    }));

    // Customer growth (running total within year)
    const customerByMonth: Record<number, number> = {};
    for (const c of customers) {
      const m = new Date(c.createdAt).getMonth();
      customerByMonth[m] = (customerByMonth[m] ?? 0) + 1;
    }
    const allCustomersCount = await prisma.customer.count({ where: { tenantId, createdAt: { lt: start } } });
    let runningTotal = allCustomersCount;
    const customerGrowth = MONTH_NAMES.map((name, i) => {
      const newCount = customerByMonth[i] ?? 0;
      runningTotal += newCount;
      return { month: name, new: newCount, total: runningTotal };
    });

    // Top products — ranked by total cost spent, labelled by sourceType
    const topProducts = materials
      .map((m) => ({
        name: m.name,
        sourceType: (m.sourceType ?? 'EXTERNAL') as string,
        totalCost: Number(m._sum.totalCost ?? 0),
        quantity: Number(m._sum.quantity ?? 0),
      }))
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 5);

    const inventorySummaryMap = new Map<string, {
      category: string;
      totalProducts: number;
      inStock: number;
      lowStock: number;
      totalValue: number;
    }>();

    for (const item of inventoryItems) {
      const category = (item.category ?? 'Uncategorized').trim() || 'Uncategorized';
      const current = inventorySummaryMap.get(category) ?? {
        category,
        totalProducts: 0,
        inStock: 0,
        lowStock: 0,
        totalValue: 0,
      };

      current.totalProducts += 1;
      if (item.status === 'IN_STOCK') current.inStock += 1;
      if (item.status === 'LOW_STOCK') current.lowStock += 1;
      current.totalValue += Number(item.quantity ?? 0) * Number(item.unitCost ?? 0);

      inventorySummaryMap.set(category, current);
    }

    const inventorySummary = Array.from(inventorySummaryMap.values()).sort((a, b) => b.totalValue - a.totalValue);

    const customerRevenueIds = customerRevenueGroups.map((group) => group.entityId).filter((id): id is string => Boolean(id));
    const revenueCustomers = customerRevenueIds.length
      ? await prisma.customer.findMany({
          where: { tenantId, id: { in: customerRevenueIds } },
          select: { id: true, name: true, location: true, status: true },
        })
      : [];
    const revenueCustomerMap = new Map(revenueCustomers.map((customer) => [customer.id, customer]));
    const customerRevenue = customerRevenueGroups.map((group) => {
      const customer = group.entityId ? revenueCustomerMap.get(group.entityId) : null;
      return {
        name: customer?.name ?? 'Unknown Customer',
        location: customer?.location ?? '-',
        status: customer?.status ?? 'ACTIVE',
        revenue: Number(group._sum.amount ?? 0),
      };
    });

    // KPIs
    let totalRevenue = 0;
    let totalExpenses = 0;
    for (const tx of transactions) {
      if (tx.type === 'INCOME') totalRevenue += Number(tx.amount);
      else totalExpenses += Number(tx.amount);
    }
    const totalProfit = totalRevenue - totalExpenses;
    const profitMarginPercent = totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 100 * 10) / 10 : 0;
    const [totalCustomers, activeProjects] = await Promise.all([
      prisma.customer.count({ where: { tenantId } }),
      prisma.project.count({ where: { tenantId, status: 'IN_PROGRESS' } }),
    ]);

    return res.json({
      success: true,
      message: 'Analytics retrieved successfully',
      data: {
        monthlyPerformance,
        projectStatus,
        customerGrowth,
        topProducts,
        inventorySummary,
        projectSummary: projects.map((project) => ({
          name: project.name,
          customer: project.customer?.name ?? '-',
          status: project.status,
          budget: Number(project.budget ?? 0),
          spent: Number(project.spent ?? 0),
          progress: Number(project.progress ?? 0),
        })),
        customerRevenue,
        kpis: { profitMarginPercent, totalRevenue, totalExpenses, totalProfit, totalCustomers, activeProjects },
      },
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve analytics',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const exportAnalyticsPdf = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const year = req.query.year ? parseInt(String(req.query.year), 10) : new Date().getFullYear();
    const { start, end } = resolveDateRange(year, req.query.from, req.query.to);

    const activeModules = req.activeModules ?? [];
    const permissions = req.permissions ?? {};
    const isOwner = req.user?.accountType === 'owner';
    const canRead = (moduleKey: string) => {
      if (isOwner) return activeModules.includes(moduleKey);
      return Boolean(permissions[moduleKey]?.canRead);
    };

    const requestedModules = typeof req.query.modules === 'string'
      ? req.query.modules.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean)
      : [];

    const allowedModules = (requestedModules.length ? requestedModules : Array.from(EXPORTABLE_MODULES))
      .filter((moduleKey) => EXPORTABLE_MODULES.has(moduleKey))
      .filter((moduleKey) => canRead(moduleKey));

    const whereRange = (field: string) => ({
      [field]: { gte: start, lt: end },
    });

    const [
      customers,
      projects,
      inventory,
      transactions,
    ] = await Promise.all([
      allowedModules.includes('crm')
        ? prisma.customer.findMany({
            where: { tenantId, ...whereRange('createdAt') },
            select: { name: true, email: true, phone: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
      allowedModules.includes('projects')
        ? prisma.project.findMany({
            where: { tenantId, ...whereRange('createdAt') },
            select: { name: true, status: true, budget: true, startDate: true, dueDate: true },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
      allowedModules.includes('inventory')
        ? prisma.inventoryItem.findMany({
            where: { tenantId, ...whereRange('createdAt') },
            select: { name: true, sku: true, quantity: true, unitCost: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
      allowedModules.includes('finance')
        ? prisma.transaction.findMany({
            where: { tenantId, status: 'ACCEPTED', ...whereRange('recordedAt') },
            select: { type: true, amount: true, description: true, recordedAt: true },
            orderBy: { recordedAt: 'desc' },
          })
        : Promise.resolve([]),
    ]);

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="analytics-${year}.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).text('Analytics Export');
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`);
    doc.fontSize(10).text(`Range: ${formatDate(start)} - ${formatDate(new Date(end.getTime() - 1))}`);
    doc.moveDown();

    const addSection = (title: string) => {
      doc.fontSize(14).text(title, { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(10);
    };

    if (allowedModules.includes('crm')) {
      addSection('Customers');
      doc.text(`Total customers: ${customers.length}`);
      doc.moveDown(0.5);
      customers.forEach((c) => {
        doc.text(`â€¢ ${c.name} | ${c.email ?? '-'} | ${c.phone ?? '-'} | ${formatDate(c.createdAt)}`);
      });
      if (customers.length === 0) doc.text('No customers in this range.');
      doc.moveDown();
    }

    if (allowedModules.includes('projects')) {
      addSection('Projects');
      doc.text(`Total projects: ${projects.length}`);
      doc.moveDown(0.5);
      projects.forEach((p) => {
        doc.text(`â€¢ ${p.name} | ${p.status} | Budget: ${formatCurrency(Number(p.budget ?? 0))} | Start: ${formatDate(p.startDate)} | Due: ${formatDate(p.dueDate)}`);
      });
      if (projects.length === 0) doc.text('No projects in this range.');
      doc.moveDown();
    }

    if (allowedModules.includes('inventory')) {
      addSection('Inventory');
      doc.text(`Total items: ${inventory.length}`);
      doc.moveDown(0.5);
      inventory.forEach((item) => {
        doc.text(`â€¢ ${item.name} (${item.sku}) | Qty: ${item.quantity} | Unit Cost: ${formatCurrency(Number(item.unitCost ?? 0))} | Added: ${formatDate(item.createdAt)}`);
      });
      if (inventory.length === 0) doc.text('No inventory items in this range.');
      doc.moveDown();
    }

    if (allowedModules.includes('finance')) {
      addSection('Finance');
      const totalRevenue = transactions.filter((t) => t.type === 'INCOME').reduce((sum, t) => sum + Number(t.amount), 0);
      const totalExpenses = transactions.filter((t) => t.type === 'EXPENSE').reduce((sum, t) => sum + Number(t.amount), 0);
      doc.text(`Transactions: ${transactions.length}`);
      doc.text(`Total income: ${formatCurrency(totalRevenue)}`);
      doc.text(`Total expenses: ${formatCurrency(totalExpenses)}`);
      doc.text(`Net: ${formatCurrency(totalRevenue - totalExpenses)}`);
      doc.moveDown(0.5);
      transactions.forEach((t) => {
        doc.text(`â€¢ ${t.type} | ${formatCurrency(Number(t.amount))} | ${t.description ?? '-'} | ${formatDate(t.recordedAt)}`);
      });
      if (transactions.length === 0) doc.text('No transactions in this range.');
      doc.moveDown();
    }

    if (allowedModules.length === 0) {
      doc.text('No exportable modules selected or available for this user.');
    }

    doc.end();

    // Notify authorized users
    await broadcastToModule(tenantId, 'analytics', {
      type: 'analytics.export.requested',
      title: 'Analytics Data Exported',
      message: `A report has been generated for the period: ${formatDate(start)} - ${formatDate(new Date(end.getTime() - 1))}.`,
      link: '/analytics',
    });

    return;
  } catch (error) {
    console.error('Error exporting analytics:', error);
    return res.status(500).json({
      success: false,
      message: 'Export failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
