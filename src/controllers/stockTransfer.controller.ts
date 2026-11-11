import { Response } from 'express';
import { z } from 'zod';
import { prismaUnscoped as db } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { ApiError } from '../lib/errors.js';
import { branchesForEmployee } from '../lib/branchAccess.js';
import { resolvePersonName } from '../lib/personName.js';
import {
  approveTransfer, closeTransfer, getTransfer, listTransfers, receiveTransfer, requestTransfer, transferSources,
  type Actor,
} from '../services/stockTransferService.js';
import { auditRequest } from '../services/auditService.js';

/** Inventory → product → Transfer stock. See services/stockTransferService.ts. */

function fail(res: Response, error: unknown, what: string) {
  if (error instanceof ApiError) {
    return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
  }
  if (error instanceof z.ZodError) {
    return res.status(400).json({ success: false, message: error.issues[0]?.message ?? 'Invalid payload' });
  }
  console.error(`Error ${what}:`, error);
  return res.status(500).json({ success: false, message: `Failed to ${what}` });
}

async function actorOf(req: AuthRequest): Promise<Actor> {
  const user = req.user!;
  return {
    tenantId: req.tenantId!,
    branchId: req.branchId ?? null,
    userId: user.id,
    name: await resolvePersonName(user.id, user.accountType === 'owner' ? 'OWNER' : 'EMPLOYEE'),
  };
}

/** Branches whose transfers this person may see; null = every branch (the owner). */
async function visibleBranchIds(req: AuthRequest): Promise<string[] | null> {
  if (req.user!.accountType === 'owner') return null;
  const employee = await db.employee.findUnique({ where: { id: req.user!.id }, select: { id: true, branchId: true } });
  return employee ? (await branchesForEmployee(employee)).map((b) => b.id) : [];
}

function requireBranch(req: AuthRequest): string {
  if (!req.branchId) throw new ApiError(409, 'Choose a branch first.', 'BRANCH_REQUIRED');
  return req.branchId;
}

const RequestSchema = z.object({
  productId: z.string().uuid(),
  fromBranchId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().min(1).max(1_000_000),
  note: z.string().max(500).nullable().optional(),
});
const ApproveSchema = z.object({
  quantity: z.number().int().min(1).max(1_000_000),
  unitIds: z.array(z.string().uuid()).max(5000).optional(),
});
const CloseSchema = z.object({ reason: z.string().max(500).nullable().optional() });

/** GET /inventory/transfers?productId= */
export const list = async (req: AuthRequest, res: Response) => {
  try {
    const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;
    // In one branch: that branch's transfers. All branches: every one the person may see.
    const branchIds = req.branchId ? [req.branchId] : await visibleBranchIds(req);
    return res.json({ success: true, data: await listTransfers(req.tenantId!, branchIds, productId) });
  } catch (error) {
    return fail(res, error, 'list transfers');
  }
};

/** GET /inventory/transfers/sources/:productId */
export const sources = async (req: AuthRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await transferSources(req.tenantId!, requireBranch(req), req.params.productId) });
  } catch (error) {
    return fail(res, error, 'list branches');
  }
};

/** GET /inventory/transfers/:id */
export const detail = async (req: AuthRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await getTransfer(await actorOf(req), await visibleBranchIds(req), req.params.id) });
  } catch (error) {
    return fail(res, error, 'load the transfer');
  }
};

function audit(req: AuthRequest, action: string, t: { id: string; toProduct: { name: string }; fromBranch: { name: string }; toBranch: { name: string } }, details: Record<string, unknown>) {
  auditRequest(req, {
    action,
    module: 'inventory',
    entityType: 'stock_transfer',
    entityId: t.id,
    entityLabel: `${t.toProduct.name}: ${t.fromBranch.name} → ${t.toBranch.name}`,
    details,
  });
}

/** POST /inventory/transfers */
export const create = async (req: AuthRequest, res: Response) => {
  try {
    const t = await requestTransfer(await actorOf(req), RequestSchema.parse(req.body));
    audit(req, 'STOCK_TRANSFER_REQUESTED', t, { quantity: t.quantityRequested });
    return res.status(201).json({ success: true, data: t });
  } catch (error) {
    return fail(res, error, 'request the stock');
  }
};

/** POST /inventory/transfers/:id/approve */
export const approve = async (req: AuthRequest, res: Response) => {
  try {
    const t = await approveTransfer(await actorOf(req), req.params.id, ApproveSchema.parse(req.body));
    audit(req, 'STOCK_TRANSFER_APPROVED', t, { quantity: t.quantityApproved });
    return res.json({ success: true, data: t });
  } catch (error) {
    return fail(res, error, 'approve the transfer');
  }
};

/** POST /inventory/transfers/:id/cancel */
export const cancel = async (req: AuthRequest, res: Response) => {
  try {
    const t = await closeTransfer(await actorOf(req), req.params.id, CloseSchema.parse(req.body ?? {}).reason);
    audit(req, `STOCK_TRANSFER_${t.status}`, t, { reason: t.closeReason });
    return res.json({ success: true, data: t });
  } catch (error) {
    return fail(res, error, 'cancel the transfer');
  }
};

/** POST /inventory/transfers/:id/receive */
export const receive = async (req: AuthRequest, res: Response) => {
  try {
    const t = await receiveTransfer(await actorOf(req), req.params.id);
    audit(req, 'STOCK_TRANSFER_RECEIVED', t, { quantity: t.quantityApproved });
    return res.json({ success: true, data: t });
  } catch (error) {
    return fail(res, error, 'receive the transfer');
  }
};
