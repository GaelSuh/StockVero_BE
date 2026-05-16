/**
 * Seed: Modules
 *
 * Populates the `modules` table with all platform module definitions.
 * Safe to re-run — uses upsert (idempotent).
 *
 * Usage:
 *   npm run db:seed
 *   npx prisma db seed
 */

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { MODULES_CONFIG } from '../src/config/modules.js';

async function main() {
  console.log('🌱  Seeding modules...\n');

  for (const [index, mod] of MODULES_CONFIG.entries()) {
    const result = await prisma.module.upsert({
      where: { key: mod.key },
      update: {
        displayName: mod.displayName,
        description: mod.description ?? null,
        sortOrder: index,
      },
      create: {
        key: mod.key,
        displayName: mod.displayName,
        description: mod.description ?? null,
        isActive: true,
        sortOrder: index,
      },
    });
    console.log(`  ✓  ${result.displayName.padEnd(12)} (${result.key})`);
  }

  console.log(`\n✅  Seeded ${MODULES_CONFIG.length} modules successfully.`);
  console.log(`ℹ️   Use 'npm run create-super-admin' to create the first admin account.\n`);
}

main()
  .catch((err) => {
    console.error('❌  Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
