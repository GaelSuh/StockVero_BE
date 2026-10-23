import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
import { prisma } from '../db.js';
import { getNextDeliveryNoteNumber } from '../services/saleService.js';
import { auditRequest } from '../services/auditService.js';

export async function createDeliveryNote(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const { saleId, items, driverName, vehicleInfo, notes } = req.body;

    if (!saleId || !items?.length) {
      return res.status(400).json({ success: false, message: 'saleId and items are required' });
    }

    const sale = await prisma.sale.findFirst({ where: { id: saleId, tenantId } });
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });

    const noteNumber = await getNextDeliveryNoteNumber(tenantId);

    const deliveryNote = await prisma.deliveryNote.create({
      data: {
        tenantId,
        saleId,
        noteNumber,
        status: 'PENDING',
        driverName: driverName || null,
        vehicleInfo: vehicleInfo || null,
        notes: notes || null,
        items: {
          create: items.map((item: any) => ({
            saleItemId: item.saleItemId,
            quantityShipped: item.quantityShipped,
          })),
        },
      },
      include: { items: true },
    });

    auditRequest(req, {
      action: 'DELIVERY_NOTE_CREATED',
      module: 'wholesale_sales',
      entityType: 'Sale',
      entityId: saleId,
      entityLabel: `#${sale.saleNumber} · ${noteNumber}`,
      details: { noteNumber, driverName: driverName || null, vehicleInfo: vehicleInfo || null, lines: items.length },
    });

    return res.status(201).json({ success: true, message: 'Delivery note created', data: deliveryNote });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to create delivery note' });
  }
}

export async function listDeliveryNotes(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as string | undefined;
    const saleId = req.query.saleId as string | undefined;

    const where: any = { tenantId };
    if (status) where.status = status;
    if (saleId) where.saleId = saleId;

    const [notes, total] = await Promise.all([
      prisma.deliveryNote.findMany({
        where,
        include: { sale: { select: { saleNumber: true, customer: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.deliveryNote.count({ where }),
    ]);

    return res.json({
      success: true,
      data: notes,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to list delivery notes' });
  }
}

export async function getDeliveryNote(req: AuthRequest, res: Response) {
  try {
    const note = await prisma.deliveryNote.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: {
        sale: { select: { saleNumber: true, customer: true } },
        items: true,
      },
    });
    if (!note) return res.status(404).json({ success: false, message: 'Delivery note not found' });
    return res.json({ success: true, data: note });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get delivery note' });
  }
}

export async function updateDeliveryNoteStatus(req: AuthRequest, res: Response) {
  try {
    const { status, items } = req.body;
    const validStatuses = ['PENDING', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'PARTIAL_DELIVERY'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const existing = await prisma.deliveryNote.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!existing) return res.status(404).json({ success: false, message: 'Delivery note not found' });

    const updateData: any = { status };
    if (status === 'DISPATCHED') updateData.dispatchedAt = new Date();
    if (status === 'DELIVERED') updateData.deliveredAt = new Date();

    const updated = await prisma.deliveryNote.update({
      where: { id: req.params.id },
      data: updateData,
    });

    if (items?.length && (status === 'DELIVERED' || status === 'PARTIAL_DELIVERY')) {
      for (const item of items) {
        // Scoped to this note, so an item id from another tenant's note cannot be written.
        await prisma.deliveryNoteItem.updateMany({
          where: { id: item.id, deliveryNoteId: existing.id },
          data: { quantityReceived: item.quantityReceived },
        });
      }
    }

    if (status === 'DELIVERED') {
      await prisma.sale.update({
        where: { id: existing.saleId },
        data: { deliveryStatus: 'DELIVERED' },
      });
    }

    auditRequest(req, {
      action: 'DELIVERY_STATUS_CHANGED',
      module: 'wholesale_sales',
      entityType: 'Sale',
      entityId: existing.saleId,
      entityLabel: existing.noteNumber,
      details: {
        before: { status: existing.status },
        after: { status },
        ...(items?.length ? { received: items.map((i: any) => ({ item: i.id, quantityReceived: i.quantityReceived })) } : {}),
      },
    });

    return res.json({ success: true, message: 'Delivery note updated', data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update delivery note' });
  }
}
