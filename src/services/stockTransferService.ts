import { prismaUnscoped as db } from '../db.js';
import { ApiError } from '../lib/errors.js';
import { runInBranchScope } from '../lib/branchScope.js';
import { findProductElsewhere } from './branchCopyService.js';
import { broadcastToModule } from './notificationService.js';

/**
 * Stock transfers between branches of one company (see StockTransfer in the
 * schema). The branch that is short asks; the branch that has the stock
 * approves (the stock leaves it then); the asking branch confirms it physically
 * arrived (the stock is added then). Only between branches that have the same
 * product. Not a sale and not a purchase: no finance entry anywhere.
 *
 * Cross-branch by nature, so it uses the unscoped client and names every
 * branch itself.
 */

export interface Actor {
  tenantId: string;
  /** The branch the person is working in; null = All branches. */
  branchId: string | null;
  userId: string;
  name: string;
}

type Tx = any;

const productSelect = {
  id: true, name: true, branchId: true, type: true, stockTrackingMode: true, quantityOnHand: true, imageUrl: true,
  abbreviation: true, barcode: true,
  variants: { where: { isActive: true }, select: { id: true, label: true, quantityOnHand: true }, orderBy: { sortOrder: 'asc' as const } },
} as const;

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function assertTransferable(p: { type: string; stockTrackingMode: string }) {
  if (p.type !== 'STOCK' || p.stockTrackingMode === 'SERVICE') {
    throw new ApiError(400, 'Only stock products can be transferred.', 'NOT_TRANSFERABLE');
  }
}

/** What a product (or one of its variants) has available to send. */
async function availableOf(tx: Tx, p: { id: string; stockTrackingMode: string; quantityOnHand: number; variants: any[] }, variantId: string | null) {
  if (p.stockTrackingMode === 'QUANTITY') {
    return variantId ? (p.variants.find((v) => v.id === variantId)?.quantityOnHand ?? 0) : p.quantityOnHand;
  }
  return tx.productItem.count({
    where: { categoryId: p.id, stockStatus: 'AVAILABLE', ...(variantId ? { variantId } : {}) },
  });
}

async function stockLog(tx: Tx, a: {
  tenantId: string; branchId: string; categoryId: string; variantId: string | null;
  eventType: 'TRANSFER_OUT' | 'TRANSFER_IN' | 'TRANSFER_CANCELLED'; delta: number; stockAfter: number;
  title: string; performedBy: string;
}) {
  const { stockAfter, ...rest } = a;
  await tx.categoryStockLog.create({ data: { ...rest, stockBefore: stockAfter - a.delta, stockAfter } });
}

function notify(tenantId: string, branchId: string, n: { type: string; title: string; message: string; link: string }) {
  // The people working in that branch, not the one doing this.
  return runInBranchScope({ tenantId, branchId }, () => broadcastToModule(tenantId, 'inventory', n));
}

const detailInclude = {
  fromBranch: { select: { id: true, name: true, code: true } },
  toBranch: { select: { id: true, name: true, code: true } },
  fromProduct: { select: { id: true, name: true, abbreviation: true, imageUrl: true, stockTrackingMode: true } },
  toProduct: { select: { id: true, name: true, abbreviation: true, imageUrl: true, stockTrackingMode: true } },
} as const;

async function load(tenantId: string, id: string) {
  const t = await db.stockTransfer.findFirst({ where: { id, tenantId }, include: detailInclude });
  if (!t) throw new ApiError(404, 'Transfer not found.', 'TRANSFER_NOT_FOUND');
  return t;
}

function mustWorkIn(actor: Actor, branch: { id: string; name: string }, what: string) {
  if (actor.branchId !== branch.id) {
    throw new ApiError(409, `Switch to ${branch.name} to ${what} this transfer.`, 'WRONG_BRANCH');
  }
}

