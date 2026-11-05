/**
 * Daily per-tenant metrics snapshot (admin monitoring foundation).
 *
 * One row per tenant per Africa/Douala day in `tenant_daily_metrics`, counts and sums only.
 *
 * Two kinds of numbers:
 *   flow          — sales, returns, usage. Derived from history, so any date range can be
 *                   (re)computed at any time. Recomputed for the trailing 7 days every night
 *                   so any late change to a recent day is picked up.
 *   point-in-time — catalogue/stock levels. Only knowable "now", so they are captured by the
 *                   nightly run for the day that just ended and never invented for past days.
 *                   Backfill and rebuild leave them untouched (NULL on backfilled days).
 *
 * All aggregation runs in Postgres, one tenant at a time, so the job holds one pooled
 * connection and never loads transactions into memory. Every write is an upsert that only
 * touches a row when a value actually changed, so re-running gives identical rows.
 *
 * Timestamps in this database are `timestamp without time zone` holding UTC wall-clock time,
 * so a Douala day D covers [D 00:00 WAT, D+1 00:00 WAT) converted to UTC.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

export const METRICS_TZ = 'Africa/Douala';
/** Flow days recomputed by each nightly run, ending with the day that just finished. */
const NIGHTLY_FLOW_WINDOW_DAYS = 7;
const DEAD_STOCK_DAYS = 60;

export type MetricsRunKind = 'NIGHTLY' | 'BACKFILL' | 'REBUILD';

export interface MetricsRunOptions {
  kind: MetricsRunKind;
  /** Inclusive Douala days, YYYY-MM-DD. */
  from: string;
  to: string;
  /** Limit to one tenant; omitted = every eligible tenant. */
  tenantId?: string;
  /** Capture catalogue (point-in-time) metrics for this day. Only the nightly run sets it. */
  pointInTimeDay?: string;
  triggeredBy: string;
}

export interface MetricsRunResult {
  runId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  tenantsProcessed: number;
  tenantsFailed: number;
  errors: Array<{ tenantId: string; message: string }>;
  tenantIds: string[];
}

// ── Day helpers (Douala has no DST, but Intl keeps us honest) ───────────────

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: METRICS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Today's date in Douala, YYYY-MM-DD. */
export const doualaToday = (now: Date = new Date()): string => dayFormatter.format(now);

export const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The most recent Douala day that has fully ended. */
export const latestCompleteDay = (now: Date = new Date()): string => addDays(doualaToday(now), -1);

export const isDay = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

// ── Eligibility ─────────────────────────────────────────────────────────────

/**
 * ACTIVE and SUSPENDED tenants, plus INACTIVE ones that were approved at some point
 * (deactivated after use). INACTIVE without approval is a denied signup; PENDING is skipped.
 */
