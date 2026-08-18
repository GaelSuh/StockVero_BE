import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
import { processReturn } from '../services/returnService.js';
import { prisma } from '../db.js';

export async function createReturn(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const user = req.user!;
    const { saleId, reason, returnType, items, refundMethod } = req.body;

    if (!saleId || !reason || !returnType || !items?.length) {
      return res.status(400).json({ success: false, message: 'saleId, reason, returnType, and items are required' });
    }

    const result = await processReturn(tenantId, saleId, {
      reason,
      returnType,
      items,
      refundMethod,
      processedById: user.id,
      processedByName: user.email,
    });

    return res.status(201).json({ success: true, message: 'Return processed', data: result });
  } catch (error) {
    console.error('Error processing return:', error);
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Failed to process return',
    });
  }
}

export async function listReturns(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const where: any = { tenantId };
    if (req.query.saleId) where.saleId = req.query.saleId;

    const [returns, total] = await Promise.all([
      prisma.saleReturn.findMany({
        where,
        include: {
          sale: { select: { saleNumber: true, mode: true } },
          items: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.saleReturn.count({ where }),
    ]);

    return res.json({
      success: true,
      data: returns,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to list returns' });
  }
}

export async function getReturn(req: AuthRequest, res: Response) {
  try {
    const saleReturn = await prisma.saleReturn.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: {
        sale: { select: { saleNumber: true, mode: true, customer: { select: { name: true } } } },
        items: true,
      },
    });
    if (!saleReturn) return res.status(404).json({ success: false, message: 'Return not found' });
    return res.json({ success: true, data: saleReturn });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get return' });
  }
}
