import {
  PRICING_MODULES,
  PRICING_MODULE_KEYS,
  ORGANISATION_SIZE_SURCHARGES,
  BILLING_CYCLES,
  ANNUAL_DISCOUNT_RATE,
  TRIAL_DAYS,
  calculatePricing,
  type BillingCycle,
  type OrganisationSizeKey,
} from "./pricing.config.js";

export {
  PRICING_MODULES,
  PRICING_MODULE_KEYS,
  ORGANISATION_SIZE_SURCHARGES,
  BILLING_CYCLES,
  ANNUAL_DISCOUNT_RATE,
  TRIAL_DAYS,
  calculatePricing,
};

export type { BillingCycle, OrganisationSizeKey };

export function resolveOrganisationSizeKey(value: number | string): OrganisationSizeKey {
  if (typeof value === "string") {
    if (value in ORGANISATION_SIZE_SURCHARGES) {
      return value as OrganisationSizeKey;
    }
  }

  const size = Number(value);
  if (Number.isNaN(size) || size <= 10) return "1-10";
  if (size <= 50) return "11-50";
  if (size <= 200) return "51-200";
  return "201+";
}

export function calculateAmounts(params: {
  modules: string[];
  organisationSize: number | string;
}) {
  const organisationSizeKey = resolveOrganisationSizeKey(params.organisationSize);
  const breakdown = calculatePricing({
    modules: params.modules,
    organisationSize: organisationSizeKey,
    billingCycle: BILLING_CYCLES.MONTHLY,
  });

  return {
    monthlyTotal: breakdown.monthlyTotal,
    annualTotal: breakdown.annualTotal,
    organisationSizeKey,
    surcharge: breakdown.surcharge,
  };
}

export function normalizeModuleKeys(modules: string[]) {
  return Array.from(new Set(modules.map((m) => String(m).toLowerCase())));
}

export function isValidPricingModule(key: string) {
  return PRICING_MODULE_KEYS.includes(key as (typeof PRICING_MODULE_KEYS)[number]);
}

export function getModulePrice(key: string) {
  const module = PRICING_MODULES.find((m) => m.key === key);
  return module ? module.monthlyPrice : null;
}
