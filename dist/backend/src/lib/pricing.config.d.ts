export declare const PRICING_MODULES: readonly [{
    readonly key: "dashboard";
    readonly displayName: "Dashboard";
    readonly description: "Overview metrics and summaries";
    readonly monthlyPrice: 0;
}, {
    readonly key: "inventory";
    readonly displayName: "Inventory";
    readonly description: "Manage items, movements, and stock levels";
    readonly monthlyPrice: 5000;
}, {
    readonly key: "crm";
    readonly displayName: "CRM";
    readonly description: "CRM for customer relationships";
    readonly monthlyPrice: 4000;
}, {
    readonly key: "projects";
    readonly displayName: "Projects";
    readonly description: "Project tracking with milestones and materials";
    readonly monthlyPrice: 6000;
}, {
    readonly key: "finance";
    readonly displayName: "Finance";
    readonly description: "Financial ledger and reporting";
    readonly monthlyPrice: 5500;
}, {
    readonly key: "analytics";
    readonly displayName: "Analytics";
    readonly description: "Business insights and reporting";
    readonly monthlyPrice: 3500;
}];
export declare const PRICING_MODULE_KEYS: string[];
export declare const ORGANISATION_SIZE_SURCHARGES: {
    readonly "1-10": {
        readonly label: "1-10 employees";
        readonly monthlySurcharge: 0;
    };
    readonly "11-50": {
        readonly label: "11-50 employees";
        readonly monthlySurcharge: 3000;
    };
    readonly "51-200": {
        readonly label: "51-200 employees";
        readonly monthlySurcharge: 8000;
    };
    readonly "201+": {
        readonly label: "201+ employees";
        readonly monthlySurcharge: 15000;
    };
};
export declare const BILLING_CYCLES: {
    readonly MONTHLY: "MONTHLY";
    readonly ANNUAL: "ANNUAL";
};
export declare const ANNUAL_DISCOUNT_RATE = 0.15;
export declare const TRIAL_DAYS = 7;
export type BillingCycle = (typeof BILLING_CYCLES)[keyof typeof BILLING_CYCLES];
export type OrganisationSizeKey = keyof typeof ORGANISATION_SIZE_SURCHARGES;
export type PricingModule = (typeof PRICING_MODULES)[number];
/** Alias used throughout the frontend */
export type OrgSizeTier = OrganisationSizeKey;
/** Flat key→price lookup (key → monthly XAF price) */
export declare const MODULE_PRICES: Record<string, number>;
/** Array of org-size options for UI rendering */
export declare const ORG_SIZE_OPTIONS: Array<{
    value: OrgSizeTier;
    label: string;
    surcharge: number;
}>;
/** The billing module key — permanent, always active */
export declare const BILLING_MODULE_KEY = "billing";
/**
 * Calculate the monthly total for a set of module keys + org size.
 * Keys that are not in MODULE_PRICES (e.g. "billing", "settings", "dashboard") contribute 0.
 */
export declare function calcMonthlyTotal(moduleKeys: string[], orgSizeTier: OrgSizeTier): number;
/**
 * Calculate the annual amounts from a monthly total.
 * Returns { annual, monthly, saving } all in XAF.
 */
export declare function calcAnnualTotal(monthly: number): {
    annual: number;
    monthly: number;
    saving: number;
};
/**
 * Calculate a prorated amount for a mid-cycle module addition.
 */
export declare function calcProratedAmount(monthlyPrice: number, daysRemaining: number, daysInPeriod: number): number;
export declare function calculatePricing(params: {
    modules: string[];
    organisationSize: OrganisationSizeKey;
    billingCycle: BillingCycle;
}): {
    modules: {
        key: "dashboard" | "inventory" | "crm" | "projects" | "finance" | "analytics";
        displayName: "Dashboard" | "Inventory" | "CRM" | "Projects" | "Finance" | "Analytics";
        description: "Overview metrics and summaries" | "Manage items, movements, and stock levels" | "CRM for customer relationships" | "Project tracking with milestones and materials" | "Financial ledger and reporting" | "Business insights and reporting";
        monthlyPrice: 0 | 5000 | 4000 | 6000 | 5500 | 3500;
    }[];
    surcharge: {
        label: "1-10 employees" | "11-50 employees" | "51-200 employees" | "201+ employees";
        monthlySurcharge: 0 | 3000 | 8000 | 15000;
    };
    monthlyTotal: number;
    annualTotal: number;
    annualDiscount: number;
    annualRaw: number;
    billingCycle: BillingCycle;
};
