import { prismaUnscoped as db } from '../db.js';
import { buildRolePermissions, enabledModuleKeys } from './permissions.js';

/** What a new tenant's first branch is called; the owner can rename it. */
export const MAIN_BRANCH_NAME = 'Main branch';
export const MAIN_BRANCH_CODE = 'MAIN';

/** Token / header value for the owner's read-only All branches view. */
export const ALL_BRANCHES = 'all';

/** Header the client sends to pin a request to a branch (offline replays use it). */
export const BRANCH_HEADER = 'x-branch-id';

// address and phone ride along so documents (receipts, invoices) can print
// the issuing branch's own details.
const summarySelect = { id: true, name: true, code: true, isMain: true, isActive: true, address: true, phone: true } as const;
export type BranchSummary = {
  id: string; name: string; code: string; isMain: boolean; isActive: boolean;
  address: string | null; phone: string | null;
};

/**
 * The branch to keep in a token re-issued during a session (profile update,
 * password change, /me), so refreshing the token never moves the user to
 * another branch.
 */
export function sessionBranch(req: { branchId?: string | null }): string | undefined {
  return req.branchId === null ? ALL_BRANCHES : req.branchId ?? undefined;
}

export function mainBranch(tenantId: string) {
  return db.branch.findFirst({ where: { tenantId, isMain: true }, select: summarySelect });
}

/** Every branch of the tenant, main first. Owners can open all of them. */
export function branchesForOwner(tenantId: string): Promise<BranchSummary[]> {
  return db.branch.findMany({
    where: { tenantId },
    select: summarySelect,
    orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
  });
}

/** The employee's own branch plus any active branch they were given access to. */
export async function branchesForEmployee(employee: { id: string; branchId: string }): Promise<BranchSummary[]> {
  const [home, extra] = await Promise.all([
    db.branch.findUnique({ where: { id: employee.branchId }, select: summarySelect }),
    db.branchAccess.findMany({
      where: { employeeId: employee.id, branch: { isActive: true } },
      select: { branch: { select: summarySelect } },
      orderBy: { branch: { name: 'asc' } },
    }),
  ]);
  return [...(home?.isActive ? [home] : []), ...extra.map((a) => a.branch)];
}

/**
 * The branch an owner works in: the one asked for (when it belongs to the
 * tenant), null for All branches, or the main branch when nothing was asked.
 * Undefined means the request named a branch the owner cannot open.
 */
export async function resolveOwnerBranch(
  tenantId: string,
  requested: string | null | undefined,
): Promise<string | null | undefined> {
  if (requested === ALL_BRANCHES) return null;
  const branch = requested
    ? await db.branch.findFirst({ where: { id: requested, tenantId }, select: { id: true } })
    : await mainBranch(tenantId);
  return branch?.id;
}

export type EmployeeBranch = {
  branchId: string;
  /** Set only for a branch other than the employee's own: the role they have there. */
  accessRole?: { id: string; isAdmin: boolean; permissions: { moduleKey: string; canRead: boolean; canCreate: boolean; canUpdate: boolean; canDelete: boolean }[] };
};

/**
 * The branch an employee works in for this request, or null when they may not
 * open the requested one. Their own branch uses their own role; any other
 * branch needs a BranchAccess row and uses the role on it. Inactive branches
 * are closed to employees.
 */
export async function resolveEmployeeBranch(
  employee: { id: string; branchId: string },
  requested: string | null | undefined,
): Promise<EmployeeBranch | null> {
  if (requested === ALL_BRANCHES) return null;

  if (!requested || requested === employee.branchId) {
    const home = await db.branch.findUnique({ where: { id: employee.branchId }, select: { isActive: true } });
    return home?.isActive ? { branchId: employee.branchId } : null;
  }

  const access = await db.branchAccess.findUnique({
    where: { employeeId_branchId: { employeeId: employee.id, branchId: requested } },
    select: {
      branch: { select: { isActive: true } },
      role: { select: { id: true, isAdmin: true, permissions: true } },
    },
  });
  if (!access || !access.branch.isActive) return null;
  return { branchId: requested, accessRole: access.role };
}

type RoleWithPermissions = {
  isAdmin: boolean;
  permissions: { moduleKey: string; canRead: boolean; canCreate: boolean; canUpdate: boolean; canDelete: boolean }[];
};

/**
 * What an employee may do in a branch, for a token: the branch, the role that
 * applies there (their own at home, the BranchAccess role elsewhere) and the
 * permissions it gives. Null when they may not open that branch.
 */
export async function employeeBranchSession(
  employee: { id: string; tenantId: string; branchId: string; roleId: string; role: RoleWithPermissions },
  requested: string | null | undefined,
) {
  const resolved = await resolveEmployeeBranch(employee, requested);
  if (!resolved) return null;
  const role = resolved.accessRole ?? { id: employee.roleId, ...employee.role };
  const built = buildRolePermissions(role.permissions, await enabledModuleKeys(employee.tenantId), role.isAdmin);
  return { branchId: resolved.branchId, roleId: role.id, isAdmin: role.isAdmin, ...built };
}

/** The branch list and the active branch, as the client shows them. */
export async function branchPayload(
  account: { accountType: 'owner' | 'employee'; tenantId: string; employeeId?: string; homeBranchId?: string },
  activeBranchId: string | null,
) {
  const branches = account.accountType === 'owner'
    ? await branchesForOwner(account.tenantId)
    : await branchesForEmployee({ id: account.employeeId!, branchId: account.homeBranchId! });
  return {
    branches,
    activeBranch: activeBranchId ? branches.find((b) => b.id === activeBranchId) ?? null : null,
    homeBranchId: account.homeBranchId ?? null,
  };
}
