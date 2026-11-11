import { Response } from 'express';
import { z } from 'zod';
import { prismaUnscoped as db } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { ApiError } from '../lib/errors.js';
import { branchPayload } from '../lib/branchAccess.js';
import { assignableRole } from '../lib/branchAdmin.js';
import { logAudit, extractRequestContext, buildDiff, AuditActorType } from '../services/auditService.js';

/**
 * Branch management. Opening, editing and closing branches, and giving people
 * access to a branch other than their own, belong to the owner. Everyone can
 * list the branches they may switch to.
 */

const CodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(10)
  .regex(/^[A-Za-z0-9-]+$/, 'Use letters, digits or dashes only')
  .transform((c) => c.toUpperCase());

const CreateBranchSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: CodeSchema,
  address: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
});

const UpdateBranchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  code: CodeSchema.optional(),
  address: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  isActive: z.boolean().optional(),
});

const AccessSchema = z.object({
  employeeId: z.string().uuid(),
  roleId: z.string().uuid(),
});

const branchSelect = {
  id: true, name: true, code: true, address: true, phone: true, isMain: true, isActive: true, createdAt: true,
  _count: { select: { employees: true, branchAccess: true } },
} as const;

function fail(res: Response, error: unknown, what: string) {
  if (error instanceof ApiError) {
    return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
  }
  if (error instanceof z.ZodError) {
    return res.status(400).json({ success: false, message: error.issues[0]?.message ?? 'Invalid payload' });
  }
  if ((error as any)?.code === 'P2002') {
    return res.status(409).json({ success: false, code: 'BRANCH_DUPLICATE', message: 'Another branch already uses this name or code.' });
  }
  console.error(`Error ${what}:`, error);
  return res.status(500).json({ success: false, message: `Failed to ${what}` });
}

function audit(req: AuthRequest, action: string, entityId: string, entityLabel: string, details?: unknown) {
  void logAudit({
    tenantId: req.tenantId!,
    actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
    actorId: req.user?.id,
    action,
    module: 'administration',
    entityType: 'branch',
    entityId,
    entityLabel,
    details: details as any,
    ...extractRequestContext(req),
  });
}

async function findBranch(req: AuthRequest) {
  const branch = await db.branch.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
  if (!branch) throw new ApiError(404, 'Branch not found.', 'BRANCH_NOT_FOUND');
  return branch;
}

/** GET /branches — the branches this user can switch to, and the active one. */
export const listMyBranches = async (req: AuthRequest, res: Response) => {
  try {
    const isOwner = req.user?.accountType === 'owner';
    let homeBranchId: string | undefined;
    if (!isOwner) {
      const me = await db.employee.findUnique({ where: { id: req.user!.id }, select: { branchId: true } });
      homeBranchId = me?.branchId;
    }
    const data = await branchPayload(
      isOwner
        ? { accountType: 'owner', tenantId: req.tenantId! }
        : { accountType: 'employee', tenantId: req.tenantId!, employeeId: req.user!.id, homeBranchId },
      req.branchId ?? null,
    );
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, 'list branches');
  }
};

/** GET /branches/manage — every branch with its staff counts (owner). */
export const listBranches = async (req: AuthRequest, res: Response) => {
  try {
    const branches = await db.branch.findMany({
      where: { tenantId: req.tenantId! },
      select: branchSelect,
      orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
    });
    return res.json({ success: true, data: branches });
  } catch (error) {
    return fail(res, error, 'list branches');
  }
};

/** GET /branches/:id (owner) */
export const getBranch = async (req: AuthRequest, res: Response) => {
  try {
    await findBranch(req);
    const branch = await db.branch.findUnique({ where: { id: req.params.id }, select: branchSelect });
    return res.json({ success: true, data: branch });
  } catch (error) {
    return fail(res, error, 'load the branch');
  }
};

/** POST /branches (owner) */
export const createBranch = async (req: AuthRequest, res: Response) => {
  try {
    const payload = CreateBranchSchema.parse(req.body);
    const branch = await db.branch.create({
      data: {
        tenantId: req.tenantId!,
        name: payload.name,
        code: payload.code,
        address: payload.address || null,
        phone: payload.phone || null,
      },
      select: branchSelect,
    });
    audit(req, 'BRANCH_CREATED', branch.id, `${branch.name} (${branch.code})`);
    return res.status(201).json({ success: true, data: branch });
  } catch (error) {
    return fail(res, error, 'create the branch');
  }
};

