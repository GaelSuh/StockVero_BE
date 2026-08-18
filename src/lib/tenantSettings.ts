import { prisma } from '../db.js';

/**
 * Tenant-level behaviour switches, stored as JSON on the tenant row (same shape
 * of storage as themeConfig).
 */
export interface TenantSettings {
  /**
   * Finance must approve a purchase invoice before serialised units can be added.
   * Absent means true — every tenant that existed before this setting keeps the
   * original Installation behaviour untouched.
   */
  stockApprovalRequired?: boolean;
}

export const readTenantSettings = (tenant: { settingsConfig?: unknown } | null): TenantSettings => {
  const raw = tenant?.settingsConfig;
  return raw && typeof raw === 'object' ? (raw as TenantSettings) : {};
};

export const isStockApprovalRequired = (tenant: { settingsConfig?: unknown } | null): boolean =>
  readTenantSettings(tenant).stockApprovalRequired ?? true;

/** Loads just the settings for a tenant. */
export async function getTenantSettings(tenantId: string): Promise<TenantSettings> {
  const tenant = await (prisma as any).tenant.findUnique({
    where: { id: tenantId },
    select: { settingsConfig: true },
  });
  return readTenantSettings(tenant);
}

export async function stockApprovalRequired(tenantId: string): Promise<boolean> {
  return (await getTenantSettings(tenantId)).stockApprovalRequired ?? true;
}

/**
 * Onboarding default. Shops and distributors buy stock and put it on the shelf;
 * making finance sign off first only gets in their way. Installation and
 * manufacturing keep the approval step, and anything unrecognised errs on the
 * safe side by keeping it too.
 */
export function defaultStockApprovalRequired(organizationType?: string | null): boolean {
  switch (organizationType) {
    case 'RETAIL_SHOP':
    case 'WHOLESALE_DISTRIBUTION':
      return false;
    // MANUFACTURING, SERVICE_INSTALLATION and anything unset keep the approval step.
    default:
      return true;
  }
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
  if (params.organizationType) {
    return { stockApprovalRequired: defaultStockApprovalRequired(params.organizationType) };
  }

  const modules = new Set(params.selectedModules.map((m) => m.toLowerCase()));
  const sellsOverCounter = modules.has('retail_sales') || modules.has('wholesale_sales');
  const runsProjects = modules.has('projects');

  return { stockApprovalRequired: !(sellsOverCounter && !runsProjects) };
}