export async function eligibleTenants(tenantId?: string) {
  return prisma.tenant.findMany({
    where: {
      ...(tenantId ? { id: tenantId } : {}),
      OR: [
        { status: { in: ['ACTIVE', 'SUSPENDED'] } },
        { status: 'INACTIVE', approvedAt: { not: null } },
      ],
    },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

// ── Flow metrics: one statement computes and upserts every day in range ─────

async function upsertFlow(tenantId: string, from: string, to: string): Promise<number> {
  return prisma.$executeRaw(Prisma.sql`
    WITH bounds AS (
      SELECT (${from}::date::timestamp AT TIME ZONE ${METRICS_TZ}) AT TIME ZONE 'UTC' AS lo,
             ((${to}::date + 1)::timestamp AT TIME ZONE ${METRICS_TZ}) AT TIME ZONE 'UTC' AS hi
    ),
    days AS (
      SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS day
    ),
    s AS (
      SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE ${METRICS_TZ})::date AS day,
             count(*)                                                    AS n,
             coalesce(sum(total_amount), 0)                              AS v,
             count(*) FILTER (WHERE mode = 'RETAIL')                     AS rn,
             coalesce(sum(total_amount) FILTER (WHERE mode = 'RETAIL'), 0)    AS rv,
             count(*) FILTER (WHERE mode = 'WHOLESALE')                  AS wn,
             coalesce(sum(total_amount) FILTER (WHERE mode = 'WHOLESALE'), 0) AS wv
      FROM sales, bounds
      WHERE tenant_id = ${tenantId} AND created_at >= bounds.lo AND created_at < bounds.hi
        -- Created COMPLETED; RETURNED is set later when fully refunded, so it still counts
        -- as a sale on its own day (the refund is counted as a return on the refund's day).
        -- DRAFT and CANCELLED are excluded (no code path writes them today).
        AND status IN ('COMPLETED', 'PARTIAL', 'RETURNED')
      GROUP BY 1
    ),
    r AS (
      SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE ${METRICS_TZ})::date AS day,
             count(*) AS n, coalesce(sum(refund_amount), 0) AS v
      FROM sale_returns, bounds
      WHERE tenant_id = ${tenantId} AND created_at >= bounds.lo AND created_at < bounds.hi
      GROUP BY 1
    ),
    a AS (
      SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE ${METRICS_TZ})::date AS day, actor_id
      FROM audit_logs, bounds
      WHERE tenant_id = ${tenantId} AND created_at >= bounds.lo AND created_at < bounds.hi
        AND actor_type IN ('OWNER', 'EMPLOYEE') AND status = 'SUCCESS'
    ),
    -- Sales and returns write no audit entries, so a cashier who only sells would be
    -- invisible to the audit log; their activity counts towards active users.
    actors AS (
      SELECT day, actor_id FROM a WHERE actor_id IS NOT NULL
      UNION
      SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE ${METRICS_TZ})::date, sold_by_id
      FROM sales, bounds
      WHERE tenant_id = ${tenantId} AND created_at >= bounds.lo AND created_at < bounds.hi AND sold_by_id IS NOT NULL
      UNION
      SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE ${METRICS_TZ})::date, processed_by_id
      FROM sale_returns, bounds
      WHERE tenant_id = ${tenantId} AND created_at >= bounds.lo AND created_at < bounds.hi AND processed_by_id IS NOT NULL
    ),
    u AS (SELECT day, count(DISTINCT actor_id) AS n FROM actors GROUP BY 1),
    act AS (SELECT day, count(*) AS n FROM a GROUP BY 1)
    INSERT INTO tenant_daily_metrics AS m (
      id, tenant_id, day,
      sales_count, sales_value, retail_sales_count, retail_sales_value, wholesale_sales_count, wholesale_sales_value,
      returns_count, returns_value, active_users, user_actions,
      flow_computed_at, created_at, updated_at
    )
    SELECT gen_random_uuid()::text, ${tenantId}, d.day,
           coalesce(s.n, 0), coalesce(s.v, 0), coalesce(s.rn, 0), coalesce(s.rv, 0), coalesce(s.wn, 0), coalesce(s.wv, 0),
           coalesce(r.n, 0), coalesce(r.v, 0), coalesce(u.n, 0), coalesce(act.n, 0),
           now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
    FROM days d
    LEFT JOIN s   ON s.day = d.day
    LEFT JOIN r   ON r.day = d.day
    LEFT JOIN u   ON u.day = d.day
    LEFT JOIN act ON act.day = d.day
    ON CONFLICT (tenant_id, day) DO UPDATE SET
      sales_count = EXCLUDED.sales_count, sales_value = EXCLUDED.sales_value,
      retail_sales_count = EXCLUDED.retail_sales_count, retail_sales_value = EXCLUDED.retail_sales_value,
      wholesale_sales_count = EXCLUDED.wholesale_sales_count, wholesale_sales_value = EXCLUDED.wholesale_sales_value,
      returns_count = EXCLUDED.returns_count, returns_value = EXCLUDED.returns_value,
      active_users = EXCLUDED.active_users, user_actions = EXCLUDED.user_actions,
      flow_computed_at = EXCLUDED.flow_computed_at, updated_at = EXCLUDED.updated_at
    -- Only rewrite when something changed, so a re-run leaves rows byte-identical.
    WHERE (m.sales_count, m.sales_value, m.retail_sales_count, m.retail_sales_value, m.wholesale_sales_count,
           m.wholesale_sales_value, m.returns_count, m.returns_value, m.active_users, m.user_actions)
      IS DISTINCT FROM
          (EXCLUDED.sales_count, EXCLUDED.sales_value, EXCLUDED.retail_sales_count, EXCLUDED.retail_sales_value,
           EXCLUDED.wholesale_sales_count, EXCLUDED.wholesale_sales_value, EXCLUDED.returns_count,
           EXCLUDED.returns_value, EXCLUDED.active_users, EXCLUDED.user_actions)
  `);
}

// ── Point-in-time catalogue metrics (STOCK-type products) ───────────────────

/**
 * On-hand follows the app's own inventory rule (inventory.items.controller buildBatchCategoryStats):
 * QUANTITY with variants → sum of variant quantities; QUANTITY without → the product's column;
 * SERIALIZED → count of units with stock_status AVAILABLE. Low/out use resolveStockStatus's rule.
 * Dead stock: on hand > 0 and no stock-log entry and no sale in the 60 days before the day's end.
 */
async function capturePointInTime(tenantId: string, day: string): Promise<number> {
  return prisma.$executeRaw(Prisma.sql`
    WITH asof AS (
      SELECT ((${day}::date + 1)::timestamp AT TIME ZONE ${METRICS_TZ}) AT TIME ZONE 'UTC' AS t
    ),
    p AS (
      SELECT id, stock_tracking_mode, quantity_on_hand, cost_price, reorder_threshold
      FROM inventory_categories WHERE tenant_id = ${tenantId} AND type = 'STOCK'
    ),
    v AS (
      SELECT category_id, count(*) AS n_all, count(*) FILTER (WHERE is_active) AS n_active,
             coalesce(sum(quantity_on_hand), 0) AS qty
      FROM product_variants WHERE tenant_id = ${tenantId} GROUP BY 1
    ),
    units AS (
      SELECT category_id, count(*) AS avail
      FROM product_items WHERE tenant_id = ${tenantId} AND stock_status = 'AVAILABLE' GROUP BY 1
    ),
    moved AS (
      SELECT category_id, max(created_at) AS at FROM category_stock_logs WHERE tenant_id = ${tenantId} GROUP BY 1
      UNION ALL
      SELECT si.category_id, max(s.created_at) FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.tenant_id = ${tenantId} GROUP BY 1
    ),
    last_move AS (SELECT category_id, max(at) AS at FROM moved GROUP BY 1),
    oh AS (
      SELECT p.*,
             CASE
               WHEN p.stock_tracking_mode = 'QUANTITY' AND coalesce(v.n_all, 0) > 0 THEN v.qty
               WHEN p.stock_tracking_mode = 'QUANTITY' THEN coalesce(p.quantity_on_hand, 0)
               ELSE coalesce(units.avail, 0)
             END AS on_hand,
             coalesce(v.n_active, 0) AS active_variants,
             lm.at AS last_moved
      FROM p
      LEFT JOIN v ON v.category_id = p.id
      LEFT JOIN units ON units.category_id = p.id
      LEFT JOIN last_move lm ON lm.category_id = p.id
    ),
    agg AS (
      SELECT count(*)::int                                                              AS product_count,
             coalesce(sum(active_variants), 0)::int                                    AS variant_count,
             coalesce(sum(on_hand) FILTER (WHERE stock_tracking_mode <> 'QUANTITY'), 0)::int AS serialized_units,
             coalesce(sum(on_hand) FILTER (WHERE stock_tracking_mode = 'QUANTITY'), 0)::int  AS quantity_units,
             coalesce(sum(on_hand * cost_price), 0)::numeric(16, 2)                    AS stock_value,
             count(*) FILTER (WHERE on_hand <= 0)::int                                 AS out_of_stock,
             count(*) FILTER (WHERE on_hand > 0 AND on_hand <= reorder_threshold)::int AS low_stock,
             count(*) FILTER (WHERE on_hand > 0 AND (last_moved IS NULL
                     OR last_moved < (SELECT t FROM asof) - ${Prisma.raw(`interval '${DEAD_STOCK_DAYS} days'`)}))::int AS dead_stock
      FROM oh
    )
    UPDATE tenant_daily_metrics m SET
      product_count = agg.product_count, variant_count = agg.variant_count,
      serialized_units_in_stock = agg.serialized_units, quantity_units_in_stock = agg.quantity_units,
      stock_value_at_cost = agg.stock_value, out_of_stock_count = agg.out_of_stock,
      low_stock_count = agg.low_stock, dead_stock_count = agg.dead_stock,
      point_in_time_captured_at = now() AT TIME ZONE 'UTC', updated_at = now() AT TIME ZONE 'UTC'
    FROM agg
    WHERE m.tenant_id = ${tenantId} AND m.day = ${day}::date
      AND (m.product_count, m.variant_count, m.serialized_units_in_stock, m.quantity_units_in_stock,
           m.stock_value_at_cost, m.out_of_stock_count, m.low_stock_count, m.dead_stock_count)
        IS DISTINCT FROM
          (agg.product_count, agg.variant_count, agg.serialized_units, agg.quantity_units,
           agg.stock_value, agg.out_of_stock, agg.low_stock, agg.dead_stock)
  `);
}

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Compute snapshots for every eligible tenant (or one), sequentially, isolating failures.
 * Each tenant's range starts no earlier than its own creation day.
 */
export async function runMetrics(opts: MetricsRunOptions): Promise<MetricsRunResult> {
  const run = await prisma.metricsJobRun.create({
    data: {
      kind: opts.kind,
      fromDay: new Date(`${opts.from}T00:00:00Z`),
      toDay: new Date(`${opts.to}T00:00:00Z`),
      tenantId: opts.tenantId ?? null,
      triggeredBy: opts.triggeredBy,
      status: 'RUNNING',
    },
  });

  const errors: MetricsRunResult['errors'] = [];
  const tenantIds: string[] = [];
  let processed = 0;

  try {
    const tenants = await eligibleTenants(opts.tenantId);
    // ponytail: sequential, one connection; switch to a small p-limit pool if tenant count makes the nightly run slow.
    for (const t of tenants) {
      const createdDay = doualaToday(t.createdAt);
      const from = opts.from > createdDay ? opts.from : createdDay;
      if (from > opts.to) continue; // tenant did not exist in this range
      try {
        await upsertFlow(t.id, from, opts.to);
        if (opts.pointInTimeDay && opts.pointInTimeDay >= from && opts.pointInTimeDay <= opts.to) {
          await capturePointInTime(t.id, opts.pointInTimeDay);
        }
        processed += 1;
        tenantIds.push(t.id);
      } catch (err: any) {
        const message = String(err?.message ?? err).replace(/\s+/g, ' ').trim().slice(0, 500);
        errors.push({ tenantId: t.id, message });
        console.error(`[METRICS] ${opts.kind} failed for tenant ${t.id}: ${message}`);
      }
    }
  } catch (err: any) {
    errors.push({ tenantId: '*', message: String(err?.message ?? err).slice(0, 500) });
    console.error('[METRICS] run failed before processing tenants:', err);
  }

  const status: MetricsRunResult['status'] =
    errors.length === 0 ? 'SUCCESS' : processed > 0 ? 'PARTIAL' : 'FAILED';
  await prisma.metricsJobRun.update({
    where: { id: run.id },
    data: {
      status,
      tenantsProcessed: processed,
      tenantsFailed: errors.filter((e) => e.tenantId !== '*').length,
      errors: errors.length ? errors : Prisma.JsonNull,
      finishedAt: new Date(),
    },
  });

  console.log(`[METRICS] ${opts.kind} ${opts.from}..${opts.to}: ${status}, ${processed} tenants ok, ${errors.length} failed`);
  return { runId: run.id, status, tenantsProcessed: processed, tenantsFailed: errors.length, errors, tenantIds };
}

/**
 * Nightly: flow for the trailing window ending yesterday, catalogue captured for yesterday.
 * Skips if a nightly run for that day already succeeded (a duplicate would be harmless,
 * because writes are idempotent, but it would be wasted work).
 */
export async function runNightlyMetrics(now: Date = new Date(), opts: { force?: boolean } = {}) {
  const day = latestCompleteDay(now);
  if (!opts.force) {
    const done = await prisma.metricsJobRun.findFirst({
      where: { kind: 'NIGHTLY', toDay: new Date(`${day}T00:00:00Z`), status: 'SUCCESS' },
      select: { id: true },
    });
    if (done) {
      console.log(`[METRICS] nightly for ${day} already succeeded (${done.id}); skipping`);
      return null;
    }
  }
  return runMetrics({
    kind: 'NIGHTLY',
    from: addDays(day, -(NIGHTLY_FLOW_WINDOW_DAYS - 1)),
    to: day,
    pointInTimeDay: day,
    triggeredBy: 'cron',
  });
}

/** Full-history flow backfill for every eligible tenant (or one). Safe to re-run. */
export async function runBackfill(triggeredBy: string, tenantId?: string) {
  const tenants = await eligibleTenants(tenantId);
  if (tenants.length === 0) return null;
  const from = doualaToday(tenants[0].createdAt);
  return runMetrics({ kind: 'BACKFILL', from, to: latestCompleteDay(), tenantId, triggeredBy });
}
