/**
 * Tenant insights: list, detail, summary, CSV export, nightly score history.
 * Every score comes from computeInsight() (score.ts) on inputs from prepareTenants() (inputs.ts).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { insightsConfig as cfg } from '../../config/insights.config.js';
import { addDays, latestCompleteDay } from '../tenantMetrics.service.js';
import { computeInsight, dayDiff, type InsightResult, type Tier } from './score.js';
import { prepareTenants, type PreparedTenant } from './inputs.js';

export const CURRENCY = 'XAF'; // no per-tenant currency exists; every amount in the system is XAF
export const CSV_MAX_ROWS = 5000;

export interface Insight extends PreparedTenant {
  result: InsightResult;
  /** Rank by value among the tenants loaded (customers only unless internal/demo/test are included). */
  rank: number;
}

/** Latest complete snapshot day: the newest snapshot day that is not after yesterday (Douala). */
export async function resolveAsOf(): Promise<string | null> {
  const latest = latestCompleteDay();
  const row = await prisma.tenantDailyMetric.aggregate({ _max: { day: true }, where: { day: { lte: new Date(`${latest}T00:00:00Z`) } } });
  return row._max.day ? row._max.day.toISOString().slice(0, 10) : null;
}

/**
 * Score eligible tenants and rank them by value. Internal, demo and test tenants are left out
 * (of the rows, the ranking and every total) unless `includeInternal` is set.
 */
export async function loadInsights(asOf: string, opts: { onlyIds?: string[]; includeInternal?: boolean } = {}): Promise<Insight[]> {
  const prepared = (await prepareTenants(asOf)).filter((p) => opts.includeInternal || p.tenant.tenantType === 'CUSTOMER');
  const scored = prepared.map((p) => ({ ...p, result: computeInsight(p.input, cfg), rank: 0 }));
  scored
    .slice()
    .sort((a, b) => b.result.value.score - a.result.value.score || b.input.value90 - a.input.value90 || a.tenant.name.localeCompare(b.tenant.name))
    .forEach((x, i) => { x.rank = i + 1; });
  return opts.onlyIds ? scored.filter((s) => opts.onlyIds!.includes(s.tenant.id)) : scored;
}

const changePct = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10);

function windowSummary(i: Insight, w: 30 | 90) {
  const m = i.windows[w];
  return {
    days: w,
    salesValue: m.current.salesValue, salesValuePrev: m.previous.salesValue, salesValueChangePct: changePct(m.current.salesValue, m.previous.salesValue),
    salesCount: m.current.salesCount, salesCountPrev: m.previous.salesCount, salesCountChangePct: changePct(m.current.salesCount, m.previous.salesCount),
  };
}

function milestoneList(i: Insight) {
  const m = i.milestones;
  return [
    { key: 'first_login', label: 'First login', reached: Boolean(m.firstLoginDay), day: m.firstLoginDay },
    { key: 'first_product', label: 'First product created', reached: Boolean(m.firstProductDay), day: m.firstProductDay },
    { key: 'first_sale', label: 'First sale recorded', reached: Boolean(m.firstSaleDay), day: m.firstSaleDay },
  ];
}

/** One list row (also the base of the detail response). */
export function toRow(i: Insight) {
  const r = i.result;
  return {
    tenant: {
      id: i.tenant.id, name: i.tenant.name, slug: i.tenant.slug, ownerEmail: i.tenant.ownerEmail,
      approvedDay: i.tenant.approvedDay, tenantType: i.tenant.tenantType,
    },
    plan: i.tenant.plan,
    status: i.tenant.status,
    accountOwner: i.tenant.accountOwner,
    valueTier: r.value.tier,
    valueScore: r.value.score,
    valueRank: i.rank,
    sales: { last30: windowSummary(i, 30), last90: windowSummary(i, 90) },
    activeUsers30: i.input.users.active30,
    lastActivityDay: i.input.lastActivityDay,
    daysSinceActivity: r.daysSinceActivity,
    health: { state: r.state, stateReason: r.stateReason, score: r.score, band: r.band, partial: r.partial, missingFactors: r.missingFactors },
    trendPct: r.trendPct,
    trendLowConfidence: r.trendLowConfidence,
    flags: r.flags,
    onboarding: r.state === 'ONBOARDING' ? milestoneList(i) : null,
    sparklineSalesCount: i.sparkline,
    currency: CURRENCY,
  };
}
export type InsightRow = ReturnType<typeof toRow>;

// ── list ────────────────────────────────────────────────────────────────────

