import { Response } from 'express';
import { z } from 'zod';
import { prismaUnscoped as db } from '../db.js';
import { AdminRequest } from '../types/index.js';
import { parsePagination, buildPaginationMeta } from '../lib/pagination.js';
import { logAuditAction } from '../services/audit.service.js';
import { sendNotification } from '../services/notificationService.js';
import { emailBranchEvent } from '../services/branchEmails.js';

/**
 * StockVero admins: every company's branches, approving new ones, and what
 * happens in each — stock and activity only. Money (sales totals, cash,
 * finance) is deliberately left out.
 */

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
/** Activity from these modules is about money: not shown to admins. */
const MONEY_MODULES = ['finance', 'invoices', 'billing'];

function fail(res: Response, error: unknown, what: string) {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ success: false, message: error.issues[0]?.message ?? 'Invalid payload' });
  }
  console.error(`Error ${what}:`, error);
  return res.status(500).json({ success: false, message: `Failed to ${what}` });
}

const listSelect = {
  id: true, name: true, code: true, address: true, phone: true, isMain: true, isActive: true,
  approvalStatus: true, approvedAt: true, rejectionReason: true, createdAt: true,
  tenant: { select: { id: true, name: true, subdomain: true } },
  _count: { select: { employees: true, inventoryCategories: true } },
} as const;

