/**
 * One-off: activate the SolarPro Solutions demo tenant for marketing screenshots.
 * Mirrors approveTenant without requiring a super-admin session.
 */
import 'dotenv/config';
import { prisma } from '../../src/db.js';

const TENANT_ID = '9c5bb822-90d9-4800-82bf-7350214c4e2c';

async function main() {
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  {
    const tx = prisma;
    await tx.tenant.update({
      where: { id: TENANT_ID },
      data: {
        status: 'ACTIVE',
        approvedAt: now,
        suspendedReason: null,
        nextBillingDate: periodEnd,
      },
    });

    await tx.subscription.upsert({
      where: { tenantId: TENANT_ID },
      update: {
        status: 'ACTIVE',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
      create: {
        tenantId: TENANT_ID,
        billingCycle: 'MONTHLY',
        status: 'ACTIVE',
        monthlyAmount: 0,
        annualAmount: 0,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
    });
  }

  const t = await prisma.tenant.findUnique({ where: { id: TENANT_ID }, select: { status: true, name: true } });
  console.log('Tenant:', t);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