/** PATCH /branches/:id (owner) */
export const updateBranch = async (req: AuthRequest, res: Response) => {
  try {
    const existing = await findBranch(req);
    const payload = UpdateBranchSchema.parse(req.body);
    if (payload.isActive === false && existing.isMain) {
      throw new ApiError(400, 'The main branch cannot be closed.', 'MAIN_BRANCH');
    }
    const branch = await db.branch.update({
      where: { id: existing.id },
      data: {
        ...(payload.name !== undefined && { name: payload.name }),
        ...(payload.code !== undefined && { code: payload.code }),
        ...(payload.address !== undefined && { address: payload.address || null }),
        ...(payload.phone !== undefined && { phone: payload.phone || null }),
        ...(payload.isActive !== undefined && { isActive: payload.isActive }),
      },
      select: branchSelect,
    });
    const action = payload.isActive === false && existing.isActive
      ? 'BRANCH_CLOSED'
      : payload.isActive === true && !existing.isActive ? 'BRANCH_REOPENED' : 'BRANCH_UPDATED';
    audit(req, action, branch.id, `${branch.name} (${branch.code})`, buildDiff(
      { name: existing.name, code: existing.code, address: existing.address, phone: existing.phone, isActive: existing.isActive },
      { name: branch.name, code: branch.code, address: branch.address, phone: branch.phone, isActive: branch.isActive },
    ));
    return res.json({ success: true, data: branch });
  } catch (error) {
    return fail(res, error, 'update the branch');
  }
};

/** GET /branches/:id/members — who works here and who has access from elsewhere (owner). */
export const listBranchMembers = async (req: AuthRequest, res: Response) => {
  try {
    const branch = await findBranch(req);
    const person = { id: true, firstName: true, lastName: true, email: true, isActive: true, jobTitle: true } as const;
    const [staff, access] = await Promise.all([
      db.employee.findMany({
        where: { tenantId: req.tenantId!, branchId: branch.id },
        select: { ...person, role: { select: { id: true, name: true } } },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      db.branchAccess.findMany({
        where: { branchId: branch.id },
        select: {
          employee: { select: { ...person, branch: { select: { id: true, name: true, code: true } } } },
          role: { select: { id: true, name: true } },
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return res.json({ success: true, data: { staff, access } });
  } catch (error) {
    return fail(res, error, 'list branch members');
  }
};

/** PUT /branches/:id/access — give (or change) someone's access to this branch (owner). */
export const grantBranchAccess = async (req: AuthRequest, res: Response) => {
  try {
    const branch = await findBranch(req);
    const payload = AccessSchema.parse(req.body);
    const employee = await db.employee.findFirst({
      where: { id: payload.employeeId, tenantId: req.tenantId! },
      select: { id: true, branchId: true, firstName: true, lastName: true },
    });
    if (!employee) throw new ApiError(404, 'Employee not found.', 'EMPLOYEE_NOT_FOUND');
    if (employee.branchId === branch.id) {
      throw new ApiError(400, 'This person already works in this branch.', 'ALREADY_HOME_BRANCH');
    }
    const role = await assignableRole(req, payload.roleId, branch.id);
    await db.branchAccess.upsert({
      where: { employeeId_branchId: { employeeId: employee.id, branchId: branch.id } },
      update: { roleId: role.id },
      create: { tenantId: req.tenantId!, employeeId: employee.id, branchId: branch.id, roleId: role.id },
    });
    audit(req, 'BRANCH_ACCESS_GRANTED', branch.id, `${employee.firstName} ${employee.lastName} → ${branch.name}`, { role: role.name });
    return res.json({ success: true });
  } catch (error) {
    return fail(res, error, 'give branch access');
  }
};

/** DELETE /branches/:id/access/:employeeId (owner) */
export const revokeBranchAccess = async (req: AuthRequest, res: Response) => {
  try {
    const branch = await findBranch(req);
    const { count } = await db.branchAccess.deleteMany({
      where: { branchId: branch.id, employeeId: req.params.employeeId, tenantId: req.tenantId! },
    });
    if (!count) throw new ApiError(404, 'No such access.', 'ACCESS_NOT_FOUND');
    audit(req, 'BRANCH_ACCESS_REVOKED', branch.id, branch.name, { employeeId: req.params.employeeId });
    return res.json({ success: true });
  } catch (error) {
    return fail(res, error, 'remove branch access');
  }
};
