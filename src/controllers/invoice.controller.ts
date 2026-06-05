import { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';
import {
  approveInvoice as approveInvoiceSvc,
  rejectInvoice as rejectInvoiceSvc,
  createClientInvoice,
} from '../services/invoiceService.js';
import {
  approveProjectInvoiceInstalment,
  rejectProjectInvoice,
} from '../services/invoicePaymentService.js';
import { logAudit, extractRequestContext, AuditActorType } from '../services/auditService.js';
import { softDelete, isSoftDeleted } from '../services/softDeleteService.js';

// ── listInvoices ──────────────────────────────────────────────────────────────

export const listInvoices = async (req: AuthRequest, res: Response) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const type = req.query.type ? String(req.query.type) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const skip = (page - 1) * limit;

    const projectId  = req.query.projectId  ? String(req.query.projectId)  : undefined;
    const categoryId = req.query.categoryId ? String(req.query.categoryId) : undefined;
    const customerId = req.query.customerId ? String(req.query.customerId) : undefined;
    const search     = req.query.search     ? String(req.query.search)     : undefined;

    const where: any = { tenantId: req.tenantId! };
    if (type)       where.type       = type;
    if (status)     where.status     = status;
    if (projectId)  where.projectId  = projectId;
    if (categoryId) where.categoryId = categoryId;
    if (customerId) where.customerId = customerId;
    if (search)     where.invoiceNumber = { contains: search, mode: 'insensitive' };

    const [invoices, total] = await Promise.all([
      (prisma as any).invoice.findMany({
        where,
        include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      (prisma as any).invoice.count({ where }),
    ]);

    return res.json({
      success: true,
      message: 'Invoices retrieved successfully',
      data: invoices,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error listing invoices:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve invoices',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// ── getInvoiceSummary ─────────────────────────────────────────────────────────

export const getInvoiceSummary = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const [pending, approved, rejected, paid, draft] = await Promise.all([
      (prisma as any).invoice.count({ where: { tenantId, status: 'PENDING' } }),
      (prisma as any).invoice.count({ where: { tenantId, status: 'APPROVED' } }),
      (prisma as any).invoice.count({ where: { tenantId, status: 'REJECTED' } }),
      (prisma as any).invoice.count({ where: { tenantId, status: 'PAID' } }),
      (prisma as any).invoice.count({ where: { tenantId, status: 'DRAFT' } }),
    ]);

    return res.json({
      success: true,
      message: 'Invoice summary retrieved successfully',
      data: { pending, approved, rejected, paid, draft },
    });
  } catch (error) {
    console.error('Error fetching invoice summary:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve invoice summary',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// ── getInvoiceById ────────────────────────────────────────────────────────────

export const getInvoiceById = async (req: AuthRequest, res: Response) => {
  try {
    const invoice = await (prisma as any).invoice.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        category: { select: { id: true, name: true, abbreviation: true } },
        project: {
          select: {
            id: true,
            name: true,
            status: true,
            customer: { select: { id: true, name: true } },
          },
        },
        payments: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    // Collect all UUIDs that need name resolution: reviewedBy, submittedBy, every payment.approvedBy
    const rawUuids = [
      invoice.reviewedBy,
      invoice.submittedBy,
      ...((invoice.payments ?? []) as any[]).map((p: any) => p.approvedBy),
    ].filter(Boolean) as string[];
    const uniqueUuids = [...new Set(rawUuids)];

    const nameMap: Record<string, string> = {};
    if (uniqueUuids.length > 0) {
      const [users, employees] = await Promise.all([
        prisma.user.findMany({
          where: { id: { in: uniqueUuids } },
          select: { id: true, firstName: true, lastName: true },
        }),
        (prisma as any).employee.findMany({
          where: { id: { in: uniqueUuids } },
          select: { id: true, firstName: true, lastName: true },
        }),
      ]);
      for (const u of [...users, ...employees]) {
        nameMap[u.id] = `${u.firstName} ${u.lastName}`.trim();
      }
    }

    // Enrich payments with approvedByName (never expose raw UUID)
    const payments = ((invoice.payments ?? []) as any[]).map((p: any) => ({
      ...p,
      approvedByName: p.approvedBy ? (nameMap[p.approvedBy] ?? 'Unknown') : null,
    }));

    // Resolve customer if customerId is set
    let customer = null;
    if (invoice.customerId) {
      customer = await prisma.customer.findFirst({
        where: { id: invoice.customerId, tenantId: req.tenantId! },
        select: { id: true, name: true, email: true },
      }) as any;
    }

    return res.json({
      success: true,
      message: 'Invoice retrieved successfully',
      data: {
        ...invoice,
        payments,
        customer,
        reviewedByName: invoice.reviewedBy ? (nameMap[invoice.reviewedBy] ?? 'Unknown') : null,
        submittedByName: invoice.submittedBy ? (nameMap[invoice.submittedBy] ?? 'Unknown') : null,
      },
    });
  } catch (error) {
    console.error('Error fetching invoice:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve invoice',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// ── approveInvoice ────────────────────────────────────────────────────────────

export const approveInvoice = async (req: AuthRequest, res: Response) => {
  try {
    const reviewerId = req.user?.id;
    if (!reviewerId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const invoice = await (prisma as any).invoice.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const updated = await approveInvoiceSvc(invoice.id, reviewerId);

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'INVOICE_APPROVED',
      module: 'finance',
      entityType: 'Invoice',
      entityId: invoice.id,
      entityLabel: invoice.invoiceNumber ?? invoice.id,
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Invoice approved successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Error approving invoice:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(400).json({ success: false, message: msg });
  }
};

// ── rejectInvoice ─────────────────────────────────────────────────────────────

const RejectSchema = z.object({
  reason: z.string().min(10, 'Rejection reason must be at least 10 characters'),
});

export const rejectInvoice = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = RejectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const reviewerId = req.user?.id;
    if (!reviewerId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const invoice = await (prisma as any).invoice.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const updated = await rejectInvoiceSvc(invoice.id, reviewerId, parsed.data.reason);

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'INVOICE_REJECTED',
      module: 'finance',
      entityType: 'Invoice',
      entityId: invoice.id,
      entityLabel: invoice.invoiceNumber ?? invoice.id,
      details: { reason: parsed.data.reason },
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Invoice rejected successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Error rejecting invoice:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(400).json({ success: false, message: msg });
  }
};

// ── createClientInvoiceHandler ────────────────────────────────────────────────

const ClientInvoiceSchema = z.object({
  projectId: z.string().min(1),
  lineItems: z
    .array(
      z.object({
        description: z.string().min(1),
        type: z.string().optional(),
        quantity: z.number().int().positive(),
        unitPrice: z.number().nonnegative(),
        categoryId: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .optional(),
  notes: z.string().optional(),
});

export const createClientInvoiceHandler = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = ClientInvoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const submittedBy = req.user?.id;
    if (!submittedBy) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // Verify project belongs to tenant
    const project = await prisma.project.findFirst({
      where: { id: parsed.data.projectId, tenantId: req.tenantId! },
    });
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    const invoice = await createClientInvoice({
      tenantId: req.tenantId!,
      projectId: parsed.data.projectId,
      lineItems: parsed.data.lineItems,
      submittedBy,
      notes: parsed.data.notes,
    });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'INVOICE_CREATED',
      module: 'finance',
      entityType: 'Invoice',
      entityId: (invoice as any).id,
      entityLabel: (invoice as any).invoiceNumber ?? undefined,
      details: { type: 'CLIENT', projectId: parsed.data.projectId },
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: 'Client invoice created successfully',
      data: invoice,
    });
  } catch (error) {
    console.error('Error creating client invoice:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create client invoice',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// ── sendClientInvoice (DRAFT → PENDING) ───────────────────────────────────────

export const sendClientInvoice = async (req: AuthRequest, res: Response) => {
  try {
    const invoice = await (prisma as any).invoice.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    if (invoice.type !== 'CLIENT') {
      return res.status(400).json({
        success: false,
        message: 'Only CLIENT invoices can be sent',
      });
    }

    if (invoice.status !== 'DRAFT') {
      return res.status(400).json({
        success: false,
        message: 'Only DRAFT invoices can be sent',
      });
    }

    const notes = req.body?.notes;
    const updated = await (prisma as any).invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'PENDING',
        notes: notes !== undefined ? notes : invoice.notes,
      },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
    });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'employee' ? AuditActorType.EMPLOYEE : AuditActorType.OWNER,
      actorId: req.user?.id,
      action: 'INVOICE_SENT',
      module: 'invoices',
      entityType: 'Invoice',
      entityId: invoice.id,
      entityLabel: invoice.invoiceNumber ?? invoice.id,
      details: { previousStatus: 'DRAFT', newStatus: 'PENDING' },
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Invoice sent successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Error sending invoice:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send invoice',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// ── approveProjectInstalment ──────────────────────────────────────────────────

const InstalmentSchema = z.object({
  transactionId: z.string().uuid(),
  percentageApproved: z.number().min(0.01).max(100),
  amountApproved: z.number().positive(),
  notes: z.string().optional(),
});

export const approveProjectInstalment = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = InstalmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    const invoice = await approveProjectInvoiceInstalment({
      invoiceId: req.params.id,
      tenantId: req.tenantId!,
      approvedBy: req.user!.id,
      ...parsed.data,
    });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'INSTALMENT_APPROVED',
      module: 'finance',
      entityType: 'Invoice',
      entityId: req.params.id,
      details: { percentageApproved: parsed.data.percentageApproved, amountApproved: parsed.data.amountApproved },
      ...extractRequestContext(req),
    });

    return res.json({ success: true, message: 'Instalment approved successfully', data: invoice });
  } catch (error) {
    console.error('Error approving instalment:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(400).json({ success: false, message: msg });
  }
};


export const getInvoicePdfData = async (req: AuthRequest, res: Response) => {
  try {
    const invoice = await (prisma as any).invoice.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        category: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
    });

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    // Attach customer name if PAYMENT invoice
    let customer: { id: string; name: string } | null = null;
    if (invoice.customerId) {
      customer = await prisma.customer.findFirst({
        where: { id: invoice.customerId, tenantId: req.tenantId! },
        select: { id: true, name: true },
      }) as any;
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId! },
      select: { name: true, subdomain: true },
    });

    return res.json({
      success: true,
      message: 'Invoice PDF data retrieved successfully',
      data: { ...invoice, customer, tenant },
    });
  } catch (error) {
    console.error('Error fetching invoice PDF data:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve invoice PDF data',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const deleteInvoice = async (req: AuthRequest, res: Response) => {
  try {
    const invoice = await (prisma as any).invoice.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!invoice) {
      if (await isSoftDeleted('invoice', req.params.id)) {
        return res.status(410).json({ success: false, error: { code: 'RECORD_DELETED', message: 'This record has been deleted and is no longer available.' } });
      }
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    if (invoice.status === 'APPROVED' || invoice.status === 'PAID') {
      return res.status(400).json({
        success: false,
        message: 'Approved invoices cannot be deleted as they affect the financial record.',
      });
    }

    await softDelete({
      model: 'invoice',
      id: invoice.id,
      tenantId: req.tenantId!,
      actorId: req.user?.id,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      action: 'INVOICE_DELETED',
      entityType: 'Invoice',
      entityLabel: invoice.invoiceNumber,
      module: 'finance',
      details: { status: invoice.status, type: invoice.type, total: invoice.total },
      ...extractRequestContext(req),
    });

    return res.json({ success: true, message: 'Invoice deleted successfully' });
  } catch (error) {
    console.error('Error deleting invoice:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete invoice', error: error instanceof Error ? error.message : 'Unknown error' });
  }
};
