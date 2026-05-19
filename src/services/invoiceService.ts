import { prisma } from '../db.js';
import { checkSufficientFunds, recordIncome, recordExpense } from './balanceService.js';

// ── Invoice number generator ───────────────────────────────────────────────────

export async function generateInvoiceNumber(tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const abbr = tenant!.subdomain.slice(0, 6).toUpperCase().replace(/-/g, '');

  // Atomically increment sequence (upsert so first invoice creates the row)
  const seq = await (prisma as any).invoiceSequence.upsert({
    where: { tenantId },
    update: { lastSeq: { increment: 1 } },
    create: { tenantId, lastSeq: 1 },
  });

  return `INV-${abbr}-${String(seq.lastSeq).padStart(4, '0')}`;
}

// ── createPurchaseInvoice ──────────────────────────────────────────────────────

export async function createPurchaseInvoice({
  tenantId,
  categoryId,
  submittedBy,
}: {
  tenantId: string;
  categoryId: string;
  submittedBy: string;
}) {
  const category = await (prisma as any).inventoryCategory.findUnique({
    where: { id: categoryId },
  });
  if (!category) throw new Error('Category not found');

  const costPrice = Number(category.costPrice ?? 0);
  const plannedQty = category.plannedQty ?? 0;
  const subtotal = costPrice * plannedQty;
  const invoiceNumber = await generateInvoiceNumber(tenantId);

  const invoice = await (prisma as any).invoice.create({
    data: {
      tenantId,
      invoiceNumber,
      type: 'PURCHASE',
      status: 'PENDING',
      categoryId,
      supplierName: category.supplier ?? null,
      plannedDate: category.plannedDate ?? null,
      authorisedQty: plannedQty,
      addedQty: 0,
      subtotal: subtotal as any,
      total: subtotal as any,
      submittedBy,
      notes: `Purchase request for ${category.name} — ${plannedQty} units at ${costPrice} XAF each`,
      lineItems: {
        create: [
          {
            type: 'STOCK_MATERIAL',
            description: category.name,
            quantity: plannedQty,
            unitPrice: costPrice as any,
            total: subtotal as any,
            categoryId,
            sortOrder: 0,
          },
        ],
      },
    },
    include: { lineItems: true },
  });

  return invoice;
}

// ── createProjectInvoice ──────────────────────────────────────────────────────

export async function createProjectInvoice({
  tenantId,
  projectId,
  budget,
  submittedBy,
}: {
  tenantId: string;
  projectId: string;
  budget: number;
  submittedBy: string;
}) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error('Project not found');

  const invoiceNumber = await generateInvoiceNumber(tenantId);

  const invoice = await (prisma as any).invoice.create({
    data: {
      tenantId,
      invoiceNumber,
      type: 'PROJECT',
      status: 'PENDING',
      projectId,
      subtotal: budget as any,
      total: budget as any,
      submittedBy,
      notes: `Budget approval request for project: ${project.name}`,
      lineItems: {
        create: [
          {
            type: 'SERVICE',
            description: 'Project Budget',
            quantity: 1,
            unitPrice: budget as any,
            total: budget as any,
            sortOrder: 0,
          },
        ],
      },
    },
    include: { lineItems: true },
  });

  return invoice;
}

// ── createClientInvoice ───────────────────────────────────────────────────────

export async function createClientInvoice({
  tenantId,
  projectId,
  lineItems,
  submittedBy,
  notes,
}: {
  tenantId: string;
  projectId: string;
  lineItems?: Array<{
    description: string;
    type?: string;
    quantity: number;
    unitPrice: number;
    categoryId?: string;
    notes?: string;
  }>;
  submittedBy: string;
  notes?: string;
}) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error('Project not found');

  // If no lineItems provided, build from project materials
  let resolvedLineItems = lineItems;
  if (!resolvedLineItems || resolvedLineItems.length === 0) {
    const materials = await prisma.projectMaterial.findMany({
      where: { projectId, tenantId },
    });

    resolvedLineItems = materials.map((m: any) => {
      const catType: string = m.sourceType ?? 'EXTERNAL';
      const lineType =
        catType === 'STOCK' ? 'STOCK_MATERIAL'
          : catType === 'INVENTORY' ? 'INVENTORY_MATERIAL'
          : 'EXTERNAL_MATERIAL';
      return {
        description: m.name,
        type: lineType,
        quantity: m.quantity,
        unitPrice: Number(m.unitCost),
        categoryId: m.categoryId ?? undefined,
      };
    }).filter((li: any) => li.unitPrice > 0);
  }

  const subtotal = resolvedLineItems.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0);
  const invoiceNumber = await generateInvoiceNumber(tenantId);

  const invoice = await (prisma as any).invoice.create({
    data: {
      tenantId,
      invoiceNumber,
      type: 'CLIENT',
      status: 'DRAFT',
      projectId,
      subtotal: subtotal as any,
      total: subtotal as any,
      submittedBy,
      notes: notes ?? null,
      lineItems: {
        create: resolvedLineItems.map((li, i) => ({
          type: (li.type ?? 'OTHER') as any,
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice as any,
          total: (li.quantity * li.unitPrice) as any,
          categoryId: li.categoryId ?? null,
          notes: li.notes ?? null,
          sortOrder: i,
        })),
      },
    },
    include: { lineItems: true },
  });

  return invoice;
}

// ── createPaymentInvoice ──────────────────────────────────────────────────────

