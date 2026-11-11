/**
 * Snapshot of row counts and money/stock totals per tenant, taken before and
 * after the branches migration. The two outputs must be identical: the
 * migration only assigns rows to a main branch, it never changes data.
 *
 *   npx tsx prisma/scripts/branches-migration-snapshot.ts > before.json
 *   (apply the migration)
 *   npx tsx prisma/scripts/branches-migration-snapshot.ts > after.json
 *   diff before.json after.json
 *
 * Raw SQL on purpose, so it runs against either schema version.
 */
import 'dotenv/config';
import { Pool } from 'pg';

const TABLES = [
  'inventory_items', 'product_categories', 'inventory_categories', 'product_variants', 'product_items',
  'product_item_maintenance_logs', 'category_stock_logs', 'inventory_movements', 'stock_movements',
  'customers', 'customer_contacts', 'customer_purchases', 'projects', 'project_milestones',
  'project_materials', 'project_assignments', 'transactions', 'invoices', 'invoice_payments',
  'tenant_finance_balance', 'documents', 'sales', 'sale_returns', 'price_lists', 'delivery_notes',
  'daily_summaries', 'employees', 'roles', 'audit_logs', 'notifications',
];

const SUMS: [string, string][] = [
  ['sales', 'total_amount'],
  ['sales', 'amount_owed'],
  ['transactions', 'amount'],
  ['tenant_finance_balance', 'net_balance'],
  ['inventory_categories', 'quantity_on_hand'],
  ['product_variants', 'quantity_on_hand'],
  ['inventory_items', 'qty'],
  ['sale_returns', 'refund_amount'],
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
  const out: Record<string, Record<string, string>> = {};
  const put = (tenant: string, key: string, value: unknown) => {
    (out[tenant] ??= {})[key] = String(value);
  };

  for (const t of TABLES) {
    const r = await pool.query(`SELECT tenant_id, COUNT(*)::text AS n FROM "${t}" GROUP BY tenant_id`);
    for (const row of r.rows) put(row.tenant_id, `count:${t}`, row.n);
  }
  for (const [t, c] of SUMS) {
    const r = await pool.query(`SELECT tenant_id, COALESCE(SUM("${c}"), 0)::text AS s FROM "${t}" GROUP BY tenant_id`);
    for (const row of r.rows) put(row.tenant_id, `sum:${t}.${c}`, row.s);
  }

  const sorted = Object.fromEntries(
    Object.keys(out).sort().map((k) => [k, Object.fromEntries(Object.entries(out[k]).sort())]),
  );
  console.log(JSON.stringify(sorted, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
