export const PRICING_MODULES = [
  {
    key: "dashboard",
    displayName: "Dashboard",
    description: "Overview metrics and summaries",
    monthlyPrice: 0,
  },
  {
    key: "inventory",
    displayName: "Inventory",
    description: "Manage items, movements, and stock levels",
    monthlyPrice: 5000,
  },
  {
    key: "crm",
    displayName: "CRM",
    description: "CRM for customer relationships",
    monthlyPrice: 4000,
  },
  {
    key: "projects",
    displayName: "Projects",
    description: "Project tracking with milestones and materials",
    monthlyPrice: 6000,
  },
  {
    key: "finance",
    displayName: "Finance",
    description: "Financial ledger and reporting",
    monthlyPrice: 5500,
  },
  {
    key: "analytics",
    displayName: "Analytics",
    description: "Business insights and reporting",
    monthlyPrice: 3500,
  },
] as const;

export const PRICING_MODULE_KEYS: string[] = PRICING_MODULES.map((m) => m.key);

export const ORGANISATION_SIZE_SURCHARGES = {
  "1-10": { label: "1-10 employees", monthlySurcharge: 0 },
  "11-50": { label: "11-50 employees", monthlySurcharge: 3000 },
  "51-200": { label: "51-200 employees", monthlySurcharge: 8000 },
  "201+": { label: "201+ employees", monthlySurcharge: 15000 },
} as const;

export const BILLING_CYCLES = {
  MONTHLY: "MONTHLY",
  ANNUAL: "ANNUAL",
} as const;

export const ANNUAL_DISCOUNT_RATE = 0.15;
export const TRIAL_DAYS = 7;

export type BillingCycle = (typeof BILLING_CYCLES)[keyof typeof BILLING_CYCLES];
export type OrganisationSizeKey = keyof typeof ORGANISATION_SIZE_SURCHARGES;
export type PricingModule = (typeof PRICING_MODULES)[number];

// ── Convenience aliases & derived constants ───────────────────────────────────

/** Alias used throughout the frontend */
export type OrgSizeTier = OrganisationSizeKey;

/** Flat key→price lookup (key → monthly XAF price) */
export const MODULE_PRICES: Record<string, number> = Object.fromEntries(
  PRICING_MODULES.map((m) => [m.key, m.monthlyPrice]),
);

/** Array of org-size options for UI rendering */
export const ORG_SIZE_OPTIONS: Array<{
  value: OrgSizeTier;
  label: string;
  surcharge: number;
}> = [
  { value: "1-10", label: "1-10 employees", surcharge: 0 },
  { value: "11-50", label: "11-50 employees", surcharge: 3000 },
  { value: "51-200", label: "51-200 employees", surcharge: 8000 },
  { value: "201+", label: "201+ employees", surcharge: 15000 },
];

/** The billing module key — permanent, always active */
export const BILLING_MODULE_KEY = "billing";

/**
 * Calculate the monthly total for a set of module keys + org size.
 * Keys that are not in MODULE_PRICES (e.g. "billing", "settings", "dashboard") contribute 0.
 */
export function calcMonthlyTotal(
  moduleKeys: string[],
  orgSizeTier: OrgSizeTier,
): number {
  const moduleTotal = moduleKeys.reduce(
    (sum, key) => sum + (MODULE_PRICES[key] ?? 0),
    0,
  );
  const surcharge =
    ORGANISATION_SIZE_SURCHARGES[orgSizeTier]?.monthlySurcharge ?? 0;
  return moduleTotal + surcharge;
}

/**
 * Calculate the annual amounts from a monthly total.
 * Returns { annual, monthly, saving } all in XAF.
 */
export function calcAnnualTotal(monthly: number): {
  annual: number;
  monthly: number;
  saving: number;
} {
  const annualRaw = monthly * 12;
  const saving = Math.round(annualRaw * ANNUAL_DISCOUNT_RATE);
  const annual = annualRaw - saving;
  return { annual, monthly, saving };
}

/**
 * Calculate a prorated amount for a mid-cycle module addition.
 */
export function calcProratedAmount(
  monthlyPrice: number,
  daysRemaining: number,
  daysInPeriod: number,
): number {
  return Math.round((monthlyPrice * daysRemaining) / daysInPeriod);
}

export function calculatePricing(params: {
  modules: string[];
  organisationSize: OrganisationSizeKey;
  billingCycle: BillingCycle;
}) {
  const selectedKeys = new Set(params.modules.map((m) => m.toLowerCase()));
  const modules = PRICING_MODULES.filter((m) => selectedKeys.has(m.key));
  const moduleTotal = modules.reduce((sum, mod) => sum + mod.monthlyPrice, 0);
  const surcharge = ORGANISATION_SIZE_SURCHARGES[params.organisationSize];
  const monthlyTotal = moduleTotal + surcharge.monthlySurcharge;
  const annualRaw = monthlyTotal * 12;
  const annualDiscount = Math.round(annualRaw * ANNUAL_DISCOUNT_RATE);
  const annualTotal = annualRaw - annualDiscount;

  return {
    modules: modules.map((m) => ({
      key: m.key,
      displayName: m.displayName,
      description: m.description,
      monthlyPrice: m.monthlyPrice,
    })),
    surcharge: {
      label: surcharge.label,
      monthlySurcharge: surcharge.monthlySurcharge,
    },
    monthlyTotal,
    annualTotal,
    annualDiscount,
    annualRaw,
    billingCycle: params.billingCycle,
  };
}