export async function createPaymentInvoice({
  tenantId,
  customerId,
  amount,
  submittedBy,
}: {
  tenantId: string;
  customerId: string;
  amount: number;
  submittedBy: string;
}) {
  const invoiceNumber = await generateInvoiceNumber(tenantId);

  const invoice = await (prisma as any).invoice.create({
    data: {
      tenantId,
      invoiceNumber,
      type: 'PAYMENT',
      status: 'PENDING',
      customerId,
      subtotal: amount as any,
      total: amount as any,
      submittedBy,
      notes: `Initial payment / deposit`,
      lineItems: {
        create: [
          {
            type: 'OTHER',
            description: 'Initial payment / deposit',
            quantity: 1,
            unitPrice: amount as any,
            total: amount as any,
            sortOrder: 0,
          },
        ],
      },
    },
    include: { lineItems: true },
  });

  return invoice;
}

// ── approveInvoice ────────────────────────────────────────────────────────────

export async function approveInvoice(invoiceId: string, reviewerId: string) {
  const invoice = await (prisma as any).invoice.findUnique({
    where: { id: invoiceId },
    include: { lineItems: true },
  });

  if (!invoice) throw new Error('Invoice not found');
  if (invoice.status !== 'PENDING') throw new Error('Only PENDING invoices can be approved');

  await prisma.$transaction(async (tx) => {
    await (tx as any).invoice.update({
      where: { id: invoiceId },
      data: { status: 'APPROVED', reviewedBy: reviewerId, approvedAt: new Date() },
    });

    if (invoice.type === 'PURCHASE') {
      // Check sufficient funds before approving expense
      await checkSufficientFunds(invoice.tenantId, Number(invoice.total));
      // Unlock the category so units can be added
      if (invoice.categoryId) {
        await (tx as any).inventoryCategory.update({
          where: { id: invoice.categoryId },
          data: { invoiceApproved: true, approvedInvoiceId: invoiceId },
        });
      }
      // No expense transaction yet — money moves when units are added (deductUnitCost)
    }

    if (invoice.type === 'PROJECT') {
      // Mark approved — income is confirmed in instalments via approveProjectInvoiceInstalment
      await (tx as any).invoice.update({
        where: { id: invoiceId },
        data: {
          totalApproved: 0 as any,
          remainingAmount: invoice.total as any,
          isFullyPaid: false,
        },
      });

      // Unlock the project so materials can be added immediately upon invoice approval
      if (invoice.projectId) {
        await (tx as any).project.update({
          where: { id: invoice.projectId },
          data: { invoiceApproved: true },
        });
      }
    }

    if (invoice.type === 'PAYMENT') {
      // Create income transaction immediately
      const transaction = await (tx as any).transaction.create({
        data: {
          tenantId: invoice.tenantId,
          type: 'INCOME',
          status: 'ACCEPTED',
          amount: invoice.total,
          currency: 'XAF',
          description: `Customer payment approved — Invoice ${invoice.invoiceNumber}`,
          category: 'Customer Payment',
          invoiceId: invoice.id,
          customerId: invoice.customerId ?? null,
          isAutomatic: true,
          recordedAt: new Date(),
        },
      });
      await (tx as any).invoice.update({
        where: { id: invoiceId },
        data: { transactionId: transaction.id, status: 'PAID', paidAt: new Date() },
      });
      await recordIncome(invoice.tenantId, Number(invoice.total), tx);
    }
  });

  return (prisma as any).invoice.findUnique({
    where: { id: invoiceId },
    include: { lineItems: true },
  });
}

// ── rejectInvoice ─────────────────────────────────────────────────────────────

export async function rejectInvoice(invoiceId: string, reviewerId: string, reason: string) {
  if (!reason || reason.trim().length < 10) {
    throw new Error('Rejection reason must be at least 10 characters');
  }

  await (prisma as any).invoice.update({
    where: { id: invoiceId },
    data: {
      status: 'REJECTED',
      reviewedBy: reviewerId,
      rejectedAt: new Date(),
      rejectionReason: reason,
    },
  });

  // category.invoiceApproved stays false — units cannot be added

  return (prisma as any).invoice.findUnique({
    where: { id: invoiceId },
    include: { lineItems: true },
  });
}

// ── deductUnitCost ────────────────────────────────────────────────────────────

export async function deductUnitCost(
  productItemId: string,
  categoryId: string,
  tenantId: string,
) {
  const category = await (prisma as any).inventoryCategory.findUnique({
    where: { id: categoryId },
  });
  if (!category) return;

  const invoice = await (prisma as any).invoice.findFirst({
    where: { categoryId, status: 'APPROVED', type: 'PURCHASE' },
  });

  const costAmount = Number(category.costPrice ?? 0);

  await prisma.$transaction(async (tx) => {
    await recordExpense(tenantId, costAmount, tx);

    await (tx as any).transaction.create({
      data: {
        tenantId,
        type: 'EXPENSE',
        status: 'ACCEPTED',
        amount: costAmount as any,
        currency: 'XAF',
        description: `Unit received: ${category.name}`,
        category: 'Stock Purchase',
        invoiceId: invoice?.id ?? null,
        isAutomatic: true,
        recordedAt: new Date(),
      },
    });

    if (invoice) {
      await (tx as any).invoice.update({
        where: { id: invoice.id },
        data: { addedQty: { increment: 1 } },
      });
    }
  });
}