/** The other branches, each with its matching product and how much it has (null = it does not have this product). */
export async function transferSources(tenantId: string, branchId: string, productId: string) {
  const product = await db.inventoryCategory.findFirst({ where: { id: productId, tenantId, branchId }, select: productSelect });
  if (!product) throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
  assertTransferable(product);
  const [branches, matches] = await Promise.all([
    db.branch.findMany({
      where: { tenantId, isActive: true, id: { not: branchId } },
      select: { id: true, name: true, code: true },
      orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
    }),
    findProductElsewhere(tenantId, branchId, { name: product.name, abbreviation: product.abbreviation, barcode: product.barcode ?? undefined }),
  ]);
  return Promise.all(
    branches.map(async (branch) => {
      const match = matches.elsewhere.find((m) => m.branch.id === branch.id);
      if (!match) return { branch, product: null };
      const theirs = await db.inventoryCategory.findUniqueOrThrow({ where: { id: match.id }, select: productSelect });
      return {
        branch,
        product: {
          id: theirs.id,
          name: theirs.name,
          sameTracking: theirs.stockTrackingMode === product.stockTrackingMode,
          available: await availableOf(db, theirs, null),
          variants: await Promise.all(
            theirs.variants.map(async (v) => ({ label: v.label, available: await availableOf(db, theirs, v.id) })),
          ),
        },
      };
    }),
  );
}

export async function requestTransfer(
  actor: Actor,
  input: { productId: string; fromBranchId: string; variantId?: string | null; quantity: number; note?: string | null },
) {
  const { tenantId } = actor;
  if (!actor.branchId) throw new ApiError(409, 'Choose a branch first.', 'BRANCH_REQUIRED');
  const toBranchId = actor.branchId;
  if (input.fromBranchId === toBranchId) throw new ApiError(400, 'Choose another branch.', 'SAME_BRANCH');

  const [mine, fromBranch] = await Promise.all([
    db.inventoryCategory.findFirst({ where: { id: input.productId, tenantId, branchId: toBranchId }, select: productSelect }),
    db.branch.findFirst({ where: { id: input.fromBranchId, tenantId, isActive: true }, select: { id: true, name: true } }),
  ]);
  if (!mine) throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
  if (!fromBranch) throw new ApiError(404, 'Branch not found.', 'BRANCH_NOT_FOUND');
  assertTransferable(mine);

  const match = (await findProductElsewhere(tenantId, toBranchId, { name: mine.name, abbreviation: mine.abbreviation, barcode: mine.barcode ?? undefined })).elsewhere.find((m) => m.branch.id === fromBranch.id);
  if (!match) {
    throw new ApiError(409, `${fromBranch.name} does not have this product. Choose a branch that has it.`, 'PRODUCT_NOT_IN_BRANCH');
  }
  const theirs = await db.inventoryCategory.findUniqueOrThrow({ where: { id: match.id }, select: productSelect });
  if (theirs.stockTrackingMode !== mine.stockTrackingMode) {
    throw new ApiError(409, `${fromBranch.name} tracks this product differently (by unit vs by quantity).`, 'TRACKING_MISMATCH');
  }

  // A product with options is asked for one option at a time, matched by its name.
  let toVariantId: string | null = null;
  let fromVariantId: string | null = null;
  if (mine.variants.length > 0) {
    const v = mine.variants.find((x) => x.id === input.variantId);
    if (!v) throw new ApiError(400, 'Choose which option you need.', 'VARIANT_REQUIRED');
    const twin = theirs.variants.find((x) => sameLabel(x.label, v.label));
    if (!twin) throw new ApiError(409, `${fromBranch.name} does not have the option "${v.label}".`, 'VARIANT_NOT_IN_BRANCH');
    toVariantId = v.id;
    fromVariantId = twin.id;
  }

  const transfer = await db.stockTransfer.create({
    data: {
      tenantId,
      fromBranchId: fromBranch.id,
      toBranchId,
      fromProductId: theirs.id,
      toProductId: mine.id,
      fromVariantId,
      toVariantId,
      quantityRequested: input.quantity,
      note: input.note?.trim() || null,
      requestedByName: actor.name,
    },
    include: detailInclude,
  });
  await notify(tenantId, fromBranch.id, {
    type: 'inventory.transfer_requested',
    title: 'Stock requested',
    message: `${transfer.toBranch.name} asks for ${input.quantity} × ${theirs.name}.`,
    link: `/inventory/transfers/${transfer.id}`,
  });
  return transfer;
}

