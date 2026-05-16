import { PRICING_MODULES, PRICING_MODULE_KEYS, ORGANISATION_SIZE_SURCHARGES, BILLING_CYCLES, ANNUAL_DISCOUNT_RATE, TRIAL_DAYS, calculatePricing, type BillingCycle, type OrganisationSizeKey } from "./pricing.config.js";
export { PRICING_MODULES, PRICING_MODULE_KEYS, ORGANISATION_SIZE_SURCHARGES, BILLING_CYCLES, ANNUAL_DISCOUNT_RATE, TRIAL_DAYS, calculatePricing, };
export type { BillingCycle, OrganisationSizeKey };
export declare function resolveOrganisationSizeKey(value: number | string): OrganisationSizeKey;
export declare function calculateAmounts(params: {
    modules: string[];
    organisationSize: number | string;
}): {
    monthlyTotal: number;
    annualTotal: number;
    organisationSizeKey: "1-10" | "11-50" | "51-200" | "201+";
    surcharge: {
        label: "1-10 employees" | "11-50 employees" | "51-200 employees" | "201+ employees";
        monthlySurcharge: 0 | 3000 | 8000 | 15000;
    };
};
export declare function normalizeModuleKeys(modules: string[]): string[];
export declare function isValidPricingModule(key: string): boolean;
export declare function getModulePrice(key: string): 0 | 5000 | 4000 | 6000 | 5500 | 3500 | null;