/** GET /branches?status=&search=&tenantId=&page=&limit= */
export const listBranches = async (req: AdminRequest, res: Response) => {
  try {
    const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 20);
    const status = String(req.query.status ?? '').toUpperCase();
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    const where = {
      ...(STATUSES.includes(status as any) ? { approvalStatus: status as (typeof STATUSES)[number] } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { code: { contains: search, mode: 'insensitive' as const } },
              { tenant: { name: { contains: search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
    const [rows, total, pending] = await Promise.all([
      db.branch.findMany({
        where,
        select: listSelect,
        // Waiting ones first, then newest.
        orderBy: tenantId ? [{ isMain: 'desc' }, { name: 'asc' }] : [{ approvalStatus: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      db.branch.count({ where }),
      db.branch.count({ where: { approvalStatus: 'PENDING' } }),
    ]);
    return res.json({ success: true, data: rows, meta: { ...buildPaginationMeta(total, page, limit), pending } });
  } catch (error) {
    return fail(res, error, 'list branches');
  }
};

/** What a branch holds and does: counts only, no money. */
async function branchActivity(branchId: string) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [products, variants, units, employees, access, customers, sales30, lastSale, transfersIn, transfersOut, activity] =
    await Promise.all([
      db.inventoryCategory.findMany({
        where: { branchId, type: 'STOCK', stockTrackingMode: { not: 'SERVICE' } },
        select: { id: true, stockTrackingMode: true, quantityOnHand: true, quantityFaulty: true, quantityDamaged: true, reorderThreshold: true },
      }),
      db.productVariant.groupBy({ by: ['categoryId'], where: { branchId }, _sum: { quantityOnHand: true } }),
      db.productItem.groupBy({ by: ['categoryId'], where: { branchId, stockStatus: 'AVAILABLE' }, _count: { id: true } }),
      db.employee.count({ where: { branchId } }),
      db.branchAccess.count({ where: { branchId } }),
      db.customer.count({ where: { branchId } }),
      db.sale.count({ where: { branchId, createdAt: { gte: since } } }),
      db.sale.findFirst({ where: { branchId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      db.stockTransfer.count({ where: { toBranchId: branchId, status: { in: ['PENDING', 'APPROVED'] } } }),
      db.stockTransfer.count({ where: { fromBranchId: branchId, status: { in: ['PENDING', 'APPROVED'] } } }),
      db.auditLog.findMany({
        where: { branchId, module: { notIn: MONEY_MODULES } },
        select: { id: true, action: true, module: true, entityLabel: true, actorName: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
    ]);

  const variantQty = new Map(variants.map((v) => [v.categoryId, v._sum.quantityOnHand ?? 0]));
  const unitQty = new Map(units.map((u) => [u.categoryId, u._count.id]));
  let unitsInStock = 0;
  let faultyOrDamaged = 0;
  let lowStock = 0;
  let outOfStock = 0;
  for (const p of products) {
    // Same rule as lib/stock.ts: quantity products count their own and their variants' counters.
    const onHand = p.stockTrackingMode === 'QUANTITY' ? p.quantityOnHand + (variantQty.get(p.id) ?? 0) : unitQty.get(p.id) ?? 0;
    unitsInStock += onHand;
    faultyOrDamaged += p.quantityFaulty + p.quantityDamaged;
    if (onHand <= 0) outOfStock += 1;
    else if (onHand <= p.reorderThreshold) lowStock += 1;
  }

  return {
    stock: { products: products.length, unitsInStock, lowStock, outOfStock, faultyOrDamaged },
    people: { employees, withAccess: access, customers },
    activity: {
      salesLast30Days: sales30,
      lastSaleAt: lastSale?.createdAt ?? null,
      lastActivityAt: activity[0]?.createdAt ?? null,
      openTransfersIn: transfersIn,
      openTransfersOut: transfersOut,
      recent: activity,
    },
  };
}

/** GET /branches/:id */
export const getBranch = async (req: AdminRequest, res: Response) => {
  try {
    const branch = await db.branch.findUnique({ where: { id: req.params.id }, select: listSelect });
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });
    return res.json({ success: true, data: { ...branch, ...(await branchActivity(branch.id)) } });
  } catch (error) {
    return fail(res, error, 'load the branch');
  }
};

const ReviewSchema = z.object({ reason: z.string().trim().max(500).optional() });

/** Tells the company's owners, in the app, what was decided. */
async function tellOwners(tenantId: string, branchId: string, title: string, message: string) {
  const owners = await db.user.findMany({ where: { tenantId }, select: { id: true } });
  await Promise.all(
    owners.map((o) =>
      sendNotification({
        tenantId, userId: o.id, userType: 'OWNER', moduleKey: 'admin',
        type: 'administration.branch_reviewed', title, message, link: `/admin/branches/${branchId}`,
      }),
    ),
  );
}

async function review(req: AdminRequest, res: Response, decision: 'APPROVED' | 'REJECTED') {
  try {
    const { reason } = ReviewSchema.parse(req.body ?? {});
    if (decision === 'REJECTED' && !reason) {
      return res.status(400).json({ success: false, message: 'Give the owner a reason.' });
    }
    const existing = await db.branch.findUnique({ where: { id: req.params.id }, select: { id: true, tenantId: true, name: true, isMain: true } });
    if (!existing) return res.status(404).json({ success: false, message: 'Branch not found' });
    if (existing.isMain && decision === 'REJECTED') {
      return res.status(400).json({ success: false, message: 'A main branch cannot be rejected.' });
    }
    const branch = await db.branch.update({
      where: { id: existing.id },
      data: {
        approvalStatus: decision,
        approvedAt: decision === 'APPROVED' ? new Date() : null,
        reviewedBy: req.admin!.id,
        rejectionReason: decision === 'REJECTED' ? reason! : null,
      },
      select: listSelect,
    });
    await logAuditAction(req.admin!.id, existing.tenantId, decision === 'APPROVED' ? 'BRANCH_APPROVED' : 'BRANCH_REJECTED', {
      branchId: existing.id, branchName: existing.name, ...(reason ? { reason } : {}),
    });
    await tellOwners(
      existing.tenantId,
      existing.id,
      decision === 'APPROVED' ? 'Branch approved' : 'Branch not approved',
      decision === 'APPROVED'
        ? `${existing.name} is approved. You and its staff can now sign in to it.`
        : `${existing.name} was not approved: ${reason}`,
    );
    emailBranchEvent(existing.id, decision === 'APPROVED' ? { kind: 'approved' } : { kind: 'rejected', reason: reason! });
    return res.json({ success: true, data: branch });
  } catch (error) {
    return fail(res, error, 'review the branch');
  }
}

/** POST /branches/:id/approve */
export const approveBranch = (req: AdminRequest, res: Response) => review(req, res, 'APPROVED');
/** POST /branches/:id/reject  { reason } */
export const rejectBranch = (req: AdminRequest, res: Response) => review(req, res, 'REJECTED');
