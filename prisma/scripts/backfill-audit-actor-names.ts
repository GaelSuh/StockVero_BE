/**
 * Backfill script: fix "Unknown" actor names in audit_logs
 *
 * For every audit log row where actorName is NULL, 'Unknown', or empty AND
 * actorId is present, this script looks up the real first+last name from
 * the users (OWNER) or employees (EMPLOYEE) table and updates the row.
 *
 * Safe to re-run — it only updates rows that still have a missing/Unknown name.
 *
 * Usage:
 *   npx tsx prisma/scripts/backfill-audit-actor-names.ts
 */

import 'dotenv/config';
import { prisma } from '../../src/db.js';
import { AuditActorType } from '@prisma/client';

async function main() {
  console.log('🔍  Finding audit logs with missing actor names...\n');

  // Fetch all rows that need fixing (actorId present, name missing/Unknown)
  const rows = await prisma.auditLog.findMany({
    where: {
      actorId: { not: null },
      actorType: { in: [AuditActorType.OWNER, AuditActorType.EMPLOYEE] },
      OR: [
        { actorName: null },
        { actorName: '' },
        { actorName: 'Unknown' },
      ],
    },
    select: { id: true, actorId: true, actorType: true },
  });

  if (rows.length === 0) {
    console.log('✅  No rows need backfilling. All audit logs already have actor names.');
    return;
  }

  console.log(`Found ${rows.length} rows to backfill.\n`);

  // Deduplicate actorIds by type so we only query each person once
  const ownerIds = [...new Set(rows.filter(r => r.actorType === AuditActorType.OWNER).map(r => r.actorId!))];
  const employeeIds = [...new Set(rows.filter(r => r.actorType === AuditActorType.EMPLOYEE).map(r => r.actorId!))];

  // Bulk-fetch all relevant users and employees
  const [users, employees] = await Promise.all([
    ownerIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : Promise.resolve([]),
    employeeIds.length > 0
      ? prisma.employee.findMany({
          where: { id: { in: employeeIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : Promise.resolve([]),
  ]);

  const userMap = new Map(users.map(u => [u.id, `${u.firstName} ${u.lastName}`]));
  const employeeMap = new Map(employees.map(e => [e.id, `${e.firstName} ${e.lastName}`]));

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const name =
      row.actorType === AuditActorType.OWNER
        ? userMap.get(row.actorId!)
        : employeeMap.get(row.actorId!);

    if (!name) {
      // Actor no longer exists in the DB (deleted account)
      skipped++;
      continue;
    }

    await prisma.auditLog.update({
      where: { id: row.id },
      data: { actorName: name },
    });
    updated++;
  }

  console.log(`✅  Done.`);
  console.log(`   Updated : ${updated}`);
  console.log(`   Skipped (actor deleted): ${skipped}`);
}

main()
  .catch((err) => {
    console.error('❌  Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
