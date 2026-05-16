import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { tenantGuard, moduleGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { broadcastToModule } from '../services/notificationService.js';
import { createMovement } from '../controllers/inventory.controller.js';
import {
  listCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  checkCategoryAvailability,
  createProductItem,
  createProductItems,
  listProductItems,
  getProductItem,
  updateProductItem,
  deleteProductItem,
  logMaintenance,
  getMaintenanceLogs,
  restockRequest,
} from '../controllers/inventory.items.controller.js';

const router = Router();
router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('inventory'));

const ProductSchema = z.object({
  name: z.string().min(1),
  categoryId: z.string().min(1),
  stock: z.coerce.number().int().nonnegative(),
  price: z.coerce.number().nonnegative(),
  lowStockAt: z.coerce.number().int().nonnegative().optional(),
  supplier: z.string().optional(),
  description: z.string().optional(),
  images: z.array(z.string()).optional(),
  imageUrl: z.string().optional(),
  reason: z.string().optional(),
});

const RestockSchema = z.object({
  quantity: z.coerce.number().int().positive(),
  unitCost: z.coerce.number().positive().optional(),
  note: z.string().optional(),
});

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';
const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'solarflow-files'; // TODO: rename bucket to 'stockvero-files' in Supabase before production migration
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const parseItemMeta = (description?: string | null) => {
  if (!description) {
    return { notes: '', supplier: '', images: [] as string[] };
  }
  try {
    const parsed = JSON.parse(description);
    if (parsed && typeof parsed === 'object') {
      const images = Array.isArray((parsed as any).images)
        ? (parsed as any).images
        : (parsed as any).imageUrl
          ? [(parsed as any).imageUrl]
          : [];
      return {
        notes: String((parsed as any).notes ?? ''),
        supplier: String((parsed as any).supplier ?? ''),
        images,
      };
    }
  } catch {
    // ignore JSON parse errors
  }
  return { notes: description, supplier: '', images: [] as string[] };
};

const buildItemDescription = (notes?: string, supplier?: string, images?: string[]) =>
  JSON.stringify({
    notes: notes ?? '',
    supplier: supplier ?? '',
    images: images ?? [],
  });

const resolveSignedUrl = async (url: string) => {
  if (!supabase) return url;
  try {
    const parsed = new URL(url);
    const supabaseOrigin = new URL(supabaseUrl).origin;
    const publicPrefix = `/storage/v1/object/public/${bucket}/`;
    const signedPrefix = `/storage/v1/object/sign/${bucket}/`;

    if (parsed.origin !== supabaseOrigin) return url;
    if (parsed.pathname.includes(signedPrefix)) return url;
    if (!parsed.pathname.includes(publicPrefix)) return url;

    const key = decodeURIComponent(parsed.pathname.split(publicPrefix)[1] ?? '');
    if (!key) return url;

    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(key, 60 * 60);
    if (error || !data?.signedUrl) return url;
    return data.signedUrl;
  } catch {
    return url;
  }
};

const resolveImageUrls = async (images: string[]) => {
  if (!images.length) return images;
  return Promise.all(images.map((img) => resolveSignedUrl(img)));
};

const resolveStatus = (quantity: number, lowStockAt: number) => {
  if (quantity <= 0) return 'OUT_OF_STOCK';
  if (quantity <= lowStockAt) return 'LOW_STOCK';
  return 'IN_STOCK';
};

const fetchCategoryById = async (tenantId: string, id: string) => {
  return (prisma as any).inventoryCategory.findFirst({ where: { tenantId, id } });
};

const fetchCategoriesByTenant = async (tenantId: string) => {
  return (prisma as any).inventoryCategory.findMany({ where: { tenantId }, orderBy: { name: 'asc' } }) as any[];
};

const resolveCategoryName = async (tenantId: string, categoryId: string) => {
  const category = await fetchCategoryById(tenantId, categoryId);
  return category?.name ?? null;
};

const generateSku = async (tenantId: string, abbreviation: string) => {
  const prefix = abbreviation.trim().toUpperCase().slice(0, 5) || 'ITM';
  for (let i = 0; i < 5; i += 1) {
    const token = crypto.randomBytes(3).toString('hex').toUpperCase();
    const candidate = `${prefix}-${token}`;
    const existing = await prisma.inventoryItem.findFirst({
      where: { tenantId, sku: candidate },
    });
    if (!existing) return candidate;
  }
  return `${prefix}-${Date.now().toString(36).slice(-6).toUpperCase()}`;
};

/**
 * Products API (frontend integration layer)
 */
