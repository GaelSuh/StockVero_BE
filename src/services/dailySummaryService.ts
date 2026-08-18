import { prisma } from '../db.js';

export async function generateDailySummary(tenantId: string, date: Date, mode?: string) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const whereClause: any = {
    tenantId,
    status: { in: ['COMPLETED', 'PARTIAL'] },
    createdAt: { gte: startOfDay, lte: endOfDay },
  };
  if (mode) whereClause.mode = mode;

  const sales = await prisma.sale.findMany({
    where: whereClause,
    include: { payments: true },
  });

  const returns = await prisma.saleReturn.findMany({
    where: {
      tenantId,
      createdAt: { gte: startOfDay, lte: endOfDay },
    },
  });

  let cashCollected = 0;
  let mobileMoneyCollected = 0;
  let cardCollected = 0;
  let creditGiven = 0;

  for (const sale of sales) {
    creditGiven += Number(sale.amountOwed);
    for (const payment of sale.payments) {
      const amount = Number(payment.amount);
      switch (payment.method) {
        case 'CASH':
          cashCollected += amount;
          break;
        case 'MTN_MOMO':
        case 'ORANGE_MONEY':
          mobileMoneyCollected += amount;
          break;
        case 'CARD':
          cardCollected += amount;
          break;
      }
    }
  }

  const returnsTotal = returns.reduce((sum, r) => sum + Number(r.refundAmount), 0);
  const totalRevenue = sales.reduce((sum, s) => sum + Number(s.totalAmount), 0);

  const summary = await prisma.dailySummary.upsert({
    where: { tenantId_date: { tenantId, date: startOfDay } },
    update: {
      totalSales: sales.length,
      totalRevenue,
      cashCollected,
      mobileMoneyCollected,
      cardCollected,
      creditGiven,
      returnsTotal,
    },
    create: {
      tenantId,
      date: startOfDay,
      totalSales: sales.length,
      totalRevenue,
      cashCollected,
      mobileMoneyCollected,
      cardCollected,
      creditGiven,
      returnsTotal,
    },
  });

  return summary;
}

export async function getDailySummary(tenantId: string, date: Date, mode?: string) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const existing = await prisma.dailySummary.findUnique({
    where: { tenantId_date: { tenantId, date: startOfDay } },
  });

  if (existing && !mode) return existing;
  return generateDailySummary(tenantId, date, mode);
}