export async function approveTransfer(actor: Actor, id: string, input: { quantity: number; unitIds?: string[] }) {
  const t = await load(actor.tenantId, id);
  if (t.status !== 'PENDING') throw new ApiError(409, 'This transfer is no longer waiting for approval.', 'TRANSFER_NOT_PENDING');
  mustWorkIn(actor, t.fromBranch, 'approve');
  const q = input.quantity;
  if (q < 1 || q > t.quantityRequested) {
    throw new ApiError(400, `Send between 1 and ${t.quantityRequested}.`, 'BAD_QUANTITY');
  }

  await db.$transaction(async (tx: Tx) => {
    const claimed = await tx.stockTransfer.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'APPROVED', quantityApproved: q, unitIds: input.unitIds ?? [], approvedByName: actor.name, approvedAt: new Date() },
    });
    if (claimed.count !== 1) throw new ApiError(409, 'This transfer was just answered by someone else.', 'TRANSFER_NOT_PENDING');

    const serialized = t.fromProduct.stockTrackingMode === 'SERIALIZED';
    if (serialized) {
      const unitIds = [...new Set(input.unitIds ?? [])];
      if (unitIds.length !== q) throw new ApiError(400, `Pick exactly ${q} unit(s) to send.`, 'PICK_UNITS');
      const moved = await tx.productItem.updateMany({
        where: {
          id: { in: unitIds }, tenantId: actor.tenantId, branchId: t.fromBranchId, categoryId: t.fromProductId,
          stockStatus: 'AVAILABLE', ...(t.fromVariantId ? { variantId: t.fromVariantId } : {}),
        },
        data: { stockStatus: 'IN_TRANSIT' },
      });
      if (moved.count !== q) throw new ApiError(409, 'Some of those units are no longer available. Pick again.', 'UNITS_UNAVAILABLE');
    } else {
      const where = { id: t.fromVariantId ?? t.fromProductId, quantityOnHand: { gte: q } };
      const data = { quantityOnHand: { decrement: q } };
      const taken = t.fromVariantId
        ? await tx.productVariant.updateMany({ where, data })
        : await tx.inventoryCategory.updateMany({ where, data });
      if (taken.count !== 1) throw new ApiError(409, `Not enough stock to send ${q}.`, 'NOT_ENOUGH_STOCK');
    }
    const p = await tx.inventoryCategory.findUniqueOrThrow({ where: { id: t.fromProductId }, select: productSelect });
    await stockLog(tx, {
      tenantId: actor.tenantId, branchId: t.fromBranchId, categoryId: t.fromProductId, variantId: t.fromVariantId,
      eventType: 'TRANSFER_OUT', delta: -q, stockAfter: await availableOf(tx, p, t.fromVariantId),
      title: `Transferred to ${t.toBranch.name} — ${q} unit(s)`, performedBy: actor.userId,
    });
  });

  await notify(actor.tenantId, t.toBranchId, {
    type: 'inventory.transfer_approved',
    title: 'Stock on the way',
    message: `${t.fromBranch.name} is sending ${q} × ${t.toProduct.name}. Confirm when it arrives.`,
    link: `/inventory/transfers/${id}`,
  });
  return load(actor.tenantId, id);
}

/**
 * The asking branch cancels a request still waiting; the sending branch rejects
 * one waiting or cancels one it approved (the stock comes back to it). Nothing
 * can be cancelled once received.
 */
