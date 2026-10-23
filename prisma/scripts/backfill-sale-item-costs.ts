/**
 * Backfill script: fill sale_items.unit_cost for sales made before the cost
 * was captured at sale time.
 *
 * Each line gets the weighted average cost of the purchases recorded before the
 * sale (cost_source PURCHASE_HISTORY). Products with no recorded purchase fall
 * back to their current cost price (cost_source CURRENT_PRICE, shown as an
 * estimate in analytics).
 *
 * Safe to re-run — it only touches lines whose unit_cost is still NULL.
 *
 * Usage:
 *   npm run backfill:sale-costs                      # all tenants
 *   npm run backfill:sale-costs -- --dry-run         # count only, write nothing
 *   npm run backfill:sale-costs -- --tenant=<id>     # one tenant
 */

import 'dotenv/config';
import { prisma } from '../../src/db.js';
import { backfillSaleItemCosts } from '../../src/services/saleCostService.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const tenantId = process.argv.find((a) => a.startsWith('--tenant='))?.split('=')[1];

  console.log(`🔍  Filling sale line costs${dryRun ? ' (dry run)' : ''}${tenantId ? ` for tenant ${tenantId}` : ''}...\n`);
  const r = await backfillSaleItemCosts({ tenantId, dryRun });

  console.log(`✅  Done.`);
  console.log(`   Tenants          : ${r.tenants}`);
  console.log(`   Sale lines       : ${r.lines}`);
  console.log(`   From purchases   : ${r.fromHistory}  (exact)`);
  console.log(`   From cost price  : ${r.fromCurrentPrice}  (estimated, no purchase recorded)`);
}

main()
  .catch((err) => {
    console.error('❌  Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
