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
 * Matches the onboarding table in StockVero_Retail_Wholesale_POS_Feature_Spec.md §10:
 * Inventory, Finance and Analytics are in every type (every business tracks stock,
 * money and performance); what changes is the selling model.
 *
 * One deliberate addition to the spec: CRM rides along with Wholesale Sales. The
 * wholesale till picks a known customer to apply their price list and credit,
 * and those customer records are served by the CRM module.
 */
const BASE = [MODULE_KEYS.INVENTORY, MODULE_KEYS.FINANCE, MODULE_KEYS.ANALYTICS];
const WHOLESALE = [MODULE_KEYS.WHOLESALE_SALES, MODULE_KEYS.CRM];

export const INDUSTRIES: IndustryDefinition[] = [
  { organizationType: 'RETAIL_SHOP', label: 'Retail shop', defaultModules: [...BASE, MODULE_KEYS.RETAIL_SALES] },
  { organizationType: 'WHOLESALE_DISTRIBUTION', label: 'Wholesale / distribution', defaultModules: [...BASE, ...WHOLESALE] },
  {
    organizationType: 'RETAIL_WHOLESALE',
    label: 'Retail and wholesale',
    defaultModules: [...BASE, MODULE_KEYS.RETAIL_SALES, ...WHOLESALE],
  },
  { organizationType: 'SERVICE_INSTALLATION', label: 'Installation / contracting', defaultModules: [...BASE, MODULE_KEYS.PROJECTS] },
  // Spec: a manufacturer sells what it makes in bulk, so Wholesale, not Projects.
  { organizationType: 'MANUFACTURING', label: 'Manufacturing / production', defaultModules: [...BASE, ...WHOLESALE] },
  // The narrowest honest default, chosen precisely when we cannot guess.
  { organizationType: 'OTHER', label: 'Something else', defaultModules: [...BASE] },
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