export interface ListQuery {
  page: number;
  limit: number;
  plan?: string;
  tier?: string;
  band?: string; // HEALTHY | NEEDS_ATTENTION | AT_RISK | ONBOARDING | INSUFFICIENT_DATA | SUSPENDED | INACTIVE
  module?: string;
  moduleState?: 'enabled' | 'used';
  minDaysInactive?: number;
  status?: string;
  tenantType?: string;
  includeInternal?: boolean;
  /** 'none' = unassigned; any other value is an admin id ('me' is resolved by the controller). */
  accountOwner?: string;
  /** Only tenants carrying this flag (e.g. TRIAL_ENDING, DORMANT). */
  flag?: string;
  search?: string;
  sort: 'value' | 'health' | 'lastActivity' | 'trend';
  order: 'asc' | 'desc';
}

export function filterAndSort(all: Insight[], q: ListQuery) {
  const search = q.search?.trim().toLowerCase();
  const rows = all.filter((i) => {
    const r = i.result;
    if (q.plan && i.tenant.plan !== q.plan) return false;
    if (q.tier && r.value.tier !== q.tier) return false;
    if (q.band && (r.band ?? r.state) !== q.band) return false;
    if (q.status && i.tenant.status !== q.status) return false;
    if (q.tenantType && i.tenant.tenantType !== q.tenantType) return false;
    if (q.flag && !r.flags.some((f) => f.code === q.flag)) return false;
    if (q.accountOwner === 'none' && i.tenant.accountOwner) return false;
    if (q.accountOwner && q.accountOwner !== 'none' && i.tenant.accountOwner?.id !== q.accountOwner) return false;
    if (q.module) {
      const m = i.modules.find((x) => x.key === q.module);
      if (!m) return false;
      if (q.moduleState === 'used' && m.used !== 'yes') return false;
    }
    if (q.minDaysInactive !== undefined && (r.daysSinceActivity ?? Number.POSITIVE_INFINITY) < q.minDaysInactive) return false;
    if (search && !i.tenant.name.toLowerCase().includes(search) && !(i.tenant.ownerEmail ?? '').toLowerCase().includes(search)) return false;
    return true;
  });
  // Unknown values (no score, never active, no trend) always sort last, whatever the order.
  const key = (i: Insight): number | null => {
    switch (q.sort) {
      case 'value': return i.result.value.score;
      case 'health': return i.result.score;
      case 'lastActivity': return i.input.lastActivityDay ? Date.parse(`${i.input.lastActivityDay}T00:00:00Z`) : null;
      case 'trend': return i.result.trendPct;
    }
  };
  const dir = q.order === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka === null || kb === null) return ka === kb ? a.rank - b.rank : ka === null ? 1 : -1;
    return (ka - kb) * dir || a.rank - b.rank;
  });
  const total = rows.length;
  const start = (q.page - 1) * q.limit;
  return { total, all: rows, rows: rows.slice(start, start + q.limit) };
}

