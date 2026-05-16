import { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { broadcastToModule } from '../services/notificationService.js';
import { createPaymentInvoice } from '../services/invoiceService.js';
import { logAudit, extractRequestContext, buildDiff, AuditActorType } from '../services/auditService.js';
import { recordStockEvent } from './inventory.items.controller.js';

const CustomerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  address: z.string().optional(),
  initialRevenue: z.number().optional(),
  initialBudget: z.number().nonnegative().optional(),
  status: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string().datetime().optional(),
});

export const createCustomer = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = CustomerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const data = parsed.data;
    const customer = await prisma.customer.create({
      data: {
        tenantId: req.tenantId!,
        name: data.name,
        email: data.email,
        phone: data.phone,
        location: data.location,
        address: data.address,
        initialRevenue: data.initialRevenue as any,
        status: (data.status as any) || 'ACTIVE',
        notes: data.notes,
        ...(data.createdAt ? { createdAt: new Date(data.createdAt) } : {}),
      },
    });

    await broadcastToModule(req.tenantId!, 'contacts', {
      type: 'customer.created',
      title: 'New Customer Created',
      message: `${customer.name} has been added to the system.`,
      link: `/customers/${customer.id}`,
    });

    // Create a payment invoice if initialBudget provided
    let paymentInvoice = null;
    const submittedBy = req.user?.id;
    if (submittedBy && data.initialBudget && data.initialBudget > 0) {
      try {
        paymentInvoice = await createPaymentInvoice({
          tenantId: req.tenantId!,
          customerId: customer.id,
          amount: data.initialBudget,
          submittedBy,
        });
      } catch (err) {
        console.error('[invoice] Error creating payment invoice for customer:', err);
      }
    }

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'CUSTOMER_CREATED',
      module: 'contacts',
      entityType: 'Customer',
      entityId: customer.id,
      entityLabel: customer.name,
      details: { name: customer.name, status: customer.status },
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: 'Customer created successfully',
      data: { customer, invoice: paymentInvoice },
    });
  } catch (error) {
    console.error('Error creating customer:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create customer',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const listCustomers = async (req: AuthRequest, res: Response) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const status = req.query.status ? String(req.query.status) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const skip = (page - 1) * limit;

    const where: any = { tenantId: req.tenantId! };
    if (status) {
      where.status = status as any;
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.customer.count({ where }),
    ]);

    return res.json({
      success: true,
      message: 'Customers retrieved successfully',
      data: customers,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error listing customers:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve customers',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getCustomer = async (req: AuthRequest, res: Response) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: { projects: { select: { id: true } } },
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    const projectIds = customer.projects.map((p) => p.id);

    const [transactions, invoices] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          tenantId: req.tenantId!,
          OR: [
            { moduleRef: 'crm', entityId: customer.id },
            ...(projectIds.length > 0 ? [{ moduleRef: 'projects', entityId: { in: projectIds } }] : []),
          ],
        },
        orderBy: { recordedAt: 'desc' },
        take: 100,
      }),
      (prisma as any).invoice.findMany({
        where: {
          tenantId: req.tenantId!,
          OR: [
            { customerId: customer.id },
            ...(projectIds.length > 0 ? [{ projectId: { in: projectIds }, type: 'CLIENT' }] : []),
          ],
        },
        include: { lineItems: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    const totalTransactions = transactions.reduce((sum, tx: any) => sum + Number(tx.amount ?? 0), 0);

    const data = {
      ...customer,
      projectCount: customer.projects.length,
      totalTransactions,
      transactions,
      invoices,
    };

    return res.json({
      success: true,
      message: 'Customer retrieved successfully',
      data,
    });
  } catch (error) {
    console.error('Error fetching customer:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve customer',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getCustomerInvoices = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page ?? '1'), 10);
    const limit = parseInt(String(req.query.limit ?? '20'), 10);
    const skip = (page - 1) * limit;

    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: { projects: { select: { id: true } } },
    });
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const projectIds = customer.projects.map((p) => p.id);
    const where: any = {
      tenantId: req.tenantId!,
      OR: [
        { customerId: customer.id },
        ...(projectIds.length > 0 ? [{ projectId: { in: projectIds }, type: 'CLIENT' }] : []),
      ],
    };

    const [invoices, total] = await Promise.all([
      (prisma as any).invoice.findMany({
        where,
        include: { lineItems: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      (prisma as any).invoice.count({ where }),
    ]);

    return res.json({
      success: true,
      message: 'Customer invoices retrieved successfully',
      data: invoices,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error fetching customer invoices:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve customer invoices',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateCustomer = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = CustomerSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const existing = await prisma.customer.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: {
        ...parsed.data,
        status: parsed.data.status ? (parsed.data.status as any) : undefined,
      },
    });

    // Notify authorized users
    await broadcastToModule(req.tenantId!, 'contacts', {
      type: 'customer.updated',
      title: 'Customer Details Updated',
      message: `Profile for ${customer.name} has been updated.`,
      link: `/customers/${customer.id}`,
    });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'CUSTOMER_UPDATED',
      module: 'contacts',
      entityType: 'Customer',
      entityId: customer.id,
      entityLabel: customer.name,
      details: buildDiff(existing as any, customer as any),
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Customer updated successfully',
      data: customer,
    });
  } catch (error) {
    console.error('Error updating customer:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update customer',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const deleteCustomer = async (req: AuthRequest, res: Response) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    const projectCount = await prisma.project.count({
      where: { customerId: req.params.id, tenantId: req.tenantId! },
    });
    if (projectCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete customer with active projects',
      });
    }

    await prisma.customer.delete({ where: { id: req.params.id } });

    // Notify authorized users
    await broadcastToModule(req.tenantId!, 'contacts', {
      type: 'customer.deleted',
      title: 'Customer Deleted',
      message: `${customer.name} has been removed from the system.`,
    });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'CUSTOMER_DELETED',
      module: 'contacts',
      entityType: 'Customer',
      entityId: customer.id,
      entityLabel: customer.name,
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Customer deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting customer:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete customer',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// ── Customer Purchases ─────────────────────────────────────────────────────

