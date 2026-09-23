import { MODULE_KEYS } from './modules.js';

/**
 * Business types offered at signup, and the modules each one starts with.
 *
 * The whole point of asking is to spare a new shop from picking modules out of a
 * list of names that mean nothing to them yet. So the answer *suggests* — it
 * never restricts. Every default here is a starting position the owner can change
 * on the same screen, and again later in Settings.
 *
 * Six deliberately broad types. A longer list would be more precise and would
 * mostly produce identical module sets, which is a worse trade: more scrolling,
 * more mappings to keep honest, no better outcome.
 *
 * The frontend mirrors this list in src/lib/industries.ts for labels and
 * pre-ticking. The two must be changed together — this file is the authority for
 * what actually gets stored.
 */
export interface IndustryDefinition {
  /** Stored on Tenant.organizationType. */
  organizationType:
    | 'RETAIL_SHOP'
    | 'WHOLESALE_DISTRIBUTION'
    | 'RETAIL_WHOLESALE'
    | 'MANUFACTURING'
    | 'SERVICE_INSTALLATION'
    | 'OTHER';
  /** Human label, also stored on Tenant.industry so existing screens keep working. */
  label: string;
  /** Modules ticked when this type is chosen. Not a restriction. */
  defaultModules: string[];
}

/**
 * Finance is in every default. A business that cannot see what it took today has
 * no reason to use any of this, and it is the module people most regret not
 * enabling. Inventory likewise: every type here holds stock of some kind.
 */
export const INDUSTRIES: IndustryDefinition[] = [
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

export function findIndustry(organizationType?: string | null): IndustryDefinition | undefined {
  return INDUSTRIES.find((i) => i.organizationType === organizationType);
}

/**
 * Modules a business type starts with. Unknown or absent type falls back to the
 * OTHER defaults rather than an empty account, which would be unusable.
 */
export function defaultModulesFor(organizationType?: string | null): string[] {
  return (
    findIndustry(organizationType)?.defaultModules ??
    findIndustry('OTHER')!.defaultModules
  );
}
