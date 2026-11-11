/**
 * Read-only check of a database before a release. Writes nothing.
 *
 *   DATABASE_URL="<production url>" npx tsx prisma/scripts/release-check.ts
 *
 * Reports:
 *   1. migrations in prisma/migrations not yet applied, and any failed one
 *      (a failed migration blocks every later `migrate deploy`);
 *   2. negative stock counts, which make 20261021000000_stock_never_negative fail;
 *   3. products per business by counting mode (serialized or by quantity), so
 *      existing clients can confirm each product is counted the way they sell it.
 *
 * Exits 1 when something would block the deploy.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL to the database to check.');

const db = new pg.Client({ connectionString: url });
await db.connect();
let blocking = false;

const host = new URL(url).host;
console.log(`Database: ${host}\n`);

// ── 1. Migrations ────────────────────────────────────────────────────────────
const local = fs
  .readdirSync(path.join(process.cwd(), 'prisma', 'migrations'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const { rows: applied } = await db.query<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>(
  'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations',
);
const done = new Set(applied.filter((m) => m.finished_at && !m.rolled_back_at).map((m) => m.migration_name));
const failed = applied.filter((m) => !m.finished_at && !m.rolled_back_at).map((m) => m.migration_name);
const pending = local.filter((name) => !done.has(name));

console.log('1. Migrations');
console.log(`   applied: ${done.size}   pending: ${pending.length}`);
for (const name of pending) console.log(`   - pending  ${name}`);
for (const name of failed) {
  console.log(`   - FAILED   ${name}  (blocks deploys: fix, then \`npx prisma migrate resolve\`)`);
  blocking = true;
}

// ── 2. Negative stock ────────────────────────────────────────────────────────
const columns = async (table: string) =>
  (await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name LIKE 'quantity_%'`,
    [table],
  )).rows.map((r) => r.column_name).filter((c) => ['quantity_on_hand', 'quantity_faulty', 'quantity_damaged'].includes(c));

console.log('\n2. Negative stock');
for (const table of ['inventory_categories', 'product_variants']) {
  const cols = await columns(table);
  if (cols.length === 0) {
    console.log(`   ${table}: no stock columns yet`);
    continue;
  }
  const where = cols.map((c) => `"${c}" < 0`).join(' OR ');
  const label = table === 'inventory_categories' ? 'name' : 'label';
  const { rows } = await db.query(`SELECT t.name AS business, x.${label} AS item, ${cols.map((c) => `x."${c}"`).join(', ')}
    FROM "${table}" x JOIN tenants t ON t.id = x.tenant_id WHERE ${where} ORDER BY 1, 2`);
  console.log(`   ${table}: ${rows.length} negative row(s)`);
  for (const r of rows) console.log(`   - ${JSON.stringify(r)}`);
  if (rows.length > 0) blocking = true;
}

// ── 3. Counting mode per business ────────────────────────────────────────────
console.log('\n3. Products by counting mode');
const { rows: modes } = await db.query(`
  SELECT t.name AS business, c.stock_tracking_mode AS mode, count(*)::int AS products,
         -- A product with variants: its own count (not yet shared out) plus its variants'.
         coalesce(sum(c.quantity_on_hand + (SELECT coalesce(sum(v.quantity_on_hand), 0) FROM product_variants v WHERE v.category_id = c.id)), 0)::int AS quantity_on_hand,
         (SELECT count(*)::int FROM product_items pi JOIN inventory_categories c2 ON c2.id = pi.category_id
           WHERE c2.tenant_id = t.id AND c2.stock_tracking_mode = c.stock_tracking_mode) AS serial_units
  FROM inventory_categories c JOIN tenants t ON t.id = c.tenant_id
  GROUP BY t.id, t.name, c.stock_tracking_mode ORDER BY t.name, mode`);
for (const r of modes) {
  console.log(`   ${String(r.business).padEnd(32)} ${String(r.mode).padEnd(11)} ${String(r.products).padStart(5)} products  ` +
    (r.mode === 'QUANTITY' ? `${r.quantity_on_hand} in stock` : `${r.serial_units} units recorded`));
}

// ── 4. Preview of the variant stock pool fix ────────────────────────────────
if (pending.includes('20261108000000_variant_stock_pool')) {
  console.log('\n4. Variant stock pool (20261108000000): product number before → after');
  const { rows: pool } = await db.query(`
    WITH variant_stock AS (
      SELECT category_id, SUM(quantity_on_hand)::int AS held FROM product_variants GROUP BY category_id
    ), variant_moves AS (
      SELECT category_id, SUM(delta)::int AS moved FROM category_stock_logs WHERE variant_id IS NOT NULL GROUP BY category_id
    )
    SELECT t.name AS business, c.name AS product, c.quantity_on_hand AS before, vs.held,
           GREATEST(0, c.quantity_on_hand + COALESCE(m.moved, 0) - vs.held) AS after
    FROM inventory_categories c
    JOIN variant_stock vs ON vs.category_id = c.id
    LEFT JOIN variant_moves m ON m.category_id = c.id
    JOIN tenants t ON t.id = c.tenant_id
    WHERE c.stock_tracking_mode = 'QUANTITY'
    ORDER BY 1, 2`);
  for (const r of pool) {
    console.log(`   ${String(r.business).padEnd(28)} ${String(r.product).padEnd(28)} ${r.before} → ${r.after} not yet shared out (variants hold ${r.held})`);
  }
  if (pool.length === 0) console.log('   no quantity products with variants');
}

await db.end();
console.log(blocking ? '\nBLOCKED: fix the items above before deploying.' : '\nNothing blocks the deploy.');
process.exit(blocking ? 1 : 0);
