import { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { broadcastToModule, sendNotification } from '../services/notificationService.js';
import { logAudit, extractRequestContext, AuditActorType } from '../services/auditService.js';

const ItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  quantity: z.number().int().nonnegative(),
  unitCost: z.number().positive(),
  unit: z.string().optional(),
  lowStockAt: z.number().int().nonnegative().optional(),
});

const MovementSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().int().positive(),
  direction: z.enum(['IN', 'OUT']),
  note: z.string().optional(),
});

function resolveStatus(quantity: number, lowStockAt: number) {
  if (quantity <= 0) return 'OUT_OF_STOCK';
  if (quantity <= lowStockAt) return 'LOW_STOCK';
  return 'IN_STOCK';
}

export const createItem = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = ItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const data = parsed.data;
    const existing = await prisma.inventoryItem.findUnique({
      where: { tenantId_sku: { tenantId: req.tenantId!, sku: data.sku.toUpperCase() } },
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Item SKU already exists',
      });
    }

    const lowStockAt = data.lowStockAt ?? 5;
    const status = resolveStatus(data.quantity, lowStockAt);

    const item = await prisma.inventoryItem.create({
      data: {
        tenantId: req.tenantId!,
        sku: data.sku.toUpperCase(),
        name: data.name,
        description: data.description,
        category: data.category,
        quantity: data.quantity,
        unitCost: data.unitCost as any,
        unit: data.unit || 'units',
        lowStockAt,
        status: status as any,
      },
    });

    // Notify authorized users
    await broadcastToModule(req.tenantId!, 'inventory', {
      type: 'inventory.created',
      title: 'New Inventory Item',
      message: `${item.name} (${item.sku}) has been added to stock.`,
      link: `/inventory/${item.id}`,
    });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'employee' ? AuditActorType.EMPLOYEE : AuditActorType.OWNER,
      actorId: req.user?.id,
      action: 'INVENTORY_ITEM_CREATED',
      module: 'inventory',
      entityType: 'InventoryItem',
      entityId: item.id,
      entityLabel: item.name,
      details: { sku: item.sku, quantity: item.quantity, unitCost: Number(item.unitCost) },
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: 'Inventory item created successfully',
      data: item,
    });
  } catch (error) {
    console.error('Error creating inventory item:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create inventory item',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const listItems = async (req: AuthRequest, res: Response) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const search = req.query.search ? String(req.query.search) : undefined;
    const skip = (page - 1) * limit;

    const where: any = { tenantId: req.tenantId! };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.inventoryItem.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.inventoryItem.count({ where }),
    ]);

    return res.json({
      success: true,
      message: 'Inventory items retrieved successfully',
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error listing inventory items:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve inventory items',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getItem = async (req: AuthRequest, res: Response) => {
  try {
    const item = await prisma.inventoryItem.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
      });
    }

    return res.json({
      success: true,
      message: 'Inventory item retrieved successfully',
      data: item,
    });
  } catch (error) {
    console.error('Error fetching inventory item:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve inventory item',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateItem = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = ItemSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const existingItem = await prisma.inventoryItem.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });

    if (!existingItem) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
      });
    }

    const data = parsed.data;
    if (data.sku) {
      const duplicate = await prisma.inventoryItem.findFirst({
        where: {
          tenantId: req.tenantId!,
          sku: data.sku.toUpperCase(),
          id: { not: req.params.id },
        },
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: 'Item SKU already exists',
        });
      }
    }

    const nextQuantity = data.quantity ?? existingItem.quantity;
    const nextLowStockAt = data.lowStockAt ?? existingItem.lowStockAt;
    const status = resolveStatus(nextQuantity, nextLowStockAt);

    const item = await prisma.inventoryItem.update({
      where: { id: req.params.id },
      data: {
        ...data,
        sku: data.sku ? data.sku.toUpperCase() : undefined,
        status: status as any,
      },
    });

    // Notify authorized users
    await broadcastToModule(req.tenantId!, 'inventory', {
      type: 'inventory.updated',
      title: 'Inventory Item Updated',
      message: `${item.name} details have been modified.`,
      link: `/inventory/${item.id}`,
    });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'employee' ? AuditActorType.EMPLOYEE : AuditActorType.OWNER,
      actorId: req.user?.id,
      action: 'INVENTORY_ITEM_UPDATED',
      module: 'inventory',
      entityType: 'InventoryItem',
      entityId: item.id,
      entityLabel: item.name,
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Inventory item updated successfully',
      data: item,
    });
  } catch (error) {
    console.error('Error updating inventory item:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update inventory item',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const deleteItem = async (req: AuthRequest, res: Response) => {
  try {
    const item = await prisma.inventoryItem.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
      });
    }

    const usedInProject = await prisma.projectMaterial.count({
      where: {
        tenantId: req.tenantId!,
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

    await prisma.inventoryItem.delete({ where: { id: req.params.id } });

    // Notify authorized users
    await broadcastToModule(req.tenantId!, 'inventory', {
      type: 'inventory.deleted',
      title: 'Inventory Item Removed',
      message: `${item.name} has been deleted from inventory.`,
    });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'employee' ? AuditActorType.EMPLOYEE : AuditActorType.OWNER,
      actorId: req.user?.id,
      action: 'INVENTORY_ITEM_DELETED',
      module: 'inventory',
      entityType: 'InventoryItem',
      entityId: req.params.id,
      entityLabel: item.name,
      details: { sku: item.sku },
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Inventory item deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting inventory item:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete inventory item',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const createMovement = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = MovementSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const data = parsed.data;
    const item = await prisma.inventoryItem.findFirst({
      where: { id: data.itemId, tenantId: req.tenantId! },
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
      });
    }

    const delta = data.direction === 'IN' ? data.quantity : -data.quantity;
    const newQuantity = item.quantity + delta;
    if (newQuantity < 0) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient stock for this movement',
      });
    }

    const status = resolveStatus(newQuantity, item.lowStockAt);

    const [movement, updatedItem] = await prisma.$transaction([
      prisma.inventoryMovement.create({
        data: {
          tenantId: req.tenantId!,
          itemId: item.id,
          direction: data.direction,
          quantity: data.quantity,
          note: data.note,
        },
      }),
      prisma.inventoryItem.update({
        where: { id: item.id },
        data: {
          quantity: newQuantity,
          status: status as any,
        },
      }),
    ]);

    if (data.direction === 'OUT') {
      checkAndNotifyLowStock(
        req.tenantId!,
        item.id,
        item.name,
        newQuantity,
        item.lowStockAt,
      ).catch(() => {});
    }

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'employee' ? AuditActorType.EMPLOYEE : AuditActorType.OWNER,
      actorId: req.user?.id,
      action: 'STOCK_MOVEMENT_CREATED',
      module: 'inventory',
      entityType: 'InventoryMovement',
      entityId: movement.id,
      entityLabel: item.name,
      details: { direction: data.direction, quantity: data.quantity, note: data.note },
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: 'Stock movement recorded successfully',
      data: { movement, item: updatedItem },
    });
  } catch (error) {
    console.error('Error creating stock movement:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to record stock movement',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export async function checkAndNotifyLowStock(
  tenantId: string,
  productId: string,
  productName: string,
  currentStock: number,
  lowStockAt: number,
) {
  try {
    if (currentStock > lowStockAt) return;

    const owners = await prisma.user.findMany({
      where: { tenantId, role: 'CLIENT_OWNER' },
      select: { id: true },
    });

    for (const owner of owners) {
      await sendNotification({
        tenantId,
        userId: owner.id,
        userType: 'OWNER',
        type: 'inventory.low_stock',
        title: 'Low Stock Alert',
        message: `${productName} is running low. Only ${currentStock} units remaining.`,
        link: `/inventory/details/${productId}`,
      });
    }
  } catch (error) {
    console.error('[inventory] Error sending low stock notification:', error);
  }
}
