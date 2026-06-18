import { prisma } from '../db.js';
import { sendNotification } from './notificationService.js';

// ── approveProjectInvoiceInstalment ──────────────────────────────────────────

export async function approveProjectInvoiceInstalment({
  invoiceId,
  tenantId,
  approvedBy,
  transactionId,
  percentageApproved,
  amountApproved,
  notes,
}: {
  invoiceId: string;
  tenantId: string;
  approvedBy: string;
  transactionId: string;
  percentageApproved: number;
  amountApproved: number;
  notes?: string;
}) {
  let notificationContext: any = null;
  const result = await prisma.$transaction(async (tx) => {
    const invoice = await (tx as any).invoice.findFirst({
      where: { id: invoiceId, tenantId, type: 'PROJECT', status: { in: ['PENDING', 'APPROVED'] } },
      include: { payments: true, project: { select: { id: true, name: true, customerId: true, budget: true } } },
    });
    if (!invoice) throw new Error('Invoice not found or not eligible for instalment approval');

    const transaction = await (tx as any).transaction.findFirst({
      where: { id: transactionId, tenantId, type: 'INCOME', status: 'ACCEPTED' },
    });
    if (!transaction) throw new Error('Transaction not found or not an accepted income transaction');
    const linkedPayment = await (tx as any).invoicePayment.findUnique({ where: { transactionId } });
    if (linkedPayment) throw new Error('This transaction is already linked to a payment');

    const currentApproved = invoice.payments.reduce(
      (sum: number, payment: any) => sum + Number(payment.amountApproved),
      0,
    );
    const total = Number(invoice.total);
    const remaining = total - currentApproved;
    if (amountApproved > remaining + 0.01) {
      throw new Error(`Amount exceeds remaining balance. Remaining: ${remaining.toFixed(2)}`);
    }

    // Create payment record
    const payment = await (tx as any).invoicePayment.create({
      data: {
        tenantId,
        invoiceId,
        transactionId,
        approvedBy,
        percentageApproved: percentageApproved as any,
        amountApproved: amountApproved as any,
        notes: notes ?? null,
      },
    });

    // Link to the transaction is held by InvoicePayment.transactionId (unique) — no
    // back-reference column exists on Transaction, so nothing to update there.
    void payment;

    const newApproved = currentApproved + amountApproved;
    const newRemaining = Math.max(0, total - newApproved);
    const isFullyPaid = newRemaining < 0.01;

    // Update invoice fields
    const updatedInvoice = await (tx as any).invoice.update({
      where: { id: invoiceId },
      data: {
        totalApproved: newApproved as any,
        remainingAmount: newRemaining as any,
        isFullyPaid,
        status: isFullyPaid ? 'PAID' : 'APPROVED',
        paidAt: isFullyPaid ? new Date() : undefined,
        reviewedBy: approvedBy,
        approvedAt: invoice.approvedAt ?? new Date(),
      },
      include: {
        lineItems: true,
        payments: { include: { transaction: true }, orderBy: { createdAt: 'asc' } },
      },
    });

    // Update project's available budget and invoiceApproved flag
    if (invoice.project) {
      const currentProject = await tx.project.findUnique({ where: { id: invoice.project.id } });
      if (currentProject) {
        const currentAvailable = Number((currentProject as any).availableBudget ?? 0);
        await tx.project.update({
          where: { id: invoice.project.id },
          data: {
            invoiceApproved: true,
            availableBudget: (currentAvailable + amountApproved) as any,
            remainingBudget: Math.max(0, currentAvailable + amountApproved - Number((currentProject as any).spentAmount ?? 0)) as any,
          },
        });
      }
    }

    notificationContext = invoice;
    return { payment, invoice: updatedInvoice };
  });

  // Notify the submitter
  try {
    const invoice = notificationContext;
    await sendNotification({
      tenantId,
      userId: invoice.submittedBy,
      userType: 'EMPLOYEE',
      type: 'invoice.instalment.approved',
      title: 'Project Invoice Instalment Approved',
      message: `An instalment of ${amountApproved.toFixed(2)} XAF (${percentageApproved}%) has been approved for invoice ${invoice.invoiceNumber}.`,
      link: `/finances/invoices/${invoiceId}`,
    });
  } catch (_) {}

  return result.invoice;
}

// ── rejectProjectInvoice ──────────────────────────────────────────────────────

export async function rejectProjectInvoice(
  invoiceId: string,
  reviewerId: string,
  reason: string,
  tenantId: string,
) {
  if (!reason || reason.trim().length < 10) {
    throw new Error('Rejection reason must be at least 10 characters');
  }

  const invoice = await (prisma as any).invoice.findFirst({
    where: { id: invoiceId, tenantId, type: 'PROJECT', status: 'PENDING' },
  });
  if (!invoice) throw new Error('Invoice not found or not eligible for rejection');

  await (prisma as any).invoice.update({
    where: { id: invoiceId },
    data: {
      status: 'REJECTED',
      reviewedBy: reviewerId,
      rejectedAt: new Date(),
      rejectionReason: reason,
    },
  });

  // Notify submitter
  try {
    await sendNotification({
      tenantId,
      userId: invoice.submittedBy,
      userType: 'EMPLOYEE',
      type: 'invoice.project.rejected',
      title: 'Project Invoice Rejected',
      message: `Invoice ${invoice.invoiceNumber} has been rejected. Reason: ${reason}`,
      link: `/finances/invoices/${invoiceId}`,
    });
  } catch (_) {}

  return (prisma as any).invoice.findUnique({
    where: { id: invoiceId },
    include: { lineItems: true },
  });
}