export async function closeTransfer(actor: Actor, id: string, reason?: string | null) {
  const t = await load(actor.tenantId, id);
  const bySender = actor.branchId === t.fromBranchId;
  const byAsker = actor.branchId === t.toBranchId;
  if (t.status === 'PENDING' ? !bySender && !byAsker : !(t.status === 'APPROVED' && bySender)) {
    throw new ApiError(
      409,
      t.status === 'APPROVED' ? `Only ${t.fromBranch.name} can cancel a transfer it has approved.` : 'This transfer can no longer be cancelled.',
      'TRANSFER_NOT_CANCELLABLE',
    );
  }
  const status = t.status === 'PENDING' && bySender ? 'REJECTED' : 'CANCELLED';

  await db.$transaction(async (tx: Tx) => {
    const closed = await tx.stockTransfer.updateMany({
      where: { id, status: t.status },
      data: { status, closeReason: reason?.trim() || null, closedByName: actor.name, closedAt: new Date() },
    });
    if (closed.count !== 1) throw new ApiError(409, 'This transfer just changed. Refresh and try again.', 'TRANSFER_CHANGED');
    if (t.status !== 'APPROVED') return;

    // Approved stock had left the sender: put it back.
    const q = t.quantityApproved ?? 0;
    if (t.fromProduct.stockTrackingMode === 'SERIALIZED') {
      await tx.productItem.updateMany({ where: { id: { in: t.unitIds }, stockStatus: 'IN_TRANSIT' }, data: { stockStatus: 'AVAILABLE' } });
    } else if (t.fromVariantId) {
      await tx.productVariant.update({ where: { id: t.fromVariantId }, data: { quantityOnHand: { increment: q } } });
    } else {
      await tx.inventoryCategory.update({ where: { id: t.fromProductId }, data: { quantityOnHand: { increment: q } } });
    }
    const p = await tx.inventoryCategory.findUniqueOrThrow({ where: { id: t.fromProductId }, select: productSelect });
    await stockLog(tx, {
      tenantId: actor.tenantId, branchId: t.fromBranchId, categoryId: t.fromProductId, variantId: t.fromVariantId,
      eventType: 'TRANSFER_CANCELLED', delta: q, stockAfter: await availableOf(tx, p, t.fromVariantId),
      title: `Transfer to ${t.toBranch.name} cancelled — ${q} unit(s) back in stock`, performedBy: actor.userId,
    });
  });

  const other = bySender ? t.toBranchId : t.fromBranchId;
  await notify(actor.tenantId, other, {
    type: 'inventory.transfer_closed',
    title: status === 'REJECTED' ? 'Stock request declined' : 'Stock transfer cancelled',
    message: `${bySender ? t.fromBranch.name : t.toBranch.name} ${status === 'REJECTED' ? 'declined' : 'cancelled'} the transfer of ${t.toProduct.name}${reason?.trim() ? `: ${reason.trim()}` : '.'}`,
    link: `/inventory/transfers/${id}`,
  });
  return load(actor.tenantId, id);
}

