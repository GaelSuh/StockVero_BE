import { prisma } from '../db.js';
export const readTenantSettings = (tenant) => {
    const raw = tenant?.settingsConfig;
    return raw && typeof raw === 'object' ? raw : {};
};
export const isStockApprovalRequired = (tenant) => readTenantSettings(tenant).stockApprovalRequired ?? false;
/** Loads just the settings for a tenant. */
export async function getTenantSettings(tenantId) {
    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { settingsConfig: true },
    });
    return readTenantSettings(tenant);
}
export async function stockApprovalRequired(tenantId) {
    return (await getTenantSettings(tenantId)).stockApprovalRequired ?? false;
}
/**
 * Onboarding default. Shops and distributors buy stock and put it on the shelf;
 * making finance sign off first only gets in their way. Installation and
 * manufacturing keep the approval step, and anything unrecognised errs on the
 * safe side by keeping it too.
 */
export function defaultStockApprovalRequired(_organizationType) {
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
export function defaultSettingsForSignup(params) {
    void params;
    return { stockApprovalRequired: false };
}