// ── CSV export (same columns as the on-screen table, plus tenant id) ───────────

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Quote when needed; neutralise spreadsheet formulas in free text (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const CSV_COLUMNS = [
  'tenant_id', 'tenant', 'plan', 'tenant_type', 'status', 'value_tier', 'value_rank', 'value_score',
  'health_state', 'health_score', 'health_band', 'partial_score', 'trend_30d_pct', 'trend_low_confidence',
  'sales_value_30d', 'sales_value_30d_prev', 'sales_count_30d', 'sales_value_90d', 'sales_count_90d',
  'active_users_30d', 'last_activity_day', 'days_since_activity', 'flags', 'account_owner', 'onboarding_stage', 'currency',
] as const;

export function toCsv(rows: Insight[]): string {
  const lines = rows.map((i) => {
    const r = toRow(i);
    const stage = r.onboarding ? `${r.onboarding.filter((m) => m.reached).length}/3 milestones` : '';
    return [
      r.tenant.id, r.tenant.name.trim(), r.plan, r.tenant.tenantType, r.status, r.valueTier, r.valueRank, r.valueScore,
      r.health.state, r.health.score, r.health.band, r.health.partial, r.trendPct, r.trendLowConfidence,
      r.sales.last30.salesValue, r.sales.last30.salesValuePrev, r.sales.last30.salesCount, r.sales.last90.salesValue, r.sales.last90.salesCount,
      r.activeUsers30, r.lastActivityDay, r.daysSinceActivity, r.flags.map((f) => f.code).join(' '), r.accountOwner?.name ?? '', stage, r.currency,
    ].map(csvCell).join(',');
  });
  // BOM so Excel opens accented tenant names correctly.
  return '﻿' + [CSV_COLUMNS.join(','), ...lines].join('\r\n') + '\r\n';
}

// ── detail ──────────────────────────────────────────────────────────────────

export async function tenantDetail(i: Insight, from: string, to: string) {
  const range = { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) };
  const [series, history] = await Promise.all([
    prisma.tenantDailyMetric.findMany({
      where: { tenantId: i.tenant.id, day: range },
      orderBy: { day: 'asc' },
      select: { day: true, salesValue: true, salesCount: true, returnsValue: true, returnsCount: true, activeUsers: true, userActions: true },
    }),
    prisma.tenantDailyScore.findMany({
      where: { tenantId: i.tenant.id, day: range },
      orderBy: { day: 'asc' },
      select: { day: true, score: true, band: true, state: true },
    }),
  ]);
  const row = toRow(i);
  return {
    ...row,
    health: { ...row.health, factors: i.result.factors },
    value: i.result.value,
    windows: i.windows,
    series: {
      from, to,
      days: series.map((d) => ({
        day: d.day.toISOString().slice(0, 10),
        salesValue: Number(d.salesValue), salesCount: d.salesCount, returnsValue: Number(d.returnsValue), returnsCount: d.returnsCount,
        activeUsers: d.activeUsers, userActions: d.userActions,
      })),
    },
    /** Stored nightly scores in the range (empty when there is little history yet). */
    scoreHistory: history.map((h) => ({ day: h.day.toISOString().slice(0, 10), score: h.score, band: h.band, state: h.state })),
    modules: i.modules,
    users: i.input.users,
    milestones: milestoneList(i),
    bandChange: await bandChange(i.tenant.id, i.result.asOf),
  };
}

// ── summary ─────────────────────────────────────────────────────────────────

const TIER_ORDER: Record<Tier, number> = { KEY_ACCOUNT: 0, GROWTH: 1, STANDARD: 2 };

/**
 * "Needs attention" ordering: scored tenants in the At risk or Needs attention bands, most
 * valuable first (tier, then value score), then the lowest health score. A valuable account
 * that is slipping matters more than an empty dormant one.
 */
export function needsAttentionOrder(all: Insight[]) {
  return all
    .filter((i) => i.result.state === 'SCORED' && (i.result.band === 'AT_RISK' || i.result.band === 'NEEDS_ATTENTION'))
    .sort((a, b) =>
      TIER_ORDER[a.result.value.tier] - TIER_ORDER[b.result.value.tier] ||
      b.result.value.score - a.result.value.score ||
      a.result.score! - b.result.score! ||
      a.rank - b.rank);
}

export function summary(all: Insight[]) {
  const sum = (f: (i: Insight) => number) => all.reduce((s, i) => s + f(i), 0);
  const v30 = sum((i) => i.windows[30].current.salesValue);
  const v30p = sum((i) => i.windows[30].previous.salesValue);
  const count = <K extends string>(keys: K[], f: (i: Insight) => string) =>
    Object.fromEntries(keys.map((k) => [k, all.filter((i) => f(i) === k).length])) as Record<K, number>;
  const brief = (i: Insight) => {
    const { sparklineSalesCount: _drop, ...row } = toRow(i);
    return row;
  };
  const n = cfg.api.summaryTopN;
  const dormant = all.filter((i) => i.result.flags.some((f) => f.code === 'DORMANT'))
    .sort((a, b) => a.rank - b.rank);
  return {
    platform: {
      valueProcessed30: v30, valueProcessedPrev30: v30p, valueProcessedChangePct: changePct(v30, v30p),
      salesCount30: sum((i) => i.windows[30].current.salesCount),
      eligibleTenants: all.length,
      activeTenants30: all.filter((i) => i.windows[30].current.activeDays > 0).length,
      activeUsers30: sum((i) => i.input.users.active30),
      currency: CURRENCY,
    },
    byHealth: count(['HEALTHY', 'NEEDS_ATTENTION', 'AT_RISK', 'ONBOARDING', 'INSUFFICIENT_DATA', 'SUSPENDED', 'INACTIVE'], (i) => i.result.band ?? i.result.state),
    byTier: count(['KEY_ACCOUNT', 'GROWTH', 'STANDARD'], (i) => i.result.value.tier),
    topByValue: [...all].sort((a, b) => a.rank - b.rank).slice(0, n).map(brief),
    mostAtRisk: needsAttentionOrder(all).slice(0, n).map(brief),
    dormantCount: dormant.length,
    /** Most valuable dormant tenants first. */
    dormant: dormant.slice(0, n).map(brief),
    trialsEndingSoon: all.filter((i) => i.result.flags.some((f) => f.code === 'TRIAL_ENDING')).map(brief),
  };
}

