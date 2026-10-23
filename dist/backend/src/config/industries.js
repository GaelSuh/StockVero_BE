import { MODULE_KEYS } from './modules.js';
/**
 * Finance is in every default. A business that cannot see what it took today has
 * no reason to use any of this, and it is the module people most regret not
 * enabling. Inventory likewise: every type here holds stock of some kind.
 */
export const INDUSTRIES = [
    {
        organizationType: 'RETAIL_SHOP',
        label: 'Retail shop',
        defaultModules: [MODULE_KEYS.INVENTORY, MODULE_KEYS.RETAIL_SALES, MODULE_KEYS.FINANCE],
    },
    {
        organizationType: 'WHOLESALE_DISTRIBUTION',
        label: 'Wholesale / distribution',
        // CRM is a default here and not for a retail shop: wholesale sells to known
        // customers on agreed rates, so customer records are load-bearing rather
        // than optional.
        defaultModules: [
            MODULE_KEYS.INVENTORY,
            MODULE_KEYS.WHOLESALE_SALES,
            MODULE_KEYS.CRM,
            MODULE_KEYS.FINANCE,
        ],
    },
    {
        organizationType: 'RETAIL_WHOLESALE',
        label: 'Retail and wholesale',
        defaultModules: [
            MODULE_KEYS.INVENTORY,
            MODULE_KEYS.RETAIL_SALES,
            MODULE_KEYS.WHOLESALE_SALES,
            MODULE_KEYS.CRM,
            MODULE_KEYS.FINANCE,
        ],
    },
    {
        organizationType: 'SERVICE_INSTALLATION',
        label: 'Installation / contracting',
        defaultModules: [
            MODULE_KEYS.INVENTORY,
            MODULE_KEYS.PROJECTS,
            MODULE_KEYS.CRM,
            MODULE_KEYS.FINANCE,
        ],
    },
    {
        organizationType: 'MANUFACTURING',
        label: 'Manufacturing / production',
        defaultModules: [MODULE_KEYS.INVENTORY, MODULE_KEYS.PROJECTS, MODULE_KEYS.FINANCE],
    },
    {
        organizationType: 'OTHER',
        label: 'Something else',
        // The narrowest honest default: stock and money. Anything more would be a
        // guess, and this is the type chosen precisely when we cannot guess.
        defaultModules: [MODULE_KEYS.INVENTORY, MODULE_KEYS.FINANCE],
    },
];
export const ORGANIZATION_TYPES = INDUSTRIES.map((i) => i.organizationType);
export function findIndustry(organizationType) {
    return INDUSTRIES.find((i) => i.organizationType === organizationType);
}
/**
 * Modules a business type starts with. Unknown or absent type falls back to the
 * OTHER defaults rather than an empty account, which would be unusable.
 */
export function defaultModulesFor(organizationType) {
    return (findIndustry(organizationType)?.defaultModules ??
        findIndustry('OTHER').defaultModules);
}
