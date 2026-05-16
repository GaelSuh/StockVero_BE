import { Prisma, type BillingCycle as PrismaBillingCycle } from '@prisma/client';
import { prisma } from '../db.js';
import {
  calculateAmounts,
  getModulePrice,
  resolveOrganisationSizeKey,
} from '../lib/pricing.js';
import { addDays, diffInDays } from '../lib/dates.js';

export const MONTHLY_DAYS = 30;
export const ANNUAL_DAYS = 365;

export function toDecimal(value: number) {
  return new Prisma.Decimal(value);
}

export function getCycleDays(cycle: PrismaBillingCycle) {
  return cycle === 'ANNUAL' ? ANNUAL_DAYS : MONTHLY_DAYS;
}

export function getPeriodEnd(start: Date, cycle: PrismaBillingCycle) {
  return addDays(start, getCycleDays(cycle));
}

export function calculateProrationAmount(params: {
  modulePrice: number;
  periodStart: Date;
  periodEnd: Date;
  chargedAt?: Date;
}) {
  const now = params.chargedAt ?? new Date();
  const totalDays = Math.max(1, diffInDays(params.periodStart, params.periodEnd));
  const remainingDays = Math.max(0, diffInDays(now, params.periodEnd));
  const prorated = Math.round((params.modulePrice * remainingDays) / totalDays);
  return prorated;
}

export async function recalcSubscriptionAmounts(
  tenantId: string,
  tx: any = prisma,
) {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { organisationSize: true },
  });
  if (!tenant) throw new Error('Tenant not found');

  const activeModules = await tx.subscriptionModule.findMany({
    where: { tenantId, status: 'ACTIVE' },
    select: { moduleKey: true },
  });
  const moduleKeys = activeModules.map((m) => m.moduleKey);

  const { monthlyTotal, annualTotal, organisationSizeKey, surcharge } = calculateAmounts({
    modules: moduleKeys,
    organisationSize: tenant.organisationSize || 0,
  });

  await tx.subscription.update({
    where: { tenantId },
    data: {
      monthlyAmount: toDecimal(monthlyTotal),
      annualAmount: toDecimal(annualTotal),
    },
  });

  await tx.tenant.update({
    where: { id: tenantId },
    data: {
      currentMonthlyAmount: toDecimal(monthlyTotal),
      currentAnnualAmount: toDecimal(annualTotal),
    },
  });

  return { monthlyTotal, annualTotal, organisationSizeKey, surcharge };
}

export function buildSubscriptionModulePayload(moduleKey: string) {
  const price = getModulePrice(moduleKey);
  if (price === null) {
    throw new Error(`Unknown module key: ${moduleKey}`);
  }
  return { monthlyPrice: price };
}

export async function ensureTenantModuleEnabled(
  tenantId: string,
  moduleKey: string,
  tx: any = prisma,
) {
  await tx.tenantModule.upsert({
    where: { tenantId_moduleKey: { tenantId, moduleKey } },
    update: { isEnabled: true, disabledAt: null },
    create: {
      tenantId,
      moduleKey,
      isEnabled: true,
      enabledAt: new Date(),
    },
  });
}

export async function disableTenantModule(
  tenantId: string,
  moduleKey: string,
  tx: typeof prisma = prisma,
) {
  await tx.tenantModule.updateMany({
    where: { tenantId, moduleKey },
    data: { isEnabled: false, disabledAt: new Date() },
  });
}
