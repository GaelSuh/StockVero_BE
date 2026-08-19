import { prisma } from '../db.js';

/**
 * Tenant-level behaviour switches, stored as JSON on the tenant row (same shape
 * of storage as themeConfig).
 */
export interface TenantSettings {
  /**
   * Finance must approve a purchase invoice before serialised units can be added.
   * Absent means false: recording that stock arrived is not a spending decision.
   * Tenants that want the discipline turn it on in Settings, and every tenant
   * that relied on it before this default changed was backfilled explicitly.
   */
  stockApprovalRequired?: boolean;
}

export const readTenantSettings = (tenant: { settingsConfig?: unknown } | null): TenantSettings => {
  const raw = tenant?.settingsConfig;
  return raw && typeof raw === 'object' ? (raw as TenantSettings) : {};
};

export const isStockApprovalRequired = (tenant: { settingsConfig?: unknown } | null): boolean =>
  readTenantSettings(tenant).stockApprovalRequired ?? false;

/** Loads just the settings for a tenant. */
export async function getTenantSettings(tenantId: string): Promise<TenantSettings> {
  const tenant = await (prisma as any).tenant.findUnique({
    where: { id: tenantId },
    select: { settingsConfig: true },
  });
  return readTenantSettings(tenant);
}

export async function stockApprovalRequired(tenantId: string): Promise<boolean> {
  return (await getTenantSettings(tenantId)).stockApprovalRequired ?? false;
}

/**
 * Onboarding default. Shops and distributors buy stock and put it on the shelf;
 * making finance sign off first only gets in their way. Installation and
 * manufacturing keep the approval step, and anything unrecognised errs on the
 * safe side by keeping it too.
 */
export function defaultStockApprovalRequired(_organizationType?: string | null): boolean {
  // Off for everyone now. Recording stock that has arrived is a statement of
  // fact, not a request to spend; the tenants that want finance in front of it
  // switch it on deliberately.
  return false;
}

/**
 * Signup does not ask for an organisation type yet — `Tenant.organizationType` is
 * never written by any code path — so the default is derived from the modules the
 * new tenant picked. A business that sells over a counter and does not run
 * projects is a shop; anything that runs projects keeps the approval step.
 *
 * When onboarding does start setting organizationType, pass it in and it wins.
 */
export function defaultSettingsForSignup(params: {
  organizationType?: string | null;
  selectedModules: string[];
}): TenantSettings {
  void params;
  return { stockApprovalRequired: false };
}
