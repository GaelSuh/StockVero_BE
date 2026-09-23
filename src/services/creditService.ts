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

  // Shape matches what the frontend (CreditCustomer in api/sales.ts) actually
  // reads — customerId/customerName flattened, not nested under `customer`.
  // The nested shape this used to return meant `c.customerId` was undefined
  // for every row, so every list row rendered with the same undefined React
  // key and every customer name/last-purchase-date on screen was blank.
  const customerMap = new Map<string, {
    customerId: string;
    customerName: string;
    totalOwed: number;
    salesCount: number;
    lastPurchaseDate: Date;
  }>();

  for (const sale of sales) {
    if (!sale.customer) continue;
    const existing = customerMap.get(sale.customerId!);
    if (existing) {
      existing.totalOwed += Number(sale.amountOwed);
      existing.salesCount += 1;
      // Sales are fetched newest-first, so the first one seen per customer
      // already is the most recent — this only guards against that order
      // assumption ever changing.
      if (sale.createdAt > existing.lastPurchaseDate) {
        existing.lastPurchaseDate = sale.createdAt;
      }
    } else {
      customerMap.set(sale.customerId!, {
        customerId: sale.customer.id,
        customerName: sale.customer.name,
        totalOwed: Number(sale.amountOwed),
        salesCount: 1,
        lastPurchaseDate: sale.createdAt,
      });
    }
  }

  return Array.from(customerMap.values()).sort((a, b) => b.totalOwed - a.totalOwed);
}

/**
 * Every line item this customer has ever actually bought, across both retail
 * and wholesale, any payment status — a purchase history, not a debt list
 * (see getCustomerCreditSales for that). Read at the SaleItem level rather
 * than the sale level, since "what did they buy" means individual products,
 * not just sale totals.
 */
export async function getCustomerPurchaseHistory(tenantId: string, customerId: string) {
  const sales = await prisma.sale.findMany({
    where: { tenantId, customerId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      saleNumber: true,
      mode: true,
      createdAt: true,
      items: {
        select: {
          id: true,
          productName: true,
          quantity: true,
          unitPrice: true,
          lineTotal: true,
        },
      },
    },
  });

  return sales.flatMap((sale) =>
    sale.items.map((item) => ({
      id: item.id,
      saleId: sale.id,
      saleNumber: sale.saleNumber,
      mode: sale.mode,
      date: sale.createdAt,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      lineTotal: Number(item.lineTotal),
    })),
  );
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
      mode: true,
      totalAmount: true,
      amountPaid: true,
      amountOwed: true,
      paymentStatus: true,
      creditDueDate: true,
      createdAt: true,
    },
  });
}
