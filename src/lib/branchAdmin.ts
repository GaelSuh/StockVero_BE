import { prismaUnscoped as db } from '../db.js';
import { ApiError } from './errors.js';
import { AuthRequest, Permission } from '../types/index.js';

/**
 * Who may manage which people and roles across branches.
 *
 * Owners (User accounts) manage the whole company. An employee with
 * Administration rights manages only the branch they are working in, and can
 * never hand out more than they hold themselves (the role ceiling) — otherwise
 * a branch manager could create a stronger account and use it.
 *
 * Employees and roles are company tables, so the automatic branch filter does
 * not apply to them; these helpers are the filter.
 */

export const isOwner = (req: AuthRequest) => req.user?.accountType === 'owner';

/** Employees visible to this request: those whose branch is the active one (all of them in All branches). */
export function employeeScope(req: AuthRequest) {
  return req.branchId ? { tenantId: req.tenantId!, branchId: req.branchId } : { tenantId: req.tenantId! };
}

/** Roles usable in this request's branch: company roles plus that branch's own. */
export function roleScope(req: AuthRequest) {
  return req.branchId
    ? { tenantId: req.tenantId!, OR: [{ branchId: null }, { branchId: req.branchId }] }
    : { tenantId: req.tenantId! };
}

const ACTIONS = ['canRead', 'canCreate', 'canUpdate', 'canDelete'] as const;
type PermissionRow = { moduleKey: string } & Partial<Permission>;

/** Permissions in `wanted` that the acting employee does not hold. Owners hold everything. */
export function permissionsBeyond(req: AuthRequest, wanted: PermissionRow[]): string[] {
  if (isOwner(req)) return [];
  const held = req.permissions ?? {};
  const beyond: string[] = [];
  for (const row of wanted) {
    for (const action of ACTIONS) {
      if (row[action] && !held[row.moduleKey]?.[action]) beyond.push(`${row.moduleKey}.${action}`);
    }
  }
  return beyond;
}

export function assertWithinCeiling(req: AuthRequest, wanted: PermissionRow[]) {
  const beyond = permissionsBeyond(req, wanted);
  if (beyond.length) {
    throw new ApiError(403, 'You cannot give permissions you do not have yourself.', 'ROLE_CEILING');
  }
}

/**
 * A branch admin may only act on people whose role is within their own
 * rights: no deactivating, resetting or re-roling someone above them.
 */
export async function assertCanManageEmployee(req: AuthRequest, employee: { roleId: string }) {
  if (isOwner(req)) return;
  const perms = await db.rolePermission.findMany({ where: { roleId: employee.roleId } });
  if (permissionsBeyond(req, perms).length) {
    throw new ApiError(403, 'This person has more rights than you; ask the owner.', 'ROLE_CEILING');
  }
}

/**
 * The branch a new or moved employee belongs to. Owners choose any branch of
 * the company (default: the active one); branch admins only their own.
 */
export async function targetBranchFor(req: AuthRequest, requested?: string | null): Promise<string> {
  if (!isOwner(req)) {
    if (!req.branchId) throw new ApiError(409, 'Choose a branch first.', 'BRANCH_REQUIRED');
    if (requested && requested !== req.branchId) {
      throw new ApiError(403, 'You can only manage people in your own branch.', 'BRANCH_ACCESS_DENIED');
    }
    return req.branchId;
  }
  const id = requested ?? req.branchId;
  if (!id) throw new ApiError(400, 'Choose the branch this person works in.', 'BRANCH_REQUIRED');
  const branch = await db.branch.findFirst({ where: { id, tenantId: req.tenantId! }, select: { id: true } });
  if (!branch) throw new ApiError(404, 'Branch not found.', 'BRANCH_NOT_FOUND');
  return branch.id;
}

/**
 * A role that may be given to someone in `branchId`: it belongs to the
 * company, is a company role or that branch's own, and stays within the
 * actor's own permissions.
 */
export async function assignableRole(req: AuthRequest, roleId: string, branchId: string) {
  const role = await db.role.findFirst({
    where: { id: roleId, tenantId: req.tenantId!, OR: [{ branchId: null }, { branchId }] },
    include: { permissions: true },
  });
  if (!role) throw new ApiError(404, 'Role not found for this branch.', 'ROLE_NOT_FOUND');
  assertWithinCeiling(req, role.permissions);
  return role;
}
