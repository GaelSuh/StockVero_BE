import { Response } from 'express';
import { z } from 'zod';
import { prismaUnscoped as db } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { ApiError } from '../lib/errors.js';
import { copyCatalog, findProductElsewhere, listSourceProducts } from '../services/branchCopyService.js';
import { auditRequest } from '../services/auditService.js';

/**
 * Inventory → Import → From another branch, and the "already exists in another
 * branch" check on the product form. Imports land in the branch being worked
 * in; any other branch of the company can be the source — a catalogue is not
 * branch-private the way sales and cash are.
 */

const ImportSchema = z.object({
  fromBranchId: z.string().uuid(),
  /** The products to import. */
  productIds: z.array(z.string().uuid()).min(1).max(2000).optional(),
  /** Or whole categories (null/absent with no productIds = everything). */
  productCategoryIds: z.array(z.string().uuid()).nullable().optional(),
});

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

function targetBranch(req: AuthRequest): string {
  if (!req.branchId) throw new ApiError(409, 'Choose a branch first.', 'BRANCH_REQUIRED');
  return req.branchId;
}

/** GET /inventory/copy/sources — the other branches, with how many products each has. */
export const listCopySources = async (req: AuthRequest, res: Response) => {
  try {
    const to = targetBranch(req);
    const branches = await db.branch.findMany({
      where: { tenantId: req.tenantId!, id: { not: to } },
      select: { id: true, name: true, code: true, isMain: true, _count: { select: { inventoryCategories: true } } },
      orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
    });
    return res.json({
      success: true,
      data: branches.map(({ _count, ...b }) => ({ ...b, productCount: _count.inventoryCategories })),
    });
  } catch (error) {
    return fail(res, error, 'list branches to import from');
  }
};

/** GET /inventory/copy/sources/:branchId/products — its products, marked when already here. */
export const listCopySourceProducts = async (req: AuthRequest, res: Response) => {
  try {
    const data = await listSourceProducts(req.tenantId!, req.params.branchId, targetBranch(req));
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, 'list products');
  }
};

/** POST /inventory/copy — import into the active branch. */
export const runCopy = async (req: AuthRequest, res: Response) => {
  try {
    const payload = ImportSchema.parse(req.body);
    const to = targetBranch(req);
    const result = await copyCatalog({
      tenantId: req.tenantId!,
      fromBranchId: payload.fromBranchId,
      toBranchId: to,
      productIds: payload.productIds ?? null,
      productCategoryIds: payload.productCategoryIds ?? null,
      dryRun: false,
    });
    const from = await db.branch.findUnique({ where: { id: payload.fromBranchId }, select: { name: true } });
    auditRequest(req, {
      action: 'PRODUCTS_IMPORTED_FROM_BRANCH',
      module: 'inventory',
      entityType: 'branch',
      entityId: to,
      entityLabel: `From ${from?.name ?? payload.fromBranchId}`,
      details: {
        fromBranchId: payload.fromBranchId,
        productsCreated: result.products.created.map((p) => p.name),
        productsSkipped: result.products.skipped.length,
        categoriesCreated: result.categories.created,
        variantsCreated: result.variants.created,
      },
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    return fail(res, error, 'import the products');
  }
};

/** GET /inventory/categories/elsewhere?name=&abbreviation=&barcode= — is this product already set up somewhere? */
export const productElsewhere = async (req: AuthRequest, res: Response) => {
  try {
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const data = await findProductElsewhere(req.tenantId!, targetBranch(req), {
      name: str(req.query.name),
      abbreviation: str(req.query.abbreviation),
      barcode: str(req.query.barcode),
    });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, 'check the product');
  }
};
