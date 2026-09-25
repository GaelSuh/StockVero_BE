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
export declare const readTenantSettings: (tenant: {
    settingsConfig?: unknown;
} | null) => TenantSettings;
export declare const isStockApprovalRequired: (tenant: {
    settingsConfig?: unknown;
} | null) => boolean;
/** Loads just the settings for a tenant. */
export declare function getTenantSettings(tenantId: string): Promise<TenantSettings>;
export declare function stockApprovalRequired(tenantId: string): Promise<boolean>;
/**
 * Onboarding default. Shops and distributors buy stock and put it on the shelf;
 * making finance sign off first only gets in their way. Installation and
 * manufacturing keep the approval step, and anything unrecognised errs on the
 * safe side by keeping it too.
 */
export declare function defaultStockApprovalRequired(_organizationType?: string | null): boolean;
/**
 * Signup does not ask for an organisation type yet — `Tenant.organizationType` is
 * never written by any code path — so the default is derived from the modules the
 * new tenant picked. A business that sells over a counter and does not run
 * projects is a shop; anything that runs projects keeps the approval step.
 *
 * When onboarding does start setting organizationType, pass it in and it wins.
 */
export declare function defaultSettingsForSignup(params: {
    organizationType?: string | null;
    selectedModules: string[];
}): TenantSettings;