/** The asking branch confirms the stock physically arrived; only now is it added there. */
export async function receiveTransfer(actor: Actor, id: string) {
  const t = await load(actor.tenantId, id);
  if (t.status !== 'APPROVED') throw new ApiError(409, 'This transfer is not on its way.', 'TRANSFER_NOT_APPROVED');
  mustWorkIn(actor, t.toBranch, 'receive');
  const q = t.quantityApproved ?? 0;

  await db.$transaction(async (tx: Tx) => {
    const claimed = await tx.stockTransfer.updateMany({
      where: { id, status: 'APPROVED' },
      data: { status: 'RECEIVED', receivedByName: actor.name, receivedAt: new Date() },
    });
    if (claimed.count !== 1) throw new ApiError(409, 'This transfer just changed. Refresh and try again.', 'TRANSFER_CHANGED');

    if (t.toProduct.stockTrackingMode === 'SERIALIZED') {
      // The units themselves move: same records, now this branch's.
      const units = await tx.productItem.findMany({
        where: { id: { in: t.unitIds }, stockStatus: 'IN_TRANSIT' },
        select: { id: true, systemId: true },
      });
      const taken = new Set(
        (await tx.productItem.findMany({
          where: { tenantId: actor.tenantId, branchId: t.toBranchId, systemId: { in: units.map((u: any) => u.systemId) } },
          select: { systemId: true },
        })).map((u: any) => u.systemId),
      );
      for (const u of units) {
        await tx.productItem.update({
          where: { id: u.id },
          data: {
            branchId: t.toBranchId,
            categoryId: t.toProductId,
            variantId: t.toVariantId,
            stockStatus: 'AVAILABLE',
            // System ids are unique per branch; keep it unless this branch already uses it.
            ...(taken.has(u.systemId) ? { systemId: `${u.systemId}-${t.fromBranch.code}` } : {}),
          },
        });
      }
    } else if (t.toVariantId) {
      await tx.productVariant.update({ where: { id: t.toVariantId }, data: { quantityOnHand: { increment: q } } });
    } else {
      await tx.inventoryCategory.update({ where: { id: t.toProductId }, data: { quantityOnHand: { increment: q } } });
    }
    const p = await tx.inventoryCategory.findUniqueOrThrow({ where: { id: t.toProductId }, select: productSelect });
    await stockLog(tx, {
      tenantId: actor.tenantId, branchId: t.toBranchId, categoryId: t.toProductId, variantId: t.toVariantId,
      eventType: 'TRANSFER_IN', delta: q, stockAfter: await availableOf(tx, p, t.toVariantId),
      title: `Received from ${t.fromBranch.name} — ${q} unit(s)`, performedBy: actor.userId,
    });
  });

  await notify(actor.tenantId, t.fromBranchId, {
    type: 'inventory.transfer_received',
    title: 'Transfer received',
    message: `${t.toBranch.name} received ${q} × ${t.fromProduct.name}.`,
    link: `/inventory/transfers/${id}`,
  });
  return load(actor.tenantId, id);
}

/** Transfers of the branches the person can see, optionally for one product. */
export function listTransfers(tenantId: string, branchIds: string[] | null, productId?: string) {
  return db.stockTransfer.findMany({
    where: {
      tenantId,
      ...(branchIds ? { OR: [{ fromBranchId: { in: branchIds } }, { toBranchId: { in: branchIds } }] } : {}),
      ...(productId ? { AND: [{ OR: [{ fromProductId: productId }, { toProductId: productId }] }] } : {}),
    },
    include: detailInclude,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

/** One transfer, with what the sender needs to answer it (its stock, and units to pick from). */
export async function getTransfer(actor: Actor, branchIds: string[] | null, id: string) {
  const t = await load(actor.tenantId, id);
  if (branchIds && !branchIds.includes(t.fromBranchId) && !branchIds.includes(t.toBranchId)) {
    throw new ApiError(404, 'Transfer not found.', 'TRANSFER_NOT_FOUND');
  }
  const [fromVariant, toVariant, units] = await Promise.all([
    t.fromVariantId ? db.productVariant.findUnique({ where: { id: t.fromVariantId }, select: { label: true } }) : null,
    t.toVariantId ? db.productVariant.findUnique({ where: { id: t.toVariantId }, select: { label: true } }) : null,
    t.unitIds.length ? db.productItem.findMany({ where: { id: { in: t.unitIds } }, select: { id: true, systemId: true, userIdentifier: true } }) : [],
  ]);
  let sender: { available: number; units: Array<{ id: string; systemId: string; userIdentifier: string | null }> } | null = null;
  if (t.status === 'PENDING' && actor.branchId === t.fromBranchId) {
    const p = await db.inventoryCategory.findUniqueOrThrow({ where: { id: t.fromProductId }, select: productSelect });
    sender = {
      available: await availableOf(db, p, t.fromVariantId),
      units: t.fromProduct.stockTrackingMode === 'SERIALIZED'
        ? await db.productItem.findMany({
            where: { categoryId: t.fromProductId, stockStatus: 'AVAILABLE', ...(t.fromVariantId ? { variantId: t.fromVariantId } : {}) },
            select: { id: true, systemId: true, userIdentifier: true },
            orderBy: { createdAt: 'asc' },
            take: 1000,
          })
        : [],
    };
  }
  return { ...t, variantLabel: toVariant?.label ?? fromVariant?.label ?? null, units, sender };
}
