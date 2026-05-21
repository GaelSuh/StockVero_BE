import { Prisma, type BillingCycle as PrismaBillingCycle } from '@prisma/client';
import { prisma } from '../db.js';
export declare const MONTHLY_DAYS = 30;
export declare const ANNUAL_DAYS = 365;
export declare function toDecimal(value: number): Prisma.Decimal;
export declare function getCycleDays(cycle: PrismaBillingCycle): 30 | 365;
export declare function getPeriodEnd(start: Date, cycle: PrismaBillingCycle): Date;
export declare function calculateProrationAmount(params: {
    modulePrice: number;
    periodStart: Date;
    periodEnd: Date;
    chargedAt?: Date;
}): number;
export declare function recalcSubscriptionAmounts(tenantId: string, tx?: any): Promise<{
    monthlyTotal: number;
    annualTotal: number;
    organisationSizeKey: "1-10" | "11-50" | "51-200" | "201+";
    surcharge: {
        label: "1-10 employees" | "11-50 employees" | "51-200 employees" | "201+ employees";
        monthlySurcharge: 0 | 3000 | 8000 | 15000;
    };
}>;
export declare function buildSubscriptionModulePayload(moduleKey: string): {
    monthlyPrice: 0 | 5000 | 4000 | 6000 | 5500 | 3500;
};
export declare function ensureTenantModuleEnabled(tenantId: string, moduleKey: string, tx?: any): Promise<void>;
export declare function disableTenantModule(tenantId: string, moduleKey: string, tx?: typeof prisma): Promise<void>;
