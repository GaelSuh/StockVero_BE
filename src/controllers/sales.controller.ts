import { Response } from 'express';
import { prisma } from '../db.js';
import { resolvePersonName, backfillPersonName } from '../lib/personName.js';
import { AuthRequest } from '../types/index.js';
import { getNextSaleNumber } from '../services/saleService.js';
import { recordSaleAsIncome } from '../services/saleFinanceService.js';
import { deductStockForSale, validateStockAvailability } from '../services/saleInventoryService.js';
import { resolvePrice } from '../services/priceResolutionService.js';

export async function createSale(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const user = req.user!;
    const {
      mode,
      customerId,
      customerName,
      items,
      payments,
      discountType,
      discountValue,
      notes,
      creditDueDate,
    } = req.body;

    if (!items?.length) {
      return res.status(400).json({ success: false, message: 'At least one item is required' });
    }
    if (!mode || !['RETAIL', 'WHOLESALE'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'Invalid sale mode' });
    }

    // One read for the whole cart. Quantities are summed per product first, so a
    // cart holding two serialised units of the same model is checked against the
    // total it actually needs rather than one line at a time.
    const requestedByCategory = new Map<string, number>();
    for (const item of items) {
      requestedByCategory.set(
        item.categoryId,
        (requestedByCategory.get(item.categoryId) ?? 0) + item.quantity,
      );
    }
    const stockRows = await prisma.inventoryCategory.findMany({
      where: { tenantId, id: { in: [...requestedByCategory.keys()] } },
      select: {
        id: true,
        name: true,
        plannedQty: true,
        quantityOnHand: true,
        stockTrackingMode: true,
      },
    });
    for (const row of stockRows) {
      const requested = requestedByCategory.get(row.id) ?? 0;
      const currentStock =
        row.stockTrackingMode === 'QUANTITY' ? row.quantityOnHand : row.plannedQty;
      if (currentStock < requested) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for "${row.name}". Available: ${currentStock}, Requested: ${requested}`,
        });
      }
    }

    // A sale created offline carries the id the device generated for it. If the
    // response to an earlier attempt never arrived, the retry lands here and gets
    // the original sale back instead of creating a second one.
    const offlineId: string | undefined = (req.body as any).offlineId || undefined;
    if (offlineId) {
      const already = await prisma.sale.findFirst({
        where: { tenantId, offlineId },
        include: { items: true, payments: true, customer: true },
      });
      if (already) {
        return res.status(200).json({
          success: true,
          message: 'Sale already recorded',
          data: already,
        });
      }
    }

    // Who sold this, by name — looked up once, before the transaction opens.
    const sellerType: 'OWNER' | 'EMPLOYEE' =
      user.accountType === 'owner' ? 'OWNER' : 'EMPLOYEE';
    const sellerName = await resolvePersonName(user.id, sellerType);

    const sale = await prisma.$transaction(async (tx: any) => {
      const saleNumber = await getNextSaleNumber(tenantId, tx);

      let subtotal = 0;
      const saleItems: any[] = [];
      for (const item of items) {
        let unitPrice = item.unitPrice;
        if (mode === 'WHOLESALE' && customerId) {
          unitPrice = await resolvePrice(tenantId, item.categoryId, customerId, item.quantity);
        }
        const itemDiscount = item.discountType === 'PERCENTAGE'
          ? (unitPrice * item.quantity * (item.discountValue || 0)) / 100
          : (item.discountValue || 0);
        const lineTotal = unitPrice * item.quantity - itemDiscount;
        subtotal += lineTotal;
        saleItems.push({
          categoryId: item.categoryId,
          productName: item.productName,
          sku: item.sku || null,
          unitPrice,
          quantity: item.quantity,
          discountType: item.discountType || null,
          discountValue: item.discountValue || null,
          discountAmount: itemDiscount,
          lineTotal,
          batchNumber: item.batchNumber || null,
          lotNumber: item.lotNumber || null,
        });
      }

      const saleDiscountAmount = discountType === 'PERCENTAGE'
        ? (subtotal * (discountValue || 0)) / 100
        : (discountValue || 0);
      const totalAmount = subtotal - saleDiscountAmount;

      const totalPaid = payments?.reduce((sum: number, p: any) => sum + p.amount, 0) || 0;
      const amountOwed = Math.max(0, totalAmount - totalPaid);
      let paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' = 'PAID';
      if (totalPaid <= 0) paymentStatus = 'CREDIT';
      else if (amountOwed > 0) paymentStatus = 'PARTIAL';

      const resolvedCustomerName = customerName || (customerId ? undefined : 'Walk-in Customer');

      const createdSale = await tx.sale.create({
        data: {
          tenantId,
          saleNumber,
          offlineId: offlineId ?? null,
          mode,
          status: 'COMPLETED',
          customerId: customerId || null,
          customerName: resolvedCustomerName || null,
          soldById: user.id,
          soldByType: sellerType,
          // Resolved from the database, not from the request body or a token
          // field that is not always populated — both produced blank "Sold by".
          soldByName: sellerName,
          subtotal,
          discountType: discountType || null,
          discountValue: discountValue || null,
          discountAmount: saleDiscountAmount,
          taxAmount: 0,
          totalAmount,
          paymentStatus,
          amountPaid: totalPaid,
          amountOwed,
          creditDueDate: creditDueDate ? new Date(creditDueDate) : null,
          notes: notes || null,
          items: { create: saleItems },
          payments: payments?.length ? {
            create: payments.map((p: any) => ({
              method: p.method,
              amount: p.amount,
              reference: p.reference || null,
              recordedById: user.id,
              recordedByName: sellerName,
            })),
          } : undefined,
        },
        include: { items: true, payments: true, customer: true },
      });

      // The server checks stock at this moment rather than trusting whatever the
      // device last saw. Anything oversold is reported, never rejected.
      const stockConflicts = await deductStockForSale(
        tx,
        saleItems.map((i: any) => ({ categoryId: i.categoryId, quantity: i.quantity, productName: i.productName })),
        saleNumber,
        tenantId,
        user.id,
      );

      // The income transaction is written after the sale because it references
      // the sale number, which costs one extra update to link them back up.
      const transactionId = await recordSaleAsIncome(tx, createdSale, tenantId);
      await tx.sale.update({ where: { id: createdSale.id }, data: { transactionId } });

      return { ...createdSale, transactionId, stockConflicts };
    },
    {
      // A sale is a dozen or so sequential writes, and the database is a managed
      // Postgres in another region — at 300ms a round trip that alone exceeds
      // Prisma's 5s default. Losing a completed sale to a timeout is the worst
      // outcome available, so the ceiling is generous.
      timeout: 30_000,
      maxWait: 10_000,
    });

    const { stockConflicts, ...saleData } = sale as any;
    return res.status(201).json({
      success: true,
      message: 'Sale created',
      data: {
        ...saleData,
        // Present only when the sale went past the recorded stock, so a device
        // syncing offline sales can show the owner what needs recounting.
        conflict: stockConflicts?.length
          ? {
              type: 'STOCK_OVERSOLD',
              message: `Sold more than the recorded stock of ${stockConflicts
                .map((c: any) => c.productName)
                .join(', ')}. The sale was kept — please recount.`,
              details: stockConflicts,
            }
          : undefined,
      },
    });
  } catch (error) {
    console.error('Error creating sale:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create sale',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export async function listSales(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const mode = req.query.mode as string | undefined;
    const status = req.query.status as string | undefined;
    const customerId = req.query.customerId as string | undefined;
    const from = req.query.from ? new Date(req.query.from as string) : undefined;
    const to = req.query.to ? new Date(req.query.to as string) : undefined;
    const search = req.query.search as string | undefined;

    const where: any = { tenantId };
    if (mode) where.mode = mode;
    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }
    if (search) {
      where.OR = [
        { saleNumber: { contains: search, mode: 'insensitive' } },
        { soldByName: { contains: search, mode: 'insensitive' } },
        { customerName: { contains: search, mode: 'insensitive' } },
        { customer: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [sales, total] = await Promise.all([
      prisma.sale.findMany({
        where,
        include: { customer: { select: { id: true, name: true } }, _count: { select: { items: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.sale.count({ where }),
    ]);

    return res.json({
      success: true,
      data: sales,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error listing sales:', error);
    return res.status(500).json({ success: false, message: 'Failed to list sales' });
  }
}

export async function getSale(req: AuthRequest, res: Response) {
  try {
    const sale = await prisma.sale.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: {
        items: { include: { category: { select: { id: true, name: true, sku: true, imageUrl: true } } } },
        payments: true,
        returns: { include: { items: true } },
        customer: true,
        saleDeliveryNotes: { include: { items: true } },
      },
    });
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });

    // Sales recorded before the name was resolved properly have a blank seller.
    // Fill it in on the way out so old receipts still say who sold what.
    const soldByName = await backfillPersonName(
      sale.soldByName,
      sale.soldById,
      sale.soldByType as 'OWNER' | 'EMPLOYEE',
    );

    return res.json({
      success: true,
      data: {
        ...sale,
        soldByName,
        payments: sale.payments.map((payment) => ({
          ...payment,
          recordedByName: payment.recordedByName?.trim() ? payment.recordedByName : soldByName,
        })),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get sale' });
  }
}

export async function updateSale(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const saleId = req.params.id;

    const existing = await prisma.sale.findFirst({
      where: { id: saleId, tenantId },
      include: { items: true },
    });
    if (!existing) return res.status(404).json({ success: false, message: 'Sale not found' });

    if (existing.status === 'CANCELLED' || existing.status === 'RETURNED') {
      return res.status(400).json({ success: false, message: 'Cannot update a cancelled or returned sale' });
    }

    const {
      customerName,
      customerId,
      notes,
      discountType,
      discountValue,
      items,
    } = req.body;

    const updateData: any = {};
    if (customerName !== undefined) updateData.customerName = customerName || null;
    if (customerId !== undefined) updateData.customerId = customerId || null;
    if (notes !== undefined) updateData.notes = notes || null;

    if (items?.length) {
      await prisma.saleItem.deleteMany({ where: { saleId } });

      let subtotal = 0;
      const newItems = items.map((item: any) => {
        const itemDiscount = item.discountType === 'PERCENTAGE'
          ? (item.unitPrice * item.quantity * (item.discountValue || 0)) / 100
          : (item.discountValue || 0);
        const lineTotal = item.unitPrice * item.quantity - itemDiscount;
        subtotal += lineTotal;
        return {
          saleId,
          categoryId: item.categoryId,
          productName: item.productName,
          sku: item.sku || null,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          discountType: item.discountType || null,
          discountValue: item.discountValue || null,
          discountAmount: itemDiscount,
          lineTotal,
          batchNumber: item.batchNumber || null,
          lotNumber: item.lotNumber || null,
        };
      });

      await prisma.saleItem.createMany({ data: newItems });

      const saleDiscountAmount = (discountType ?? existing.discountType) === 'PERCENTAGE'
        ? (subtotal * ((discountValue ?? Number(existing.discountValue)) || 0)) / 100
        : ((discountValue ?? Number(existing.discountValue)) || 0);
      const totalAmount = subtotal - saleDiscountAmount;

      updateData.subtotal = subtotal;
      updateData.totalAmount = totalAmount;
      updateData.discountAmount = saleDiscountAmount;
      updateData.amountOwed = Math.max(0, totalAmount - Number(existing.amountPaid));
      if (updateData.amountOwed <= 0) updateData.paymentStatus = 'PAID';
      else if (Number(existing.amountPaid) > 0) updateData.paymentStatus = 'PARTIAL';
    }

    if (discountType !== undefined) updateData.discountType = discountType || null;
    if (discountValue !== undefined) updateData.discountValue = discountValue || null;

    const updated = await prisma.sale.update({
      where: { id: saleId },
      data: updateData,
      include: { items: true, payments: true, customer: true },
    });

    return res.json({ success: true, message: 'Sale updated', data: updated });
  } catch (error) {
    console.error('Error updating sale:', error);
    return res.status(500).json({ success: false, message: 'Failed to update sale' });
  }
}

export async function addPaymentToSale(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const user = req.user!;
    const { method, amount, reference } = req.body;

    if (!method || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Method and positive amount required' });
    }

    const sale = await prisma.sale.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
    if (Number(sale.amountOwed) <= 0) {
      return res.status(400).json({ success: false, message: 'Sale is already fully paid' });
    }

    const paymentAmount = Math.min(amount, Number(sale.amountOwed));
    const newAmountPaid = Number(sale.amountPaid) + paymentAmount;
    const newAmountOwed = Number(sale.totalAmount) - newAmountPaid;
    const newStatus = newAmountOwed <= 0 ? 'PAID' : 'PARTIAL';

    await prisma.$transaction(async (tx: any) => {
      await tx.salePayment.create({
        data: {
          saleId: sale.id,
          method,
          amount: paymentAmount,
          reference: reference || null,
          recordedById: user.id,
          recordedByName: user.email,
        },
      });

      await tx.sale.update({
        where: { id: sale.id },
        data: { amountPaid: newAmountPaid, amountOwed: Math.max(0, newAmountOwed), paymentStatus: newStatus },
      });
    });

    return res.json({ success: true, message: 'Payment recorded', data: { amountPaid: newAmountPaid, amountOwed: Math.max(0, newAmountOwed), paymentStatus: newStatus } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to record payment' });
  }
}

export async function getDailySalesSummary(req: AuthRequest, res: Response) {
  try {
    const { getDailySummary } = await import('../services/dailySummaryService.js');
    const date = req.query.date ? new Date(req.query.date as string) : new Date();
    const mode = req.query.mode as string | undefined || req.baseUrl?.includes('wholesale') ? 'WHOLESALE' : 'RETAIL';
    const summary = await getDailySummary(req.tenantId!, date, mode);
    return res.json({ success: true, data: summary });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get daily summary' });
  }
}

export async function getCreditCustomersController(req: AuthRequest, res: Response) {
  try {
    const { getCreditCustomers } = await import('../services/creditService.js');
    const data = await getCreditCustomers(req.tenantId!);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get credit customers' });
  }
}

export async function resolvePricesController(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const { customerId, items } = req.body;

    if (!items?.length) {
      return res.status(400).json({ success: false, message: 'Items are required' });
    }

    const resolved = await Promise.all(
      items.map(async (item: { categoryId: string; quantity: number }) => ({
        categoryId: item.categoryId,
        unitPrice: await resolvePrice(tenantId, item.categoryId, customerId || null, item.quantity || 1),
      })),
    );

    return res.json({ success: true, data: resolved });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to resolve prices' });
  }
}

export async function cloneSaleController(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const saleId = req.params.id;

    const sale = await prisma.sale.findFirst({
      where: { id: saleId, tenantId },
      include: { items: true, customer: true },
    });

    if (!sale) {
      return res.status(404).json({ success: false, message: 'Sale not found' });
    }

    const clonedItems = sale.items.map((item) => ({
      categoryId: item.categoryId,
      productName: item.productName,
      sku: item.sku,
      unitPrice: Number(item.unitPrice),
      quantity: item.quantity,
    }));

    return res.json({
      success: true,
      data: {
        mode: sale.mode,
        customerId: sale.customerId,
        customerName: sale.customer?.name || sale.customerName,
        items: clonedItems,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to clone sale' });
  }
}
