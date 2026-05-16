import { PRICING_MODULES, PRICING_MODULE_KEYS, ORGANISATION_SIZE_SURCHARGES, BILLING_CYCLES, ANNUAL_DISCOUNT_RATE, TRIAL_DAYS, calculatePricing, } from "./pricing.config.js";
export { PRICING_MODULES, PRICING_MODULE_KEYS, ORGANISATION_SIZE_SURCHARGES, BILLING_CYCLES, ANNUAL_DISCOUNT_RATE, TRIAL_DAYS, calculatePricing, };
export function resolveOrganisationSizeKey(value) {
    if (typeof value === "string") {
        if (value in ORGANISATION_SIZE_SURCHARGES) {
            return value;
        }
    }
    const size = Number(value);
    if (Number.isNaN(size) || size <= 10)
        return "1-10";
    if (size <= 50)
        return "11-50";
    if (size <= 200)
        return "51-200";
    return "201+";
}
export function calculateAmounts(params) {
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
export function normalizeModuleKeys(modules) {
    return Array.from(new Set(modules.map((m) => String(m).toLowerCase())));
}
export function isValidPricingModule(key) {
    return PRICING_MODULE_KEYS.includes(key);
}
export function getModulePrice(key) {
    const module = PRICING_MODULES.find((m) => m.key === key);
    return module ? module.monthlyPrice : null;
}
