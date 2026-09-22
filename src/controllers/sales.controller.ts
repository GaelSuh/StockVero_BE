import { Response } from 'express';
import { prisma } from '../db.js';
import { resolvePersonName, backfillPersonName } from '../lib/personName.js';
import { AuthRequest } from '../types/index.js';
import { getNextSaleNumber } from '../services/saleService.js';
import { recordSaleAsIncome, recordSaleTipAsIncome } from '../services/saleFinanceService.js';
import { deductStockForSale, validateStockAvailability, InsufficientStockError } from '../services/saleInventoryService.js';
import { resolvePricesForSale } from '../services/priceResolutionService.js';
import { findOrCreateCreditCustomer } from '../services/creditCustomerService.js';

/**
 * Mirrors `enum SalePaymentMethod` in schema.prisma. The frontend keeps the same
 * list in src/lib/paymentMethods.ts — they must be changed together.
 */
const SALE_PAYMENT_METHODS = ['CASH', 'MTN_MOMO', 'ORANGE_MONEY', 'CARD', 'BANK_TRANSFER', 'OTHER'] as const;

/** Not a payment: marks the unpaid remainder, never stored as a SalePayment row. */
const CREDIT_MARKER = 'CREDIT';

export async function createSale(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const user = req.user!;
    const {
      mode,
      customerId,
      creditContact,
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

    // Wholesale is sold to a known business, not over a counter: the customer
    // decides the price list, the credit terms and who owes what. Accepting an
    // anonymous wholesale sale silently priced it at retail rates.
    if (mode === 'WHOLESALE' && !customerId) {
      return res.status(400).json({
        success: false,
        message: 'A customer is required for wholesale sales.',
      });
    }

    // Checked here rather than left to Prisma: an unknown enum member aborts the
    // transaction with a validation error that reaches the till as a bare 500,
    // which is how "MOBILE_MONEY" and "CREDIT" both went unnoticed.
    const badMethod = (payments ?? []).find(
      (p: any) =>
        String(p?.method).toUpperCase() !== CREDIT_MARKER &&
        !SALE_PAYMENT_METHODS.includes(String(p?.method).toUpperCase() as any),
    );
    if (badMethod) {
      return res.status(400).json({
        success: false,
        message: `Unknown payment method "${badMethod.method}". Expected one of: ${SALE_PAYMENT_METHODS.join(', ')} or ${CREDIT_MARKER}.`,
      });
    }

    // Stock is checked once, inside the transaction below, by
    // deductStockForSale — the same function that actually deducts it. A
    // second check here duplicated that logic against `plannedQty` (an
    // invoice-authorised quantity, not live stock), which is exactly how a
    // serialized product with zero physical units left could still be sold:
    // this check passed against a stale number while the real count said no.

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

      const priceLines = items.map((item: any) => ({
        categoryId: item.categoryId,
        quantity: item.quantity,
        variantId: item.variantId || null,
      }));
      // tx, not the global client — this read is now part of the same
      // transaction as the writes below it.
      const resolvedPrices = await resolvePricesForSale(tenantId, customerId || null, priceLines, tx);

      // An offline-synced sale already happened before this request existed:
      // cash changed hands and a receipt printed at whatever price the device
      // had cached. Overriding it now prevents nothing — it only makes our
      // record disagree with what the customer was actually charged. So an
      // offline sale keeps the device's price, bounded by a tolerance that
      // still catches gross tampering or a badly stale cache.
      //
      // A fresh online sale (no offlineId) has no such history to respect, so
      // it is always the server-resolved price with no exception — that is
      // where the original "trust the client's unitPrice" gap actually lived,
      // and it stays fully closed here.
      const OFFLINE_PRICE_TOLERANCE = 0.2; // 20% — starting point, tune to the business

      let subtotal = 0;
      const saleItems: any[] = [];
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const resolved = resolvedPrices[idx];
        let unitPrice = resolved.unitPrice;

        if (offlineId) {
          const clientPrice = Number(item.unitPrice);
          if (Number.isFinite(clientPrice) && clientPrice >= 0) {
            const deviation = resolved.unitPrice > 0
              ? Math.abs(clientPrice - resolved.unitPrice) / resolved.unitPrice
              : (clientPrice === 0 ? 0 : Infinity);
            if (deviation <= OFFLINE_PRICE_TOLERANCE) {
              unitPrice = clientPrice;
            } else {
              console.warn(
                `[offline-sale] Price deviation beyond tolerance — tenant ${tenantId}, offlineId ${offlineId}, ` +
                `category ${item.categoryId}, variant ${item.variantId ?? 'none'}: device charged ${clientPrice}, ` +
                `server resolves ${resolved.unitPrice} (${(deviation * 100).toFixed(0)}% off). Using server price.`,
              );
              // unitPrice stays resolved.unitPrice.
            }
          }
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
          // Not claimed yet — deductStockForSale below does that
          // atomically and only stamps productItemId once the claim actually
          // succeeds, so the receipt shows the serial that really left the
          // shop rather than just the one that was requested.
          serialNumber: item.unitIdentifier || null,
          variantId: item.variantId || null,
          variantLabel: resolved.variantLabel ?? null,
        });
      }
      // Parallel to saleItems — the unit each line asked for, kept separate
      // from the Prisma create payload (productItemId is set only after the
      // claim succeeds, patched in once deductStockForSale returns).
      const requestedUnitIds: (string | null)[] = items.map((item: any) => item.unitId || null);

      const saleDiscountAmount = discountType === 'PERCENTAGE'
        ? (subtotal * (discountValue || 0)) / 100
        : (discountValue || 0);
      const totalAmount = subtotal - saleDiscountAmount;

      // CREDIT is not a way of paying, it is the absence of payment, and there is
      // no such member of SalePaymentMethod. The till sends it as a marker for
      // "the customer is taking this away without settling"; it must not become a
      // SalePayment row, and counting it as money made a wholly unpaid sale come
      // out as paymentStatus PAID owing nothing.
      const settledPayments = (payments ?? []).filter(
        (p: any) => String(p.method).toUpperCase() !== CREDIT_MARKER,
      );

      // Cash tendered can legitimately exceed the total (change owed at the
      // till), and split payments can overshoot by mistake. Either way, the sale
      // itself is never "paid" for more than it is worth — anything past the
      // total is carved off as a tip for whoever made the sale, tracked
      // separately (see recordSaleTipAsIncome) rather than inflating amountPaid.
      const rawTotalPaid = settledPayments.reduce((sum: number, p: any) => sum + p.amount, 0);
      const totalPaid = Math.min(rawTotalPaid, totalAmount);
      const tipAmount = Math.max(0, rawTotalPaid - totalAmount);
      const amountOwed = Math.max(0, totalAmount - totalPaid);
      let paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' = 'PAID';
      if (totalPaid <= 0) paymentStatus = 'CREDIT';
      else if (amountOwed > 0) paymentStatus = 'PARTIAL';

      // A retail credit sale needs somebody to chase. Rather than sending the
      // cashier to a registration screen mid-sale, the counter captures a phone
      // and that becomes a real customer row — matched to an existing one when
      // the same number comes back.
      let effectiveCustomerId: string | null = customerId || null;
      let creditCustomerName: string | null = null;

      if (mode === 'RETAIL' && !effectiveCustomerId && creditContact?.phone) {
        const credit = await findOrCreateCreditCustomer(tx, tenantId, {
          phone: String(creditContact.phone),
          name: customerName,
        });
        effectiveCustomerId = credit.id;
        creditCustomerName = credit.name;
      }

      const resolvedCustomerName =
        customerName || creditCustomerName || (effectiveCustomerId ? undefined : 'Walk-in Customer');

      const createdSale = await tx.sale.create({
        data: {
          tenantId,
          saleNumber,
          offlineId: offlineId ?? null,
          mode,
          status: 'COMPLETED',
          customerId: effectiveCustomerId,
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
          tipAmount,
          creditDueDate: creditDueDate ? new Date(creditDueDate) : null,
          creditCollateral: creditContact?.collateral?.trim() || null,
          notes: notes || null,
          items: { create: saleItems },
          payments: settledPayments.length ? {
            create: settledPayments.map((p: any) => ({
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
      // device last saw. Insufficient stock throws and rolls back the whole sale.
      const { soldUnitIds } = await deductStockForSale(
        tx,
        saleItems.map((i: any, idx: number) => ({
          categoryId: i.categoryId,
          quantity: i.quantity,
          productName: i.productName,
          unitId: requestedUnitIds[idx],
          // Same server-resolved variant the line was priced against — stock
          // must come out of the bucket the customer was actually charged for.
          variantId: i.variantId ?? null,
        })),
        saleNumber,
        tenantId,
        user.id,
      );

      // createdSale.items is in the same order the nested create was given.
      // Only lines that actually claimed a unit get a productItemId — a serial
      // conflict (already sold) leaves it null rather than pointing at a unit
      // this line never actually took.
      for (let idx = 0; idx < createdSale.items.length; idx++) {
        const claimedUnitId = soldUnitIds[idx];
        if (claimedUnitId) {
          await tx.saleItem.update({
            where: { id: createdSale.items[idx].id },
            data: { productItemId: claimedUnitId },
          });
        }
      }

      // The income transaction is written after the sale because it references
      // the sale number, which costs one extra update to link them back up.
      const transactionId = await recordSaleAsIncome(tx, createdSale, tenantId);
      await tx.sale.update({ where: { id: createdSale.id }, data: { transactionId } });
      await recordSaleTipAsIncome(tx, createdSale, tipAmount, tenantId);

      return { ...createdSale, transactionId };
    },
    {
      // A sale is a dozen or so sequential writes, and the database is a managed
      // Postgres in another region — at 300ms a round trip that alone exceeds
      // Prisma's 5s default. Losing a completed sale to a timeout is the worst
      // outcome available, so the ceiling is generous.
      timeout: 30_000,
      maxWait: 10_000,
    });

    return res.status(201).json({
      success: true,
      message: 'Sale created',
      data: sale,
    });
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      return res.status(400).json({
        success: false,
        message: error.message,
        conflict: { type: 'INSUFFICIENT_STOCK', items: error.items },
      });
    }
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
        items: {
          include: {
            category: { select: { id: true, name: true, sku: true, imageUrl: true, unit: true, stockTrackingMode: true } },
            // Without this a return has no way to know — or show — which
            // option a line was. sku/barcode come along so a return can be
            // scanned straight onto the right line when one sale holds two
            // options of the same product.
            variant: { select: { id: true, label: true, sku: true, barcode: true } },
          },
        },
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

/**
 * Resolves a scanned receipt barcode to the sale it belongs to, for the
 * Returns screen. Looked up by `id` (the value printed on a receipt once
 * synced) or `offlineId` (what got printed if the receipt came off the
 * device before it ever reached the server) — always scoped to this tenant,
 * so a code from another tenant's receipt can never resolve here even if it
 * were somehow guessed or misscanned.
 */
function lookupSaleByCode(mode: 'RETAIL' | 'WHOLESALE') {
  return async (req: AuthRequest, res: Response) => {
    try {
      const tenantId = req.tenantId!;
      const code = String(req.params.code || '').trim();
      if (!code) return res.status(400).json({ success: false, message: 'A code is required' });

      const sale = await prisma.sale.findFirst({
        where: { tenantId, mode, OR: [{ id: code }, { offlineId: code }] },
        select: { id: true, saleNumber: true, mode: true },
      });
      if (!sale) return res.status(404).json({ success: false, message: 'No sale found for this code' });

      return res.json({ success: true, data: sale });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Failed to look up sale' });
    }
  };
}

export const lookupRetailSaleByCode = lookupSaleByCode('RETAIL');
export const lookupWholesaleSaleByCode = lookupSaleByCode('WHOLESALE');

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

      const effectiveCustomerId = customerId !== undefined ? (customerId || null) : existing.customerId;
      const priceLines = items.map((item: any) => ({
        categoryId: item.categoryId,
        quantity: item.quantity,
        variantId: item.variantId || null,
      }));
      // Always server-resolved: this is an explicit later edit, never an
      // offline sync, so there is no already-happened sale to respect.
      const resolvedPrices = await resolvePricesForSale(tenantId, effectiveCustomerId, priceLines);

      const newItems = items.map((item: any, idx: number) => {
        const resolved = resolvedPrices[idx];
        const unitPrice = resolved.unitPrice;
        const itemDiscount = item.discountType === 'PERCENTAGE'
          ? (unitPrice * item.quantity * (item.discountValue || 0)) / 100
          : (item.discountValue || 0);
        const lineTotal = unitPrice * item.quantity - itemDiscount;
        return {
          saleId,
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
          variantId: item.variantId || null,
          variantLabel: resolved.variantLabel ?? null,
        };
      });

      const subtotal = newItems.reduce((sum: number, i: any) => sum + i.lineTotal, 0);
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
      else updateData.paymentStatus = 'CREDIT';
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

    // Same "overpayment becomes a tip" rule as createSale: the sale never shows
    // as paid for more than it is worth, and the excess is not silently dropped.
    const paymentAmount = Math.min(amount, Number(sale.amountOwed));
    const tipAmount = Math.max(0, amount - Number(sale.amountOwed));
    const newAmountPaid = Number(sale.amountPaid) + paymentAmount;
    const newAmountOwed = Number(sale.totalAmount) - newAmountPaid;
    const newStatus = newAmountOwed <= 0 ? 'PAID' : 'PARTIAL';
    const newTipAmount = Number((sale as any).tipAmount ?? 0) + tipAmount;

    await prisma.$transaction(async (tx: any) => {
      await tx.salePayment.create({
        data: {
          saleId: sale.id,
          method,
          amount,
          reference: reference || null,
          recordedById: user.id,
          recordedByName: user.email,
        },
      });

      await tx.sale.update({
        where: { id: sale.id },
        data: {
          amountPaid: newAmountPaid,
          amountOwed: Math.max(0, newAmountOwed),
          paymentStatus: newStatus,
          tipAmount: newTipAmount,
        },
      });

      await recordSaleTipAsIncome(tx, sale as any, tipAmount, tenantId);
    });

    return res.json({
      success: true,
      message: 'Payment recorded',
      data: {
        amountPaid: newAmountPaid,
        amountOwed: Math.max(0, newAmountOwed),
        paymentStatus: newStatus,
        tipAmount: tipAmount > 0 ? tipAmount : undefined,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to record payment' });
  }
}

export async function getDailySalesSummary(req: AuthRequest, res: Response) {
  try {
    const { getDailySummary } = await import('../services/dailySummaryService.js');
    const date = req.query.date ? new Date(req.query.date as string) : new Date();
    if (Number.isNaN(date.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid date' });
    }

    // Both routers mount under the same base, so req.baseUrl never names the
    // mode — the previous check read it there and always came back false. It
    // also mixed || with ?:, which binds tighter, so any ?mode= at all meant
    // WHOLESALE. Between them, the wholesale page was reporting retail figures.
    const queryMode = String(req.query.mode ?? '').toUpperCase();
    const mode =
      queryMode === 'RETAIL' || queryMode === 'WHOLESALE'
        ? queryMode
        : req.originalUrl.includes('/wholesale/')
          ? 'WHOLESALE'
          : 'RETAIL';

    const summary = await getDailySummary(req.tenantId!, date, mode);
    return res.json({ success: true, data: summary });
  } catch (error) {
    console.error('Error building daily sales summary:', error);
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

    // Must thread variantId: this endpoint is what the cart previews, and
    // createSale resolves the same six tiers with the variant included.
    // Leaving it out would quote the product price and then charge the
    // variant price at checkout.
    const lines = items.map((item: any) => ({
      categoryId: item.categoryId,
      quantity: item.quantity || 1,
      variantId: item.variantId || null,
    }));
    const resolved = await resolvePricesForSale(tenantId, customerId || null, lines);

    const data = items.map((item: any, idx: number) => ({
      categoryId: item.categoryId,
      variantId: item.variantId || null,
      unitPrice: resolved[idx].unitPrice,
      // Lets the cart say *why* a price changed rather than silently
      // rewriting the number under the cashier.
      source: resolved[idx].source,
      priceListName: resolved[idx].priceListName ?? null,
      variantLabel: resolved[idx].variantLabel ?? null,
    }));

    return res.json({ success: true, data });
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
