import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
import { prisma } from '../db.js';

export async function createPriceList(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const { name, description, isDefault, rules } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

    if (isDefault) {
      await prisma.priceList.updateMany({
        where: { tenantId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const priceList = await prisma.priceList.create({
      data: {
        tenantId,
        name,
        description: description || null,
        isDefault: isDefault || false,
        rules: rules?.length ? {
          create: rules.map((r: any) => ({
            categoryId: r.categoryId,
            minQuantity: r.minQuantity || 1,
            unitPrice: r.unitPrice,
          })),
        } : undefined,
      },
      include: { rules: true },
    });

    return res.status(201).json({ success: true, message: 'Price list created', data: priceList });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to create price list' });
  }
}

export async function listPriceLists(req: AuthRequest, res: Response) {
  try {
    const priceLists = await prisma.priceList.findMany({
      where: { tenantId: req.tenantId! },
      include: { _count: { select: { rules: true, customers: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, data: priceLists });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to list price lists' });
  }
}

export async function getPriceList(req: AuthRequest, res: Response) {
  try {
    const priceList = await prisma.priceList.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: {
        rules: { include: { category: { select: { id: true, name: true, sku: true, sellingPrice: true } } } },
        customers: { include: { customer: { select: { id: true, name: true } } } },
      },
    });
    if (!priceList) return res.status(404).json({ success: false, message: 'Price list not found' });
    return res.json({ success: true, data: priceList });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get price list' });
  }
}

export async function updatePriceList(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const { name, description, isDefault, rules } = req.body;

    const existing = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) return res.status(404).json({ success: false, message: 'Price list not found' });

    if (isDefault) {
      await prisma.priceList.updateMany({
        where: { tenantId, isDefault: true, id: { not: req.params.id } },
        data: { isDefault: false },
      });
    }

    if (rules) {
      await prisma.priceRule.deleteMany({ where: { priceListId: req.params.id } });
    }

    const updated = await prisma.priceList.update({
      where: { id: req.params.id },
      data: {
        name: name ?? undefined,
        description: description ?? undefined,
        isDefault: isDefault ?? undefined,
        rules: rules?.length ? {
          create: rules.map((r: any) => ({
            categoryId: r.categoryId,
            minQuantity: r.minQuantity || 1,
            unitPrice: r.unitPrice,
          })),
        } : undefined,
      },
      include: { rules: true },
    });

    return res.json({ success: true, message: 'Price list updated', data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update price list' });
  }
}

export async function deletePriceList(req: AuthRequest, res: Response) {
  try {
    const existing = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!existing) return res.status(404).json({ success: false, message: 'Price list not found' });

    await prisma.priceList.delete({ where: { id: req.params.id } });
    return res.json({ success: true, message: 'Price list deleted' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to delete price list' });
  }
}

export async function assignCustomerToPriceList(req: AuthRequest, res: Response) {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ success: false, message: 'customerId is required' });

    const existing = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!existing) return res.status(404).json({ success: false, message: 'Price list not found' });

    const assignment = await prisma.customerPriceList.upsert({
      where: { customerId_priceListId: { customerId, priceListId: req.params.id } },
      update: {},
      create: { customerId, priceListId: req.params.id },
    });

    return res.status(201).json({ success: true, message: 'Customer assigned', data: assignment });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to assign customer' });
  }
}

export async function removeCustomerFromPriceList(req: AuthRequest, res: Response) {
  try {
    await prisma.customerPriceList.deleteMany({
      where: { customerId: req.params.customerId, priceListId: req.params.id },
    });
    return res.json({ success: true, message: 'Customer removed from price list' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to remove customer' });
  }
}