// ── nightly score history ───────────────────────────────────────────────────

/**
 * Score every eligible tenant (internal/demo/test included, so their history exists too) as of
 * `day` and upsert one row per tenant; unchanged rows are not rewritten.
 */
export async function storeDailyScores(day: string, triggeredBy = 'cron') {
  const run = await prisma.metricsJobRun.create({
    data: { kind: 'SCORES', fromDay: new Date(`${day}T00:00:00Z`), toDay: new Date(`${day}T00:00:00Z`), triggeredBy, status: 'RUNNING' },
  });
  const errors: Array<{ tenantId: string; message: string }> = [];
  let processed = 0;
  try {
    const all = await loadInsights(day, { includeInternal: true });
    for (const i of all) {
      try {
        const r = i.result;
        const result = JSON.stringify({ ...r, valueRank: i.rank });
        await prisma.$executeRaw`
          INSERT INTO tenant_daily_scores AS s (id, tenant_id, day, state, score, band, tier, value_score, partial, result, created_at, updated_at)
          VALUES (gen_random_uuid()::text, ${i.tenant.id}, ${day}::date, ${r.state}, ${r.score}, ${r.band}, ${r.value.tier}, ${r.value.score},
                  ${r.partial}, ${result}::jsonb, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
          ON CONFLICT (tenant_id, day) DO UPDATE SET state = EXCLUDED.state, score = EXCLUDED.score, band = EXCLUDED.band,
            tier = EXCLUDED.tier, value_score = EXCLUDED.value_score, partial = EXCLUDED.partial, result = EXCLUDED.result, updated_at = EXCLUDED.updated_at
          WHERE (s.state, s.score, s.band, s.tier, s.value_score, s.partial, s.result)
            IS DISTINCT FROM (EXCLUDED.state, EXCLUDED.score, EXCLUDED.band, EXCLUDED.tier, EXCLUDED.value_score, EXCLUDED.partial, EXCLUDED.result)`;
        processed += 1;
      } catch (err: unknown) {
        errors.push({ tenantId: i.tenant.id, message: String((err as Error)?.message ?? err).replace(/\s+/g, ' ').trim().slice(0, 500) });
      }
    }
  } catch (err: unknown) {
    errors.push({ tenantId: '*', message: String((err as Error)?.message ?? err).replace(/\s+/g, ' ').trim().slice(0, 500) });
  }
  const status = errors.length === 0 ? 'SUCCESS' : processed > 0 ? 'PARTIAL' : 'FAILED';
  await prisma.metricsJobRun.update({
    where: { id: run.id },
    data: { status, tenantsProcessed: processed, tenantsFailed: errors.filter((e) => e.tenantId !== '*').length, errors: errors.length ? errors : Prisma.JsonNull, finishedAt: new Date() },
  });
  console.log(`[METRICS] SCORES ${day}: ${status}, ${processed} tenants ok, ${errors.length} failed`);
  return { runId: run.id, status, processed, errors };
}

/**
 * Did the tenant's band change since the previous day, and since 7 days earlier?
 * Unscored days compare by state (e.g. ONBOARDING → HEALTHY counts as a change).
 */
export async function bandChange(tenantId: string, day: string) {
  const days = [day, addDays(day, -1), addDays(day, -7)];
  const rows = await prisma.tenantDailyScore.findMany({
    where: { tenantId, day: { in: days.map((d) => new Date(`${d}T00:00:00Z`)) } },
    select: { day: true, band: true, state: true, score: true },
  });
  const at = (d: string) => {
    const r = rows.find((x) => x.day.toISOString().slice(0, 10) === d);
    return r ? { day: d, band: r.band ?? r.state, score: r.score } : null;
  };
  const today = at(day);
  const compare = (prev: ReturnType<typeof at>) =>
    today && prev ? { ...prev, changed: prev.band !== today.band, scoreDelta: today.score !== null && prev.score !== null ? today.score - prev.score : null } : null;
  return { day, current: today, previousDay: compare(at(days[1])), sevenDaysAgo: compare(at(days[2])) };
}

export { dayDiff };
