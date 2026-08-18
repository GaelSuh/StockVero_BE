import { prisma } from '../db.js';

export async function getCreditCustomers(tenantId: string) {
  const sales = await prisma.sale.findMany({
    where: {
      tenantId,
      paymentStatus: { in: ['CREDIT', 'PARTIAL'] },
      amountOwed: { gt: 0 },
    },
    include: {
      customer: { select: { id: true, name: true, phone: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const customerMap = new Map<string, {
    customer: { id: string; name: string; phone: string | null; email: string | null };
    totalOwed: number;
    salesCount: number;
    oldestDueDate: Date | null;
  }>();

  for (const sale of sales) {
    if (!sale.customer) continue;
    const existing = customerMap.get(sale.customerId!);
    if (existing) {
      existing.totalOwed += Number(sale.amountOwed);
      existing.salesCount += 1;
      if (sale.creditDueDate && (!existing.oldestDueDate || sale.creditDueDate < existing.oldestDueDate)) {
        existing.oldestDueDate = sale.creditDueDate;
      }
    } else {
      customerMap.set(sale.customerId!, {
        customer: sale.customer,
        totalOwed: Number(sale.amountOwed),
        salesCount: 1,
        oldestDueDate: sale.creditDueDate,
      });
    }
  }

  return Array.from(customerMap.values()).sort((a, b) => b.totalOwed - a.totalOwed);
}

export async function getCustomerCreditSales(tenantId: string, customerId: string) {
  return prisma.sale.findMany({
    where: {
      tenantId,
      customerId,
      paymentStatus: { in: ['CREDIT', 'PARTIAL'] },
      amountOwed: { gt: 0 },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      saleNumber: true,
      totalAmount: true,
      amountPaid: true,
      amountOwed: true,
      creditDueDate: true,
      createdAt: true,
    },
  });
}
