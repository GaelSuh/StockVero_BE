import { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { broadcastToModule } from '../services/notificationService.js';
import { createPurchaseInvoice, deductUnitCost } from '../services/invoiceService.js';
import { generateSystemId } from '../utils/generateSystemId.js';
import { deleteStorageFiles } from '../lib/storage.js';
import { logAudit, extractRequestContext, buildDiff, AuditActorType } from '../services/auditService.js';

// ── Shared helpers ─────────────────────────────────────────────────────────────

export const fetchCategoryById = (tenantId: string, id: string) =>
  (prisma as any).inventoryCategory.findFirst({ where: { tenantId, id } });

// ── Stock event logger ────────────────────────────────────────────────────────

const STATUS_AVAILABLE = 'AVAILABLE';

const STOCK_STATUSES = new Set(['AVAILABLE', 'DEPLOYED', 'UNDER_MAINTENANCE', 'FAULTY', 'COMPLETELY_BAD']);
const INVENTORY_STATUSES = new Set(['AVAILABLE', 'IN_USE', 'UNDER_MAINTENANCE', 'FAULTY', 'COMPLETELY_BAD']);

const isAvailableStatus = (s: string) => s === STATUS_AVAILABLE;

/**
 * Determine event type from a status transition.
 * Returns { eventType, delta } where delta is the change in *available* count.
 */
const resolveEventType = (
  before: string,
  after: string,
): { eventType: string; delta: number } => {
  const wasAvailable = isAvailableStatus(before);
  const isAvailable = isAvailableStatus(after);
  const delta = (isAvailable ? 1 : 0) - (wasAvailable ? 1 : 0);

  if (after === 'DEPLOYED') return { eventType: 'DEPLOYED', delta };
  if (after === 'IN_USE') return { eventType: 'DEPLOYED', delta }; // INVENTORY type analogue
  if (after === 'UNDER_MAINTENANCE') return { eventType: 'MAINTENANCE', delta };
  if (after === 'FAULTY' || after === 'COMPLETELY_BAD') return { eventType: 'FAULTY', delta };
  if (after === STATUS_AVAILABLE && before !== STATUS_AVAILABLE) return { eventType: 'RETURNED', delta };
  return { eventType: 'STATUS_CHANGE', delta };
};

/**
 * Record a category-level stock event with before/after available counts.
 */
export const recordStockEvent = async (opts: {
  tenantId: string;
  categoryId: string;
  categoryType?: string; // 'STOCK' | 'INVENTORY'
  unitSystemId?: string | null;
  eventType: string;
  delta: number;
  title: string;
  notes?: string | null;
  performedBy?: string | null;
}) => {
  try {
    // Count available units using the correct field based on category type
    const isInventoryType = opts.categoryType === 'INVENTORY';
    const countWhere: any = { tenantId: opts.tenantId, categoryId: opts.categoryId };
    if (isInventoryType) {
      countWhere.inventoryStatus = STATUS_AVAILABLE;
    } else {
      countWhere.stockStatus = STATUS_AVAILABLE;
    }
    const currentAvailable = await (prisma as any).productItem.count({ where: countWhere });
    const stockAfter = currentAvailable;
    const stockBefore = stockAfter - opts.delta;

    await (prisma as any).categoryStockLog.create({
      data: {
        tenantId: opts.tenantId,
        categoryId: opts.categoryId,
        unitSystemId: opts.unitSystemId ?? null,
        eventType: opts.eventType,
        stockBefore,
        stockAfter,
        delta: opts.delta,
        title: opts.title,
        notes: opts.notes ?? null,
        performedBy: opts.performedBy ?? null,
      },
    });
  } catch (err) {
    console.error('[stockLog] Failed to record stock event:', err);
  }
};

const DEFAULT_IDENTIFIER_LABELS: Record<string, string | null> = {
  SERIAL_NUMBER: 'Serial Number',
  IMEI: 'IMEI Number',
  BARCODE: 'Barcode',
  QR_CODE: 'QR Code',
  ASSET_TAG: 'Asset Tag',
  CUSTOM: 'Identifier',
  NONE: null,
};

export const resolveIdentifierLabel = (
  identifierType: string | undefined,
  providedLabel: string | undefined,
): string | null => {
  if (providedLabel !== undefined) return providedLabel || null;
  if (!identifierType) return null;
  return DEFAULT_IDENTIFIER_LABELS[identifierType] ?? null;
};

// ── Schemas ────────────────────────────────────────────────────────────────────

export const CategorySchema = z.object({
  name: z.string().min(1),
  abbreviation: z.string().min(1).max(8),
  type: z.enum(['STOCK', 'INVENTORY']).optional(),
  description: z.string().optional(),
  supplier: z.string().optional(),
  costPrice: z.coerce.number().nonnegative().optional(),
  sellingPrice: z.coerce.number().nonnegative().optional(),
  plannedQty: z.coerce.number().int().nonnegative().optional(),
  plannedDate: z.string().optional(),
  reorderThreshold: z.coerce.number().int().nonnegative().optional(),
  identifierType: z
    .enum(['SERIAL_NUMBER', 'IMEI', 'BARCODE', 'QR_CODE', 'ASSET_TAG', 'CUSTOM', 'NONE'])
    .optional(),
  identifierLabel: z.string().optional(),
  imageUrl: z.string().url().optional().or(z.literal('')),
  images: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const ProductItemCreateSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().optional(),
  identifierMode: z.enum(['manual', 'auto']),
  userIdentifier: z.string().optional(),
  notes: z.string().optional(),
  // Accept any valid status string — validated at runtime against category type
  status: z.string().optional(),
});

const ProductItemUpdateSchema = z.object({
  name: z.string().optional(),
  userIdentifier: z.string().optional(),
  notes: z.string().optional(),
  // Accept any string — validated at runtime against category type
  status: z.string().optional(),
  imageUrl: z.string().url().optional().or(z.literal('')),
});

const MaintenanceLogSchema = z.object({
  title: z.string().min(1),
  notes: z.string().optional(),
  // Accept any string — validated at runtime against category type
  newStatus: z.string().min(1),
});

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Returns the effective status string for a ProductItem regardless of which column holds it.
 * For STOCK items: stockStatus. For INVENTORY items: inventoryStatus.
 */
const getItemStatus = (item: any, categoryType: string): string | null => {
  if (categoryType === 'INVENTORY') return item.inventoryStatus ?? null;
  return item.stockStatus ?? null;
};

/**
 * Returns the Prisma field name and where-clause key for counting by status,
 * given a category type.
 */
const statusField = (categoryType: string) =>
  categoryType === 'INVENTORY' ? 'inventoryStatus' : 'stockStatus';

const buildCategoryStats = async (tenantId: string, categoryId: string, categoryType: string) => {
  const field = statusField(categoryType);
  const isStock = categoryType === 'STOCK';

  const [totalItems, availableCount, secondaryCount, maintenanceCount, faultyCount] =
    await Promise.all([
      (prisma as any).productItem.count({ where: { tenantId, categoryId } }),
      (prisma as any).productItem.count({ where: { tenantId, categoryId, [field]: 'AVAILABLE' } }),
      isStock
        ? (prisma as any).productItem.count({ where: { tenantId, categoryId, stockStatus: 'DEPLOYED' } })
        : (prisma as any).productItem.count({ where: { tenantId, categoryId, inventoryStatus: 'IN_USE' } }),
      (prisma as any).productItem.count({ where: { tenantId, categoryId, [field]: 'UNDER_MAINTENANCE' } }),
      (prisma as any).productItem.count({
        where: { tenantId, categoryId, [field]: { in: ['FAULTY', 'COMPLETELY_BAD'] } },
      }),
    ]);

  return {
    totalItems,
    availableCount,
    // STOCK: deployedCount | INVENTORY: inUseCount
    ...(isStock ? { deployedCount: secondaryCount } : { inUseCount: secondaryCount }),
    maintenanceCount,
    faultyCount,
  };
};

/** Batch version: builds stats for ALL given categories in ~6 queries total instead of 5 × N. */
const buildBatchCategoryStats = async (tenantId: string, categories: Array<{ id: string; type: string }>) => {
  const categoryIds = categories.map(c => c.id);
  if (categoryIds.length === 0) return new Map<string, Awaited<ReturnType<typeof buildCategoryStats>>>();

  // 6 total queries regardless of N categories
  const [
    totalByCategory,
    stockAvailable,
    invAvailable,
    stockDeployed,
    invInUse,
    stockMaintenance,
    invMaintenance,
    stockFaulty,
    invFaulty,
  ] = await Promise.all([
    (prisma as any).productItem.groupBy({ by: ['categoryId'], where: { tenantId, categoryId: { in: categoryIds } }, _count: { id: true } }),
    (prisma as any).productItem.groupBy({ by: ['categoryId'], where: { tenantId, categoryId: { in: categoryIds }, stockStatus: 'AVAILABLE' }, _count: { id: true } }),
    (prisma as any).productItem.groupBy({ by: ['categoryId'], where: { tenantId, categoryId: { in: categoryIds }, inventoryStatus: 'AVAILABLE' }, _count: { id: true } }),
    (prisma as any).productItem.groupBy({ by: ['categoryId'], where: { tenantId, categoryId: { in: categoryIds }, stockStatus: 'DEPLOYED' }, _count: { id: true } }),
    (prisma as any).productItem.groupBy({ by: ['categoryId'], where: { tenantId, categoryId: { in: categoryIds }, inventoryStatus: 'IN_USE' }, _count: { id: true } }),
    (prisma as any).productItem.groupBy({ by: ['categoryId'], where: { tenantId, categoryId: { in: categoryIds }, stockStatus: 'UNDER_MAINTENANCE' }, _count: { id: true } }),
    (prisma as any).productItem.groupBy({ by: ['categoryId'], where: { tenantId, categoryId: { in: categoryIds }, inventoryStatus: 'UNDER_MAINTENANCE' }, _count: { id: true } }),
    (prisma as any).productItem.groupBy({ by: ['categoryId'], where: { tenantId, categoryId: { in: categoryIds }, stockStatus: { in: ['FAULTY', 'COMPLETELY_BAD'] } }, _count: { id: true } }),
    (prisma as any).productItem.groupBy({ by: ['categoryId'], where: { tenantId, categoryId: { in: categoryIds }, inventoryStatus: { in: ['FAULTY', 'COMPLETELY_BAD'] } }, _count: { id: true } }),
  ]);

  const toMap = (groups: any[]) => {
    const m: Record<string, number> = {};
    for (const g of groups) m[g.categoryId] = g._count.id;
    return m;
  };

  const totalMap = toMap(totalByCategory);
  const stockAvailMap = toMap(stockAvailable);
  const invAvailMap = toMap(invAvailable);
  const stockDepMap = toMap(stockDeployed);
  const invInUseMap = toMap(invInUse);
  const stockMaintMap = toMap(stockMaintenance);
  const invMaintMap = toMap(invMaintenance);
  const stockFaultyMap = toMap(stockFaulty);
  const invFaultyMap = toMap(invFaulty);

  const result = new Map<string, Awaited<ReturnType<typeof buildCategoryStats>>>();
  for (const cat of categories) {
    const isStock = cat.type === 'STOCK';
    result.set(cat.id, {
      totalItems: totalMap[cat.id] ?? 0,
      availableCount: isStock ? (stockAvailMap[cat.id] ?? 0) : (invAvailMap[cat.id] ?? 0),
      ...(isStock
        ? { deployedCount: stockDepMap[cat.id] ?? 0 }
        : { inUseCount: invInUseMap[cat.id] ?? 0 }),
      maintenanceCount: isStock ? (stockMaintMap[cat.id] ?? 0) : (invMaintMap[cat.id] ?? 0),
      faultyCount: isStock ? (stockFaultyMap[cat.id] ?? 0) : (invFaultyMap[cat.id] ?? 0),
    });
  }
  return result;
};

const resolveStockStatus = (availableCount: number, reorderThreshold: number) => {
  if (availableCount === 0) return 'OUT_OF_STOCK';
  if (availableCount <= reorderThreshold) return 'LOW_STOCK';
  return 'IN_STOCK';
};

type CategoryStats = Awaited<ReturnType<typeof buildCategoryStats>>;

const formatCategory = (cat: any, stats: CategoryStats) => {
  const isStock = (cat.type ?? 'STOCK') === 'STOCK';
  const availableCount = stats.availableCount;
  return {
    id: cat.id,
    name: cat.name,
    abbreviation: cat.abbreviation ?? cat.sku,
    type: cat.type ?? 'STOCK',
    description: cat.description,
    supplier: cat.supplier,
    unit: cat.unit,
    costPrice: Number(cat.costPrice ?? 0),
    sellingPrice: cat.sellingPrice !== null && cat.sellingPrice !== undefined ? Number(cat.sellingPrice) : null,
    plannedQty: cat.plannedQty ?? 0,
    plannedDate: cat.plannedDate ?? null,
    invoiceApproved: cat.invoiceApproved ?? false,
    approvedInvoiceId: cat.approvedInvoiceId ?? null,
    reorderThreshold: cat.reorderThreshold,
    identifierType: cat.identifierType,
    identifierLabel: cat.identifierLabel,
    imageUrl: cat.imageUrl,
    images: Array.isArray(cat.images) ? cat.images : [],
    notes: cat.notes,
    ...stats,
    // stockStatus is only meaningful for STOCK categories
    stockStatus: isStock ? resolveStockStatus(availableCount, cat.reorderThreshold) : null,
    // totalValue: for STOCK = costPrice × available; for INVENTORY = costPrice × all owned items
    totalValue: Number(cat.costPrice ?? 0) * (isStock ? availableCount : stats.totalItems),
    createdAt: cat.createdAt,
    updatedAt: cat.updatedAt,
  };
};

// ── Category handlers ──────────────────────────────────────────────────────────

export const listCategories = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const search = req.query.search ? String(req.query.search) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const typeFilter = req.query.type ? String(req.query.type) : undefined;

    const where: any = { tenantId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { abbreviation: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (typeFilter === 'STOCK' || typeFilter === 'INVENTORY') {
      where.type = typeFilter;
    }

    const categories = await (prisma as any).inventoryCategory.findMany({
      where,
      orderBy: { name: 'asc' },
      ...(limit ? { take: limit } : {}),
    });

    const statsMap = await buildBatchCategoryStats(
      tenantId,
      categories.map((c: any) => ({ id: c.id, type: c.type ?? 'STOCK' })),
    );

    const data = categories.map((cat: any) =>
      formatCategory(cat, statsMap.get(cat.id)!),
    );

    return res.status(200).json({
      success: true,
      message: 'Inventory categories retrieved successfully',
      data,
    });
  } catch (error) {
    console.error('Error listing inventory categories:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve inventory categories',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getCategoryById = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const category = await fetchCategoryById(tenantId, String(req.params.id));
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    const [stats, invoices, documents] = await Promise.all([
      buildCategoryStats(tenantId, category.id, category.type ?? 'STOCK'),
      (prisma as any).invoice.findMany({
        where: { tenantId, categoryId: category.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
      }),
      (prisma as any).document.findMany({
        where: { tenantId, sourceModule: 'INVENTORY', sourceId: category.id },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Stock history: category-level stock events (new unit, deployed, maintenance, etc.)
    const stockLogs = await (prisma as any).categoryStockLog.findMany({
      where: { tenantId, categoryId: category.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const stockMovements = stockLogs.map((log: any) => ({
      id: log.id,
      systemId: log.unitSystemId ?? null,
      eventType: log.eventType,
      stockBefore: log.stockBefore,
      stockAfter: log.stockAfter,
      delta: log.delta,
      title: log.title,
      notes: log.notes,
      date: log.createdAt,
    }));

    // Current approved purchase invoice is the authoritative quota source
    const approvedInvoice =
      (category.approvedInvoiceId
        ? invoices.find(
            (i: any) =>
              i.id === category.approvedInvoiceId &&
              i.type === 'PURCHASE' &&
              i.status === 'APPROVED',
          )
        : null) ??
      invoices.find((i: any) => i.type === 'PURCHASE' && i.status === 'APPROVED') ??
      null;

    const authorisedQty: number | null =
      approvedInvoice?.authorisedQty != null ? Number(approvedInvoice.authorisedQty) : null;
    const addedQty: number | null =
      approvedInvoice != null ? Number(approvedInvoice.addedQty ?? 0) : null;
    const remainingQty: number | null =
      authorisedQty != null && addedQty != null ? Math.max(0, authorisedQty - addedQty) : null;

    return res.status(200).json({
      success: true,
      message: 'Category retrieved successfully',
      data: {
        ...formatCategory(category, stats),
        approvedInvoiceId: category.approvedInvoiceId ?? approvedInvoice?.id ?? null,
        authorisedQty,
        addedQty,
        remainingQty,
        stockMovements,
        invoices,
        documents,
      },
    });
  } catch (error) {
    console.error('Error fetching inventory category:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve inventory category',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const createCategory = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const parsed = CategorySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const data = parsed.data;

    // Validate: STOCK requires sellingPrice
    if ((data.type ?? 'STOCK') === 'STOCK' && (data.sellingPrice === undefined || data.sellingPrice < 0)) {
      // sellingPrice is optional to keep backward compat; only block if explicitly missing on creation
    }

    const abbrev = data.abbreviation.toUpperCase();
    const identifierLabel = resolveIdentifierLabel(data.identifierType, data.identifierLabel);

    const category = await (prisma as any).inventoryCategory.create({
      data: {
        tenantId,
        name: data.name,
        sku: abbrev,
        abbreviation: abbrev,
        type: (data.type ?? 'STOCK') as any,
        description: data.description ?? null,
        supplier: data.supplier ?? null,
        costPrice: (data.costPrice ?? 0) as any,
        sellingPrice: data.sellingPrice !== undefined ? (data.sellingPrice as any) : null,
        plannedQty: data.plannedQty ?? 0,
        plannedDate: data.plannedDate ? new Date(data.plannedDate) : null,
        reorderThreshold: data.reorderThreshold ?? 0,
        identifierType: (data.identifierType ?? 'NONE') as any,
        identifierLabel,
        imageUrl: data.imageUrl || null,
        images: data.images ?? [],
        notes: data.notes ?? null,
        invoiceApproved: false,
      },
    });

    // Create a PURCHASE invoice so finance can approve it before units are added
    let invoice = null;
    const submittedBy = req.user?.id;
    if (submittedBy) {
      try {
        invoice = await createPurchaseInvoice({ tenantId, categoryId: category.id, submittedBy });
      } catch (err) {
        console.error('[invoice] Error creating purchase invoice for new category:', err);
      }
    }

    broadcastToModule(tenantId, 'inventory', {
      type: 'inventory.category.created',
      title: 'New Inventory Category',
      message: `Category "${data.name}" (${abbrev}) has been added.`,
      link: '/inventory/categories',
    }).catch((err: any) => console.error('[notify] category created:', err));

    const emptyStats: CategoryStats = {
      totalItems: 0,
      availableCount: 0,
      ...(data.type === 'INVENTORY' ? { inUseCount: 0 } : { deployedCount: 0 }),
      maintenanceCount: 0,
      faultyCount: 0,
    };

    void logAudit({
      tenantId,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PRODUCT_CREATED',
      module: 'inventory',
      entityType: 'InventoryCategory',
      entityId: category.id,
      entityLabel: category.name,
      details: { name: category.name, type: category.type, costPrice: category.costPrice, plannedQty: category.plannedQty },
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: { category: formatCategory(category, emptyStats), invoice },
    });
  } catch (error) {
    console.error('Error creating inventory category:', error);
    const msg = error instanceof Error ? error.message : '';
    if (
      msg.includes('inventory_categories_tenant_id_sku_key') ||
      (msg.includes('unique') && msg.toLowerCase().includes('sku'))
    ) {
      return res.status(409).json({
        success: false,
        message: 'A category with this abbreviation already exists. Please use a different abbreviation.',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to create category',
      error: msg || 'Unknown error',
    });
  }
};

export const updateCategory = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const parsed = CategorySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const existing = await fetchCategoryById(tenantId, String(req.params.id));
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    // Determine which images were removed so we can clean up Supabase storage
    const oldImages: string[] = Array.isArray(existing.images) ? existing.images : [];

    const data = parsed.data;
    const nextAbbrev = data.abbreviation ? data.abbreviation.toUpperCase() : undefined;

    let identifierLabel: string | null | undefined = undefined;
    if (data.identifierType !== undefined || data.identifierLabel !== undefined) {
      const resolvedType = data.identifierType ?? (existing.identifierType as string | undefined);
      identifierLabel = resolveIdentifierLabel(resolvedType, data.identifierLabel);
    }

    const updated = await (prisma as any).inventoryCategory.update({
      where: { id: req.params.id },
      data: {
        name: data.name ?? undefined,
        sku: nextAbbrev,
        abbreviation: nextAbbrev,
        description: data.description !== undefined ? data.description : undefined,
        supplier: data.supplier !== undefined ? data.supplier : undefined,
        costPrice: data.costPrice !== undefined ? (data.costPrice as any) : undefined,
        sellingPrice: data.sellingPrice !== undefined ? (data.sellingPrice as any) : undefined,
        reorderThreshold: data.reorderThreshold !== undefined ? data.reorderThreshold : undefined,
        identifierType: data.identifierType !== undefined ? (data.identifierType as any) : undefined,
        identifierLabel: identifierLabel !== undefined ? identifierLabel : undefined,
        imageUrl: data.imageUrl !== undefined ? (data.imageUrl || null) : undefined,
        images: data.images !== undefined ? data.images : undefined,
        notes: data.notes !== undefined ? data.notes : undefined,
      },
    });

    // Delete removed images from storage (fire-and-forget)
    if (data.images !== undefined) {
      const newSet = new Set(data.images);
      const removed = oldImages.filter((url) => !newSet.has(url));
      if (removed.length) deleteStorageFiles(removed).catch(() => {});
    }

    const stats = await buildCategoryStats(tenantId, updated.id, updated.type ?? 'STOCK');

    void logAudit({
      tenantId,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PRODUCT_UPDATED',
      module: 'inventory',
      entityType: 'InventoryCategory',
      entityId: updated.id,
      entityLabel: updated.name,
      details: buildDiff(existing as any, updated as any),
      ...extractRequestContext(req),
    });

    broadcastToModule(tenantId, 'inventory', {
      type: 'inventory.category.updated',
      title: 'Inventory Category Updated',
      message: `Category "${updated.name}" has been updated.`,
      link: '/inventory/categories',
    }).catch((err: any) => console.error('[notify] category updated:', err));

    return res.status(200).json({
      success: true,
      message: 'Category updated successfully',
      data: formatCategory(updated, stats),
    });
  } catch (error) {
    console.error('Error updating inventory category:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update category',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const deleteCategory = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const category = await fetchCategoryById(tenantId, String(req.params.id));
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    const productItemCount = await (prisma as any).productItem.count({
      where: { tenantId, categoryId: req.params.id },
    });
    if (productItemCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'Category has serialised items and cannot be deleted. Remove all items first.',
      });
    }

    await (prisma as any).inventoryCategory.delete({ where: { id: req.params.id } });

    void logAudit({
      tenantId,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PRODUCT_DELETED',
      module: 'inventory',
      entityType: 'InventoryCategory',
      entityId: category.id,
      entityLabel: category.name,
      ...extractRequestContext(req),
    });

    // Clean up images from storage (fire-and-forget)
    const storedImages: string[] = Array.isArray(category.images) ? category.images : [];
    if (category.imageUrl) storedImages.push(category.imageUrl);
    const uniqueImages = [...new Set(storedImages)];
    if (uniqueImages.length) deleteStorageFiles(uniqueImages).catch(() => {});

    broadcastToModule(tenantId, 'inventory', {
      type: 'inventory.category.deleted',
      title: 'Inventory Category Deleted',
      message: `Category "${category.name}" has been removed.`,
      link: '/inventory/categories',
    }).catch((err: any) => console.error('[notify] category deleted:', err));

    return res.status(200).json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Error deleting inventory category:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete category',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const checkCategoryAvailability = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const requested = req.query.quantity ? parseInt(req.query.quantity as string, 10) : 0;
    if (!requested || requested < 1) {
      return res.status(400).json({
        success: false,
        message: 'quantity query param must be a positive integer',
      });
    }

    const category = await (prisma as any).inventoryCategory.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    const [available, items] = await Promise.all([
      (prisma as any).productItem.count({
        where: { tenantId, categoryId: req.params.id, [statusField(category.type ?? 'STOCK')]: 'AVAILABLE' },
      }),
      (prisma as any).productItem.findMany({
        where: { tenantId, categoryId: req.params.id, [statusField(category.type ?? 'STOCK')]: 'AVAILABLE' },
        orderBy: { createdAt: 'asc' },
        take: requested,
      }),
    ]);

    return res.json({
      success: true,
      message: 'Availability checked successfully',
      data: {
        categoryId: req.params.id,
        requested,
        available,
        canFulfil: available >= requested,
        items,
      },
    });
  } catch (error) {
    console.error('Error checking category availability:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to check availability',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// ── ProductItem handlers ───────────────────────────────────────────────────────

export const createProductItem = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const userId = req.user?.id;
    const parsed = ProductItemCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const { categoryId, name, identifierMode, userIdentifier, notes, status } = parsed.data;

    if (identifierMode === 'manual' && !userIdentifier?.trim()) {
      return res.status(422).json({
        success: false,
        message: 'Identifier is required when mode is set to Manual.',
      });
    }

    const category = await (prisma as any).inventoryCategory.findFirst({
      where: { id: categoryId, tenantId },
    });
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    // Guard: invoice must be approved before any units can be added
    if (!category.invoiceApproved) {
      const pendingInvoice = await (prisma as any).invoice.findFirst({
        where: { categoryId, tenantId, type: 'PURCHASE', status: { in: ['PENDING', 'REJECTED'] } },
        orderBy: { createdAt: 'desc' },
      });
      return res.status(403).json({
        success: false,
        error: {
          code: 'INVOICE_NOT_APPROVED',
          message: 'Cannot add units to this product. The purchase invoice is pending finance approval.',
          invoiceId: pendingInvoice?.id ?? null,
          invoiceNumber: pendingInvoice?.invoiceNumber ?? null,
        },
      });
    }

    // Guard: authorised quantity check
    const linkedApproved = category.approvedInvoiceId
      ? await (prisma as any).invoice.findUnique({
          where: { id: category.approvedInvoiceId },
        })
      : null;
    const approvedInvoice =
      linkedApproved &&
      linkedApproved.type === 'PURCHASE' &&
      linkedApproved.status === 'APPROVED'
        ? linkedApproved
        : await (prisma as any).invoice.findFirst({
            where: { categoryId, tenantId, type: 'PURCHASE', status: 'APPROVED' },
            orderBy: { createdAt: 'desc' },
          });
    if (approvedInvoice) {
      const authorisedQty: number = approvedInvoice.authorisedQty ?? 0;
      const addedQty: number = approvedInvoice.addedQty ?? 0;
      if (addedQty >= authorisedQty) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'AUTHORISED_QTY_EXCEEDED',
            message: `Cannot add more units than authorised. Authorised: ${authorisedQty}, Already added: ${addedQty}, Remaining: 0.`,
          },
        });
      }
    }
    const catType: string = category.type ?? 'STOCK';
    const validStatusSet = catType === 'INVENTORY' ? INVENTORY_STATUSES : STOCK_STATUSES;

    // Validate provided status against the correct enum for this category type
    if (status && !validStatusSet.has(status)) {
      return res.status(422).json({
        success: false,
        message: catType === 'INVENTORY'
          ? `Invalid status for inventory item. Valid values: ${[...INVENTORY_STATUSES].join(', ')}.`
          : `Invalid status for stock item. Valid values: ${[...STOCK_STATUSES].join(', ')}.`,
      });
    }

    const abbrev = category.abbreviation ?? category.sku;
    const systemId = await generateSystemId(abbrev, tenantId);
    const resolvedUserIdentifier =
      identifierMode === 'auto' ? systemId : (userIdentifier?.trim() ?? null);

    // Set the correct status field based on category type
    const statusData =
      catType === 'INVENTORY'
        ? { inventoryStatus: (status ?? 'AVAILABLE') as any, stockStatus: null }
        : { stockStatus: (status ?? 'AVAILABLE') as any, inventoryStatus: null };

    const item = await (prisma as any).productItem.create({
      data: {
        tenantId,
        categoryId,
        systemId,
        name: name?.trim() ?? null,
        userIdentifier: resolvedUserIdentifier,
        notes: notes?.trim() ?? null,
        ...statusData,
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            abbreviation: true,
            identifierType: true,
            identifierLabel: true,
          },
        },
      },
    });

    // Deduct unit cost from the approved purchase invoice and create expense transaction
    if (userId) {
      try {
        await deductUnitCost(item.id, categoryId, tenantId);
      } catch (err) {
        console.error('[invoice] Error deducting unit cost:', err);
      }
    }

    // Mark as addedAfterInvoice
    await (prisma as any).productItem.update({
      where: { id: item.id },
      data: { addedAfterInvoice: true },
    }).catch(() => {});

    broadcastToModule(tenantId, 'inventory', {
      type: 'inventory.item.created',
      title: 'New Item Added',
      message: `Item ${systemId} added to ${category.name}.`,
      link: `/inventory/categories/${categoryId}/items`,
    }).catch((err: any) => console.error('[notify] item created:', err));

    // Record stock event
    const initialStatus = (catType === 'INVENTORY' ? item.inventoryStatus : item.stockStatus) ?? 'AVAILABLE';
    const delta = isAvailableStatus(initialStatus) ? 1 : 0;
    await recordStockEvent({
      tenantId,
      categoryId,
      categoryType: catType,
      unitSystemId: systemId,
      eventType: 'NEW_UNIT',
      delta,
      title: `New unit added: ${systemId}`,
      notes: item.notes ?? null,
      performedBy: userId ?? null,
    });

    void logAudit({
      tenantId,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'UNIT_ADDED',
      module: 'inventory',
      entityType: 'ProductItem',
      entityId: item.id,
      entityLabel: systemId,
      details: { systemId, userIdentifier: item.userIdentifier, status: initialStatus },
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: 'Item created successfully',
      data: item,
    });
  } catch (error) {
    console.error('Error creating product item:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create item',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// Kept for backward compatibility with project assignment endpoint
export const createProductItems = createProductItem;

// ── restockRequest ─────────────────────────────────────────────────────────────

const RestockRequestSchema = z.object({
  quantity: z.coerce.number().int().positive(),
  costPrice: z.coerce.number().nonnegative().optional(),
  plannedDate: z.string().optional(),
  notes: z.string().optional(),
});

export const restockRequest = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const submittedBy = req.user?.id;

    if (!submittedBy) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const parsed = RestockRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    const category = await (prisma as any).inventoryCategory.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    const { quantity, costPrice, plannedDate, notes } = parsed.data;
    const effectiveCostPrice = costPrice ?? Number(category.costPrice ?? 0);

    // Update category's plannedQty and optionally costPrice for this restock
    await (prisma as any).inventoryCategory.update({
      where: { id: category.id },
      data: {
        plannedQty: quantity,
        plannedDate: plannedDate ? new Date(plannedDate) : undefined,
        costPrice: costPrice !== undefined ? (costPrice as any) : undefined,
        invoiceApproved: false, // must re-approve for new batch
      },
    });

    const { createPurchaseInvoice: createInvoice } = await import('../services/invoiceService.js');
    const invoice = await createInvoice({ tenantId, categoryId: category.id, submittedBy });

    if (notes) {
      await (prisma as any).invoice.update({
        where: { id: invoice.id },
        data: { notes },
      });
    }

    void logAudit({
      tenantId,
      actorType: req.user?.accountType === 'employee' ? AuditActorType.EMPLOYEE : AuditActorType.OWNER,
      actorId: req.user?.id,
      action: 'RESTOCK_REQUESTED',
      module: 'inventory',
      entityType: 'InventoryCategory',
      entityId: category.id,
      entityLabel: category.name,
      details: { quantity, effectiveCostPrice },
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: 'Restock request submitted successfully. Awaiting finance approval.',
      data: { invoice, effectiveCostPrice, quantity },
    });
  } catch (error) {
    console.error('Error creating restock request:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create restock request',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const listProductItems = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const categoryId = req.query.categoryId ? String(req.query.categoryId) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const skip = (page - 1) * limit;

    if (!categoryId) {
      return res.status(400).json({ success: false, message: 'categoryId query param is required' });
    }

    const where: any = { tenantId, categoryId };
    if (status) {
      // Status may be in either column depending on category type — search both
      where.OR = [
        { stockStatus: status },
        { inventoryStatus: status },
      ];
    }
    if (search) {
      where.OR = [
        { systemId: { contains: search, mode: 'insensitive' } },
        { userIdentifier: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      (prisma as any).productItem.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      (prisma as any).productItem.count({ where }),
    ]);

    return res.json({
      success: true,
      message: 'Items retrieved successfully',
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error listing product items:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve items',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getProductItem = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const item = await (prisma as any).productItem.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        maintenanceLogs: { orderBy: { createdAt: 'desc' } },
        category: {
          select: {
            id: true,
            name: true,
            abbreviation: true,
            sku: true,
            type: true,
            identifierType: true,
            identifierLabel: true,
          },
        },
      },
    });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    const data = {
      ...item,
      category: item.category
        ? { ...item.category, abbreviation: item.category.abbreviation ?? item.category.sku }
        : undefined,
    };
    return res.json({ success: true, message: 'Item retrieved successfully', data });
  } catch (error) {
    console.error('Error fetching product item:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve item',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateProductItem = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const userId = req.user?.id ?? '';
    const parsed = ProductItemUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const existing = await (prisma as any).productItem.findFirst({
      where: { id: req.params.id, tenantId },
      include: { category: { select: { id: true, type: true } } },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const catType: string = existing.category?.type ?? 'STOCK';
    const validStatusSet = catType === 'INVENTORY' ? INVENTORY_STATUSES : STOCK_STATUSES;

    const { name, userIdentifier, notes, imageUrl, status } = parsed.data;

    if (status && !validStatusSet.has(status)) {
      return res.status(422).json({
        success: false,
        message: catType === 'INVENTORY'
          ? 'Invalid status for inventory item.'
          : 'Invalid status for stock item.',
      });
    }

    const currentStatus = getItemStatus(existing, catType);
    const statusChanged = status !== undefined && status !== currentStatus;

    // Build status update for the correct column
    const statusUpdate: any = {};
    if (status !== undefined) {
      if (catType === 'INVENTORY') {
        statusUpdate.inventoryStatus = status;
      } else {
        statusUpdate.stockStatus = status;
      }
    }

    const updated = await (prisma as any).productItem.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: name.trim() || null }),
        ...(userIdentifier !== undefined && { userIdentifier }),
        ...(notes !== undefined && { notes }),
        ...statusUpdate,
        ...(imageUrl !== undefined && { imageUrl: imageUrl || null }),
      },
    });

    if (statusChanged) {
      await (prisma as any).productItemMaintenanceLog.create({
        data: {
          tenantId,
          productItemId: existing.id,
          performedBy: userId,
          statusBefore: currentStatus,
          statusAfter: status,
          title: 'Status updated',
          notes: null,
        },
      });
      const { eventType, delta } = resolveEventType(currentStatus!, status!);
      await recordStockEvent({
        tenantId,
        categoryId: existing.categoryId,
        categoryType: catType,
        unitSystemId: existing.systemId,
        eventType,
        delta,
        title: `Status updated: ${existing.systemId}`,
        notes: null,
        performedBy: userId,
      });
      void logAudit({
        tenantId,
        actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
        actorId: req.user?.id,
        action: 'UNIT_STATUS_CHANGED',
        module: 'inventory',
        entityType: 'ProductItem',
        entityId: existing.id,
        entityLabel: existing.systemId,
        details: { systemId: existing.systemId, from: currentStatus, to: status },
        ...extractRequestContext(req),
      });
    }

    return res.json({ success: true, message: 'Item updated successfully', data: updated });
  } catch (error) {
    console.error('Error updating product item:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update item',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const deleteProductItem = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const item = await (prisma as any).productItem.findFirst({
      where: { id: req.params.id, tenantId },
      include: { category: { select: { type: true } } },
    });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    const catType: string = item.category?.type ?? 'STOCK';
    const currentStatus = getItemStatus(item, catType);
    const deployedStatus = catType === 'INVENTORY' ? 'IN_USE' : 'DEPLOYED';
    if (currentStatus === deployedStatus) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete a deployed item. Remove it from the project first.',
      });
    }
    if (currentStatus === 'UNDER_MAINTENANCE' || currentStatus === 'FAULTY') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete an item with active maintenance record.',
      });
    }
    await (prisma as any).productItemMaintenanceLog.deleteMany({ where: { productItemId: req.params.id } });
    await (prisma as any).productItem.delete({ where: { id: req.params.id } });

    // Record stock event for removed unit (if it was available, count drops)
    const delta = isAvailableStatus(currentStatus ?? '') ? -1 : 0;
    await recordStockEvent({
      tenantId,
      categoryId: item.categoryId,
      categoryType: catType,
      unitSystemId: item.systemId,
      eventType: 'REMOVED',
      delta,
      title: `Unit removed: ${item.systemId}`,
      notes: null,
      performedBy: (req as any).user?.id ?? null,
    });
    void logAudit({
      tenantId,
      actorType: req.user?.accountType === 'employee' ? AuditActorType.EMPLOYEE : AuditActorType.OWNER,
      actorId: req.user?.id,
      action: 'PRODUCT_ITEM_DELETED',
      module: 'inventory',
      entityType: 'ProductItem',
      entityId: req.params.id,
      entityLabel: item.systemId,
      details: { categoryId: item.categoryId, status: getItemStatus(item, catType) },
      ...extractRequestContext(req),
    });
    return res.json({ success: true, message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting product item:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete item',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// ── Maintenance log handlers ───────────────────────────────────────────────────

export const logMaintenance = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const userId = req.user?.id ?? '';
    const parsed = MaintenanceLogSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const item = await (prisma as any).productItem.findFirst({
      where: { id: req.params.id, tenantId },
      include: { category: { select: { type: true } } },
    });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const catType: string = item.category?.type ?? 'STOCK';
    const validStatusSet = catType === 'INVENTORY' ? INVENTORY_STATUSES : STOCK_STATUSES;

    const { title, notes, newStatus } = parsed.data;

    if (!validStatusSet.has(newStatus)) {
      return res.status(422).json({
        success: false,
        message: catType === 'INVENTORY'
          ? 'Invalid status for inventory item.'
          : 'Invalid status for stock item.',
      });
    }

    const currentStatus = getItemStatus(item, catType) ?? 'AVAILABLE';

    await (prisma as any).productItemMaintenanceLog.create({
      data: {
        tenantId,
        productItemId: item.id,
        performedBy: userId,
        statusBefore: currentStatus,
        statusAfter: newStatus,
        title,
        notes: notes ?? null,
      },
    });

    const statusUpdate =
      catType === 'INVENTORY'
        ? { inventoryStatus: newStatus as any }
        : { stockStatus: newStatus as any };

    const updated = await (prisma as any).productItem.update({
      where: { id: item.id },
      data: statusUpdate,
      include: { maintenanceLogs: { orderBy: { createdAt: 'desc' } } },
    });

    // Record category-level stock event
    const { eventType, delta } = resolveEventType(currentStatus, newStatus);
    await recordStockEvent({
      tenantId,
      categoryId: item.categoryId,
      categoryType: catType,
      unitSystemId: item.systemId,
      eventType,
      delta,
      title,
      notes: notes ?? null,
      performedBy: userId,
    });

    void logAudit({
      tenantId,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'MAINTENANCE_LOGGED',
      module: 'inventory',
      entityType: 'ProductItem',
      entityId: item.id,
      entityLabel: item.systemId,
      details: { systemId: item.systemId, title, statusBefore: currentStatus, statusAfter: newStatus },
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: 'Maintenance event logged successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Error logging maintenance event:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to log maintenance event',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getMaintenanceLogs = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const item = await (prisma as any).productItem.findFirst({
      where: { id: req.params.id, tenantId },
      select: { id: true },
    });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const logs = await (prisma as any).productItemMaintenanceLog.findMany({
      where: { tenantId, productItemId: item.id },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      success: true,
      message: 'Maintenance logs retrieved successfully',
      data: logs,
    });
  } catch (error) {
    console.error('Error fetching maintenance logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve maintenance logs',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};