const PurchaseSchema = z.object({
  itemName: z.string().min(1, 'Item name is required'),
  quantity: z.number().int().positive().default(1),
  unitPrice: z.number().nonnegative().default(0),
  notes: z.string().optional(),
  purchasedAt: z.string().datetime().optional(),
  inventoryCategoryId: z.string().uuid().optional(),
});

export const listCustomerPurchases = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const customer = await prisma.customer.findFirst({
      where: { id: id as string, tenantId: req.tenantId! },
      select: { id: true },
    });
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const purchases = await (prisma as any).customerPurchase.findMany({
      where: { customerId: id, tenantId: req.tenantId! },
      orderBy: { purchasedAt: 'desc' },
    });

    return res.json({ success: true, data: purchases });
  } catch (error) {
    console.error('Error listing customer purchases:', error);
    return res.status(500).json({ success: false, message: 'Failed to list purchases' });
  }
};

export const addCustomerPurchase = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const parsed = PurchaseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    const customer = await prisma.customer.findFirst({
      where: { id: id as string, tenantId: req.tenantId! },
      select: { id: true },
    });
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const { itemName, quantity, unitPrice, notes, purchasedAt, inventoryCategoryId } = parsed.data;
    const total = quantity * unitPrice;

    // ── Stock deduction when linked to an inventory category ──────────────
    if (inventoryCategoryId) {
      const category = await (prisma as any).inventoryCategory.findFirst({
        where: { id: inventoryCategoryId, tenantId: req.tenantId!, type: 'STOCK' },
        select: { id: true, name: true },
      });
      if (!category) {
        return res.status(404).json({ success: false, message: 'Inventory category not found' });
      }

      const availableCount = await (prisma as any).productItem.count({
        where: { tenantId: req.tenantId!, categoryId: inventoryCategoryId, stockStatus: 'AVAILABLE' },
      });
      if (availableCount < quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock. Only ${availableCount} unit(s) available.`,
        });
      }

      // Find N available units and mark them SOLD in a transaction
      const availableItems = await (prisma as any).productItem.findMany({
        where: { tenantId: req.tenantId!, categoryId: inventoryCategoryId, stockStatus: 'AVAILABLE' },
        select: { id: true },
        take: quantity,
        orderBy: { createdAt: 'asc' },
      });

      const purchase = await prisma.$transaction(async (tx: any) => {
        // Mark units as SOLD
        await tx.productItem.updateMany({
          where: { id: { in: availableItems.map((i: any) => i.id) } },
          data: { stockStatus: 'SOLD' },
        });

        // Create purchase record with category link
        return tx.customerPurchase.create({
          data: {
            tenantId: req.tenantId!,
            customerId: id,
            inventoryCategoryId,
            itemName,
            quantity,
            unitPrice: unitPrice as any,
            total: total as any,
            notes: notes?.trim() || null,
            purchasedAt: purchasedAt ? new Date(purchasedAt) : new Date(),
          },
        });
      });

      // Log stock event (fire-and-forget)
      recordStockEvent({
        tenantId: req.tenantId!,
        categoryId: inventoryCategoryId,
        categoryType: 'STOCK',
        eventType: 'SOLD',
        delta: -quantity,
        title: `Sold ${quantity} unit(s) to customer`,
        performedBy: req.user?.id ?? null,
      }).catch(() => {});

      return res.status(201).json({ success: true, message: 'Purchase recorded successfully', data: purchase });
    }

    // ── Free-text purchase (no inventory link) ───────────────────────────
    const purchase = await (prisma as any).customerPurchase.create({
      data: {
        tenantId: req.tenantId!,
        customerId: id,
        itemName,
        quantity,
        unitPrice: unitPrice as any,
        total: total as any,
        notes: notes?.trim() || null,
        purchasedAt: purchasedAt ? new Date(purchasedAt) : new Date(),
      },
    });

    return res.status(201).json({ success: true, message: 'Purchase recorded successfully', data: purchase });
  } catch (error) {
    console.error('Error adding customer purchase:', error);
    return res.status(500).json({ success: false, message: 'Failed to record purchase' });
  }
};

export const deleteCustomerPurchase = async (req: AuthRequest, res: Response) => {
  try {
    const { id, purchaseId } = req.params;

    const purchase = await (prisma as any).customerPurchase.findFirst({
      where: { id: purchaseId, customerId: id, tenantId: req.tenantId! },
    });
    if (!purchase) {
      return res.status(404).json({ success: false, message: 'Purchase not found' });
    }

    // ── Reverse stock if purchase was linked to an inventory category ─────
    if (purchase.inventoryCategoryId) {
      await prisma.$transaction(async (tx: any) => {
        // Find SOLD units from this category and return them to AVAILABLE
        const soldItems = await tx.productItem.findMany({
          where: {
            tenantId: req.tenantId!,
            categoryId: purchase.inventoryCategoryId,
            stockStatus: 'SOLD',
          },
          select: { id: true },
          take: purchase.quantity,
          orderBy: { createdAt: 'asc' },
        });

        if (soldItems.length > 0) {
          await tx.productItem.updateMany({
            where: { id: { in: soldItems.map((i: any) => i.id) } },
            data: { stockStatus: 'AVAILABLE' },
          });
        }

        await tx.customerPurchase.delete({ where: { id: purchaseId } });
      });

      // Log stock reversal (fire-and-forget)
      recordStockEvent({
        tenantId: req.tenantId!,
        categoryId: purchase.inventoryCategoryId,
        categoryType: 'STOCK',
        eventType: 'RETURNED',
        delta: purchase.quantity,
        title: `Reversed sale of ${purchase.quantity} unit(s) (purchase deleted)`,
        performedBy: req.user?.id ?? null,
      }).catch(() => {});

      return res.json({ success: true, message: 'Purchase deleted successfully' });
    }

    await (prisma as any).customerPurchase.delete({ where: { id: purchaseId } });

    return res.json({ success: true, message: 'Purchase deleted successfully' });
  } catch (error) {
    console.error('Error deleting customer purchase:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete purchase' });
  }
};