router.get('/products', permissionGuard('inventory', 'canRead'), async (req, res) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const search = req.query.search ? String(req.query.search) : undefined;
    const category = req.query.category ? String(req.query.category) : undefined;

    const where: any = { tenantId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (category) {
      const categoryName = await resolveCategoryName(tenantId, category);
      where.category = categoryName ?? category;
    }

    const [items, categories] = await Promise.all([
      prisma.inventoryItem.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      }),
      fetchCategoriesByTenant(tenantId),
    ]);

    const categoryMap = new Map(categories.map((c) => [c.name, c]));

    const data = await Promise.all(items.map(async (item) => {
      const meta = parseItemMeta(item.description);
      const categoryRow = item.category ? categoryMap.get(item.category) : null;
      const images = await resolveImageUrls(meta.images || []);
      return {
        id: item.id,
        sku: item.sku,
        name: item.name,
        category: item.category,
        categoryId: categoryRow?.id ?? null,
        stock: item.quantity,
        price: Number(item.unitCost),
        lowStockAt: item.lowStockAt,
        supplier: meta.supplier || null,
        notes: meta.notes || null,
        images,
        status: item.status,
      };
    }));

    return res.json({
      success: true,
      message: 'Inventory products retrieved successfully',
      data,
    });
  } catch (error) {
    console.error('Error listing inventory products:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve inventory products',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/products/:id', permissionGuard('inventory', 'canRead'), async (req, res) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const id = String(req.params.id);
    const item = await prisma.inventoryItem.findFirst({
      where: { id, tenantId },
    });
    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
      });
    }

    const categories = await fetchCategoriesByTenant(tenantId);
    const categoryMap = new Map(categories.map((c) => [c.name, c]));
    const meta = parseItemMeta(item.description);
    const images = await resolveImageUrls(meta.images || []);
    const categoryRow = item.category ? categoryMap.get(item.category) : null;

    return res.json({
      success: true,
      message: 'Inventory product retrieved successfully',
      data: {
        id: item.id,
        sku: item.sku,
        name: item.name,
        category: item.category,
        categoryId: categoryRow?.id ?? null,
        stock: item.quantity,
        price: Number(item.unitCost),
        lowStockAt: item.lowStockAt,
        supplier: meta.supplier || null,
        notes: meta.notes || null,
        images,
        status: item.status,
      },
    });
  } catch (error) {
    console.error('Error fetching inventory product:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve inventory product',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/products/:id/movements', permissionGuard('inventory', 'canRead'), async (req, res) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const id = String(req.params.id);
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const skip = (page - 1) * limit;

    const product = await prisma.inventoryItem.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Inventory product not found',
      });
    }

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where: { tenantId, productId: product.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          project: { select: { id: true, name: true } },
        },
      }),
      prisma.stockMovement.count({
        where: { tenantId, productId: product.id },
      }),
    ]);

    const data = movements.map((movement) => ({
      id: movement.id,
      type: movement.type,
      quantity: movement.quantity,
      stockBefore: movement.stockBefore,
      stockAfter: movement.stockAfter,
      note: movement.note,
      createdAt: movement.createdAt,
      projectId: movement.projectId,
      projectName: movement.project?.name ?? null,
    }));

    return res.json({
      success: true,
      message: 'Stock movements retrieved successfully',
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error fetching stock movements:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve stock movements',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/products', permissionGuard('inventory', 'canCreate'), async (req, res) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const parsed = ProductSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const data = parsed.data;
    const categoryName = await resolveCategoryName(tenantId, data.categoryId);
    if (!categoryName) {
      return res.status(400).json({
        success: false,
        message: 'Category not found',
      });
    }

    const category = await fetchCategoryById(tenantId, data.categoryId);
    const sku = await generateSku(tenantId, category?.abbreviation ?? categoryName);

    const images = data.images ?? (data.imageUrl ? [data.imageUrl] : []);
    const description = buildItemDescription(data.description, data.supplier, images);
    const status = resolveStatus(data.stock, data.lowStockAt ?? 5);

    const item = await prisma.inventoryItem.create({
      data: {
        tenantId,
        sku,
        name: data.name,
        description,
        category: categoryName,
        quantity: data.stock,
        unitCost: data.price as any,
        unit: data.supplier ?? null,
        lowStockAt: data.lowStockAt ?? 5,
        status: status as any,
      },
    });

    // Finance tracking handled via invoiceService for serialised items

    // Record initial stock movement
    await prisma.stockMovement.create({
      data: {
        tenantId,
        productId: item.id,
        type: 'RESTOCK',
        quantity: data.stock,
        stockBefore: 0,
        stockAfter: data.stock,
        note: `Initial stock: ${data.stock} units of ${item.name}`,
      },
    });

    // Finance tracking handled via invoiceService for serialised items

    const responseImages = await resolveImageUrls(images);
    return res.status(201).json({
      success: true,
      message: 'Inventory product created successfully',
      data: {
        id: item.id,
        sku: item.sku,
        name: item.name,
        category: categoryName,
        categoryId: data.categoryId,
        stock: item.quantity,
        price: Number(item.unitCost),
        lowStockAt: item.lowStockAt,
        supplier: data.supplier ?? null,
        notes: data.description ?? null,
        images: responseImages,
        status: item.status,
      },
    });
  } catch (error) {
    console.error('Error creating inventory product:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create inventory product',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.patch('/products/:id/restock', permissionGuard('inventory', 'canUpdate'), async (req, res) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const parsed = RestockSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const existing = await prisma.inventoryItem.findFirst({
      where: { id: String(req.params.id), tenantId },
    });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Inventory product not found',
      });
    }

    const { quantity, unitCost, note } = parsed.data;
    const stockBefore = existing.quantity;
    const stockAfter = stockBefore + quantity;
    const resolvedUnitCost = unitCost ?? Number(existing.unitCost);
    const status = resolveStatus(stockAfter, existing.lowStockAt);

    const [updated] = await prisma.$transaction([
      prisma.inventoryItem.update({
        where: { id: existing.id },
        data: {
          quantity: stockAfter,
          unitCost: unitCost ?? undefined,
          status: status as any,
        },
      }),
      prisma.stockMovement.create({
        data: {
          tenantId,
          productId: existing.id,
          type: 'RESTOCK',
          quantity,
          stockBefore,
          stockAfter,
          note: note ?? `Restocked ${quantity} units`,
        },
      }),
    ]);

    const meta = parseItemMeta(updated.description);
    const categories = await fetchCategoriesByTenant(tenantId);
    const categoryMap = new Map(categories.map((c) => [c.name, c]));
    const categoryRow = updated.category ? categoryMap.get(updated.category) : null;
    const responseImages = await resolveImageUrls(meta.images || []);

    // Finance tracking handled via invoiceService for serialised items

    return res.json({
      success: true,
      message: 'Inventory product restocked successfully',
      data: {
        id: updated.id,
        sku: updated.sku,
        name: updated.name,
        category: updated.category,
        categoryId: categoryRow?.id ?? null,
        stock: updated.quantity,
        price: Number(updated.unitCost),
        lowStockAt: updated.lowStockAt,
        supplier: meta.supplier || null,
        notes: meta.notes || null,
        images: responseImages,
        status: updated.status,
      },
    });
  } catch (error) {
    console.error('Error restocking inventory product:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to restock inventory product',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.patch('/products/:id', permissionGuard('inventory', 'canUpdate'), async (req, res) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const parsed = ProductSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const existing = await prisma.inventoryItem.findFirst({
      where: { id: String(req.params.id), tenantId },
    });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Inventory product not found',
      });
    }

    const payload = parsed.data;
    let categoryName = existing.category;
    let categoryId: string | null = null;
    if (payload.categoryId) {
      categoryName = await resolveCategoryName(tenantId, payload.categoryId);
      if (!categoryName) {
        return res.status(400).json({
          success: false,
          message: 'Category not found',
        });
      }
      categoryId = payload.categoryId;
    }

    const currentMeta = parseItemMeta(existing.description);
    const nextNotes = payload.description ?? currentMeta.notes;
    const nextSupplier = payload.supplier ?? currentMeta.supplier;
    const nextImages = payload.images !== undefined
      ? payload.images
      : payload.imageUrl
        ? [payload.imageUrl]
        : currentMeta.images;
    const nextDescription = buildItemDescription(nextNotes, nextSupplier, nextImages);

    const nextQuantity = payload.stock ?? existing.quantity;
    const nextLowStockAt = payload.lowStockAt ?? existing.lowStockAt;
    const status = resolveStatus(nextQuantity, nextLowStockAt);
    const quantityDelta = nextQuantity - existing.quantity;

    const updated = await prisma.inventoryItem.update({
      where: { id: existing.id },
      data: {
        name: payload.name ?? undefined,
        category: categoryName ?? undefined,
        quantity: payload.stock ?? undefined,
        unitCost: payload.price ?? undefined,
        lowStockAt: payload.lowStockAt ?? undefined,
        description: nextDescription,
        unit: payload.supplier ?? undefined,
        status: status as any,
      },
    });

    // If quantity changed, record a stock movement and submit to finance queue
    if (quantityDelta !== 0) {
      const deltaAbs = Math.abs(quantityDelta);
      const movementType = quantityDelta > 0 ? 'RESTOCK' : 'DEDUCTION';
      const defaultNote = quantityDelta > 0
        ? `Stock increased by ${deltaAbs} units (manual edit)`
        : `Stock decreased by ${deltaAbs} units (manual edit)`;
      const movementNote = (payload as any).reason?.trim() || defaultNote;

      await prisma.stockMovement.create({
        data: {
          tenantId,
          productId: existing.id,
          type: movementType,
          quantity: deltaAbs,
          stockBefore: existing.quantity,
          stockAfter: nextQuantity,
          note: movementNote,
        },
      });

      const submittedBy = (req as any).user?.id as string | undefined;
      if (submittedBy) {
        // Finance tracking via invoiceService — no queue entries for legacy InventoryItem
        void submittedBy; // suppress unused-var warning
      }
    }

    const responseImages = await resolveImageUrls(nextImages || []);
    return res.json({
      success: true,
      message: 'Inventory product updated successfully',
      data: {
        id: updated.id,
        sku: updated.sku,
        name: updated.name,
        category: updated.category,
        categoryId,
        stock: updated.quantity,
        price: Number(updated.unitCost),
        lowStockAt: updated.lowStockAt,
        supplier: nextSupplier || null,
        notes: nextNotes || null,
        images: responseImages,
        status: updated.status,
      },
    });
  } catch (error) {
    console.error('Error updating inventory product:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update inventory product',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.delete('/products/:id', permissionGuard('inventory', 'canDelete'), async (req, res) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const item = await prisma.inventoryItem.findFirst({
      where: { id: String(req.params.id), tenantId },
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
      });
    }

    const usedInProject = await prisma.projectMaterial.count({
      where: {
        tenantId,
        OR: [
          { itemSku: item.sku },
          { productId: item.id },
        ],
      },
    });
    if (usedInProject > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete item referenced in projects',
      });
    }

    await prisma.inventoryItem.delete({ where: { id: item.id } });

    return res.json({
      success: true,
      message: 'Inventory product deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting inventory product:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete inventory product',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ── Inventory categories ───────────────────────────────────────────────────────

/**
 * @openapi
 * /api/v1/inventory/categories:
 *   get:
 *     summary: List all inventory categories with live stock counts
 *     tags: [Inventory — Categories]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of categories with stock statistics
 */
router.get('/categories', permissionGuard('inventory', 'canRead'), listCategories);

/**
 * @openapi
 * /api/v1/inventory/categories/{id}:
 *   get:
 *     summary: Get a single category with its serialised items
 *     tags: [Inventory — Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Category with items array
 *       404:
 *         description: Category not found
 */
router.get('/categories/:id', permissionGuard('inventory', 'canRead'), getCategoryById);

/**
 * @openapi
 * /api/v1/inventory/categories:
 *   post:
 *     summary: Create a new inventory category
 *     tags: [Inventory — Categories]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, abbreviation]
 *             properties:
 *               name:
 *                 type: string
 *               abbreviation:
 *                 type: string
 *                 maxLength: 5
 *               description:
 *                 type: string
 *               unitPrice:
 *                 type: number
 *               reorderThreshold:
 *                 type: integer
 *               identifierType:
 *                 type: string
 *                 enum: [SERIAL_NUMBER, IMEI, BARCODE, QR_CODE, ASSET_TAG, CUSTOM, NONE]
 *               identifierLabel:
 *                 type: string
 *     responses:
 *       201:
 *         description: Category created
 *       409:
 *         description: Duplicate name or abbreviation
 */
router.post('/categories', permissionGuard('inventory', 'canCreate'), createCategory);

/**
 * @openapi
 * /api/v1/inventory/categories/{id}:
 *   patch:
 *     summary: Update an inventory category
 *     tags: [Inventory — Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               abbreviation:
 *                 type: string
 *               description:
 *                 type: string
 *               unitPrice:
 *                 type: number
 *               reorderThreshold:
 *                 type: integer
 *               identifierType:
 *                 type: string
 *                 enum: [SERIAL_NUMBER, IMEI, BARCODE, QR_CODE, ASSET_TAG, CUSTOM, NONE]
 *               identifierLabel:
 *                 type: string
 *     responses:
 *       200:
 *         description: Category updated
 *       404:
 *         description: Category not found
 */
router.patch('/categories/:id', permissionGuard('inventory', 'canUpdate'), updateCategory);

/**
 * @openapi
 * /api/v1/inventory/categories/{id}:
 *   delete:
 *     summary: Delete an inventory category (only if it has no items)
 *     tags: [Inventory — Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Category deleted
 *       400:
 *         description: Category has items, cannot delete
 *       404:
 *         description: Category not found
 */
router.delete('/categories/:id', permissionGuard('inventory', 'canDelete'), deleteCategory);

/**
 * @openapi
 * /api/v1/inventory/categories/{id}/availability:
 *   get:
 *     summary: Check how many available items a category can provide
 *     tags: [Inventory — Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: quantity
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Availability result with list of available items up to requested quantity
 *       400:
 *         description: Invalid quantity param
 *       404:
 *         description: Category not found
 */
router.get('/categories/:id/availability', permissionGuard('inventory', 'canRead'), checkCategoryAvailability);
router.post('/categories/:id/restock-request', permissionGuard('inventory', 'canCreate'), restockRequest);

// ── Serialised items ───────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/v1/inventory/items:
 *   post:
 *     summary: Create one or more serialised product items in a category
 *     tags: [Inventory — Items]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [categoryId, quantity]
 *             properties:
 *               categoryId:
 *                 type: string
 *               quantity:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 100
 *               userIdentifiers:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Optional list matching quantity — serial numbers, IMEIs, etc.
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Items created with auto-generated system IDs
 *       404:
 *         description: Category not found
 */
router.post('/items', permissionGuard('inventory', 'canCreate'), createProductItem);

/**
 * @openapi
 * /api/v1/inventory/items:
 *   get:
 *     summary: List serialised items (requires categoryId query param)
 *     tags: [Inventory — Items]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: categoryId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [AVAILABLE, DEPLOYED, UNDER_MAINTENANCE, FAULTY, COMPLETELY_BAD]
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Paginated list of serialised items
 */
router.get('/items', permissionGuard('inventory', 'canRead'), listProductItems);

/**
 * @openapi
 * /api/v1/inventory/items/{id}:
 *   get:
 *     summary: Get a single serialised item with its maintenance history
 *     tags: [Inventory — Items]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Product item with category info and maintenance logs
 *       404:
 *         description: Item not found
 */
router.get('/items/:id', permissionGuard('inventory', 'canRead'), getProductItem);

/**
 * @openapi
 * /api/v1/inventory/items/{id}:
 *   patch:
 *     summary: Update a serialised item (userIdentifier or notes)
 *     tags: [Inventory — Items]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userIdentifier:
 *                 type: string
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Item updated
 *       404:
 *         description: Item not found
 */
router.patch('/items/:id', permissionGuard('inventory', 'canUpdate'), updateProductItem);

/**
 * @openapi
 * /api/v1/inventory/items/{id}:
 *   delete:
 *     summary: Delete a serialised item (not allowed if DEPLOYED or in maintenance)
 *     tags: [Inventory — Items]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Item deleted
 *       400:
 *         description: Cannot delete deployed or maintenance item
 *       404:
 *         description: Item not found
 */
router.delete('/items/:id', permissionGuard('inventory', 'canDelete'), deleteProductItem);

// ── Maintenance logs ───────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/v1/inventory/items/{id}/maintenance:
 *   post:
 *     summary: Log a maintenance event and update item status
 *     tags: [Inventory — Items]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, newStatus]
 *             properties:
 *               title:
 *                 type: string
 *               notes:
 *                 type: string
 *               newStatus:
 *                 type: string
 *                 enum: [AVAILABLE, DEPLOYED, UNDER_MAINTENANCE, FAULTY, COMPLETELY_BAD]
 *     responses:
 *       201:
 *         description: Maintenance event logged, item status updated
 *       404:
 *         description: Item not found
 */
router.post('/items/:id/maintenance', permissionGuard('inventory', 'canUpdate'), logMaintenance);

/**
 * @openapi
 * /api/v1/inventory/items/{id}/maintenance:
 *   get:
 *     summary: Get maintenance history for a serialised item
 *     tags: [Inventory — Items]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Array of maintenance log entries
 *       404:
 *         description: Item not found
 */
router.get('/items/:id/maintenance', permissionGuard('inventory', 'canRead'), getMaintenanceLogs);


/**
 * @openapi
 * /api/v1/inventory/movements:
 *   post:
 *     summary: Record a stock movement
 *     tags: [Inventory]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [itemId, quantity, direction]
 *             properties:
 *               itemId:
 *                 type: string
 *                 format: uuid
 *               quantity:
 *                 type: integer
 *               direction:
 *                 type: string
 *                 enum: [IN, OUT]
 *               note:
 *                 type: string
 *     responses:
 *       201:
 *         description: Movement recorded
 */
router.post('/movements', permissionGuard('inventory', 'canCreate'), createMovement);

export default router;
