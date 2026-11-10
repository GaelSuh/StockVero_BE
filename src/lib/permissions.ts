import { Permission } from '../types/index.js';
import { OWNER_PERMANENT_MODULES } from '../config/modules.js';
import { prismaUnscoped as db } from '../db.js';

/** Modules a tenant can use: the always-on ones plus those it has enabled. */
export async function enabledModuleKeys(tenantId: string): Promise<string[]> {
  const rows = await db.tenantModule.findMany({ where: { tenantId, isEnabled: true }, select: { moduleKey: true } });
  return Array.from(new Set<string>([...OWNER_PERMANENT_MODULES, ...rows.map((m) => m.moduleKey)]));
}

type RolePermissionRow = {
  moduleKey: string;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
};

/**
 * Turns a role's permission rows into the per-module map carried in the token
 * and checked by permissionGuard, keeping only modules the tenant has enabled.
 * `activeModules` is the subset of modules the role can open at all.
 */
export function buildRolePermissions(
  rolePermissions: RolePermissionRow[],
  enabledModules: string[],
  isAdmin = false,
): { permissions: Record<string, Permission>; activeModules: string[] } {
  const permissions: Record<string, Permission> = {};
  const activeModules: string[] = [];

  for (const perm of rolePermissions) {
    if (!enabledModules.includes(perm.moduleKey)) continue;
    if (!perm.canRead) continue;
    permissions[perm.moduleKey] = {
      canRead: Boolean(perm.canRead),
      canCreate: Boolean(perm.canCreate),
      canUpdate: Boolean(perm.canUpdate),
      canDelete: Boolean(perm.canDelete),
    };
    activeModules.push(perm.moduleKey);
  }

  // Legacy fallback: roles with isAdmin=true that predate the module-based
  // permission system may have no RolePermission row for 'administration'.
  // Grant canRead+canCreate automatically so these employees can still access
  // the Administration pages without requiring a re-login or migration.
  if (isAdmin && !permissions['administration'] && enabledModules.includes('administration')) {
    permissions['administration'] = { canRead: true, canCreate: true, canUpdate: false, canDelete: false };
    activeModules.push('administration');
  }

  return { permissions, activeModules };
}
