/**
 * The one place a tenant's health score, band, value tier and flags are computed.
 *
 * Pure: prepared inputs + config in, result out. No database, no clock (the as-of day is an
 * input), so the nightly job and every admin endpoint get identical answers for identical
 * inputs, and the function is unit-tested with synthetic fixtures.
 */
import type { InsightsConfig } from '../../config/insights.config.js';

export type ModuleUse = 'yes' | 'no' | 'unknown';
export type TenantState = 'SCORED' | 'ONBOARDING' | 'INSUFFICIENT_DATA' | 'SUSPENDED' | 'INACTIVE';
export type Band = 'HEALTHY' | 'NEEDS_ATTENTION' | 'AT_RISK';
export type Tier = 'KEY_ACCOUNT' | 'GROWTH' | 'STANDARD';
export type FactorKey = 'recency' | 'frequency' | 'trend' | 'adoption' | 'breadth' | 'subscription';

export interface InsightInput {
  /** Douala day the result describes (latest complete snapshot day), YYYY-MM-DD. */
  asOf: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
  plan: string;
  /** Douala day the tenant was approved (falls back to creation day when unknown). */
  approvedDay: string;
  /** Snapshot rows on or before asOf. */
  snapshotDays: number;
  /** Snapshot days missing in the last 30 that should exist (tenant already existed). */
  missingDaysIn30: number;
  /** Latest Douala day with any activity (snapshot activity or last-seen), or null if never. */
  lastActivityDay: string | null;
  /** Days with any activity in the last 30 (from snapshots). */
  activeDays30: number;
  /** Sales count and user actions, last 30 days vs the 30 before. */
  trend: { salesCur: number; salesPrev: number; actionsCur: number; actionsPrev: number };
  /** total = non-deactivated users (owners + employees); active = distinct users active in the window. */
  users: { total: number; active7: number; active30: number };
  modules: Array<{ key: string; used: ModuleUse; lastUsedDay: string | null }>;
  /** Subscription status (ACTIVE, TRIALING, PAST_DUE, CANCELLED) or null when the tenant has none. */
  subscription: { status: string | null; trialEndsDay: string | null };
  /** Last 30 days. */
  sales30: { value: number; returnsValue: number };
  /** Value processed in the last 90 days (sales value, tenant currency). */
  value90: number;
}

export interface Factor {
  key: FactorKey;
  label: string;
  available: boolean;
  /** The measured inputs, for display. */
  raw: Record<string, number | string | boolean | null>;
  points: number;
  /** Maximum after redistributing missing factors' points. */
  maxPoints: number;
  /** Maximum from config before redistribution. */
  baseMaxPoints: number;
  lowConfidence?: boolean;
  explanation: string;
}

export interface Flag {
  code: 'DORMANT' | 'DECLINING' | 'PAST_DUE' | 'TRIAL_ENDING' | 'TRIAL_CONVERSION_OPPORTUNITY' | 'HIGH_RETURNS' | 'FEW_USERS_ACTIVE';
  label: string;
  values: Record<string, number | string | null>;
}

export interface ValueComponent {
  key: 'value90' | 'activeUsers' | 'breadth' | 'plan';
  available: boolean;
  share: number;
  points: number;
  maxPoints: number;
  explanation: string;
}

export interface InsightResult {
  asOf: string;
  state: TenantState;
  stateReason: string | null;
  score: number | null;
  band: Band | null;
  partial: boolean;
  missingFactors: FactorKey[];
  factors: Factor[];
  daysSinceActivity: number | null;
  trendPct: number | null;
  trendLowConfidence: boolean;
  value: { score: number; tier: Tier; components: ValueComponent[]; reasons: string[] };
  flags: Flag[];
}

// ── helpers ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** Whole days from a to b (b − a) for YYYY-MM-DD strings. */
export const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
/** Linear share: 0 at `zeroAt`, 1 at `fullAt`, clamped (works in either direction). */
const linear = (x: number, zeroAt: number, fullAt: number) => clamp01((x - zeroAt) / (fullAt - zeroAt));
const round1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const money = (x: number) => Math.round(x).toLocaleString('en-US');

/** Scale available factors' maxima so they still add up to 100. */
function redistribute<T extends { available: boolean; baseMaxPoints: number }>(items: T[]): number {
  const availableBase = items.filter((i) => i.available).reduce((s, i) => s + i.baseMaxPoints, 0);
  return availableBase > 0 ? 100 / availableBase : 0;
}

// ── health factors ──────────────────────────────────────────────────────────

type Partialfactor = Omit<Factor, 'points' | 'maxPoints'> & { share: number };

function recencyFactor(i: InsightInput, c: InsightsConfig, daysSince: number | null): Partialfactor {
  const { fullWithinDays, zeroAtDays } = c.health.recency;
  const rule = `Full points within ${fullWithinDays} days, zero after ${zeroAtDays}.`;
  if (daysSince === null) {
    return { key: 'recency', label: 'Recency', available: true, baseMaxPoints: c.health.weights.recency, share: 0,
      raw: { daysSinceActivity: null }, explanation: `No activity recorded yet. ${rule}` };
  }
  return { key: 'recency', label: 'Recency', available: true, baseMaxPoints: c.health.weights.recency,
    share: linear(daysSince, zeroAtDays, fullWithinDays), raw: { daysSinceActivity: daysSince, lastActivityDay: i.lastActivityDay },
    explanation: `Last activity ${daysSince === 0 ? 'today' : daysSince === 1 ? '1 day ago' : `${daysSince} days ago`}. ${rule}` };
}

function frequencyFactor(i: InsightInput, c: InsightsConfig): Partialfactor {
  const { windowDays, fullAtActiveDays } = c.health.frequency;
  return { key: 'frequency', label: 'Frequency', available: true, baseMaxPoints: c.health.weights.frequency,
    share: clamp01(i.activeDays30 / fullAtActiveDays), raw: { activeDays: i.activeDays30, windowDays },
    explanation: `Active on ${i.activeDays30} of the last ${windowDays} days. Full points at ${fullAtActiveDays} active days.` };
}

function trendFactor(i: InsightInput, c: InsightsConfig) {
  const t = c.health.trend;
  const useSales = i.trend.salesCur + i.trend.salesPrev > 0;
  const measure = useSales ? 'sales' : 'user actions';
  const cur = useSales ? i.trend.salesCur : i.trend.actionsCur;
  const prev = useSales ? i.trend.salesPrev : i.trend.actionsPrev;
  const minBase = useSales ? t.minBaseSales : t.minBaseActions;
  const base = { key: 'trend' as const, label: 'Trend', available: true, baseMaxPoints: c.health.weights.trend };
  const rule = `Full points at +${t.fullAtPct}% or better, zero at ${t.zeroAtPct}% or worse.`;

  if (cur === 0 && prev === 0) {
    return { factor: { ...base, share: 0, raw: { measure: 'none', current: 0, previous: 0, changePct: null },
      explanation: `No sales or user actions in the last ${t.windowDays} days or the ${t.windowDays} before.` } as Partialfactor, pct: null, lowConfidence: false };
  }
  // prev === 0 only reaches here with cur > 0, which is always low confidence (minBase > 0), so no division by zero.
  const changePct = prev === 0 ? t.capPct : Math.max(-t.capPct, Math.min(t.capPct, ((cur - prev) / prev) * 100));
  // A tenant with no current activity at all earns nothing, however small the earlier window was.
  const currentIdle = i.trend.salesCur === 0 && i.trend.actionsCur === 0;
  const lowConfidence = !currentIdle && prev < minBase;
  const share = currentIdle ? 0 : lowConfidence ? t.lowConfidenceShare : linear(changePct, t.zeroAtPct, t.fullAtPct);
  const changeText = `${changePct >= 0 ? '+' : ''}${Math.round(changePct)}%`;
  const explanation = currentIdle
    ? `No sales or user actions in the last ${t.windowDays} days (${prev} ${measure} before). No current activity earns no trend points.`
    : lowConfidence
      ? `${cur} ${measure} in the last ${t.windowDays} days vs ${prev} before (${changeText}). Fewer than ${minBase} before, so the trend is low confidence and earns half points.`
      : `${cur} ${measure} in the last ${t.windowDays} days vs ${prev} before (${changeText}). ${rule}`;
  return { factor: { ...base, share, lowConfidence, raw: { measure, current: cur, previous: prev, changePct: Math.round(changePct) }, explanation } as Partialfactor,
    pct: changePct, lowConfidence };
}

function adoptionFactor(i: InsightInput, c: InsightsConfig): Partialfactor {
  const { windowDays, fullAtRatio } = c.health.adoption;
  const base = { key: 'adoption' as const, label: 'User adoption', baseMaxPoints: c.health.weights.adoption };
  if (i.users.total === 0) {
    return { ...base, available: false, share: 0, raw: { activeUsers: i.users.active30, totalUsers: 0 },
      explanation: 'No non-deactivated users to measure adoption against.' };
  }
  const ratio = i.users.active30 / i.users.total;
  return { ...base, available: true, share: clamp01(ratio / fullAtRatio), raw: { activeUsers: i.users.active30, totalUsers: i.users.total, ratio: round1(ratio * 100) / 100 },
    explanation: `${i.users.active30} of ${i.users.total} users active in the last ${windowDays} days (${pct(ratio)}). Full points at ${pct(fullAtRatio)}.` };
}

function breadthFactor(i: InsightInput, c: InsightsConfig): Partialfactor {
  const { windowDays, fullAtRatio } = c.health.breadth;
  const measurable = i.modules.filter((m) => m.used !== 'unknown');
  const used = measurable.filter((m) => m.used === 'yes').length;
  const unknown = i.modules.length - measurable.length;
  const base = { key: 'breadth' as const, label: 'Module breadth', baseMaxPoints: c.health.weights.breadth };
  if (measurable.length === 0) {
    return { ...base, available: false, share: 0, raw: { used: 0, measurable: 0, unknown },
      explanation: 'None of the enabled modules has a usage signal.' };
  }
  const ratio = used / measurable.length;
  return { ...base, available: true, share: clamp01(ratio / fullAtRatio), raw: { used, measurable: measurable.length, unknown, ratio: round1(ratio * 100) / 100 },
    explanation: `${used} of ${measurable.length} measurable enabled modules used in the last ${windowDays} days${unknown ? ` (${unknown} more have no usage signal)` : ''}. Full points at ${pct(fullAtRatio)}.` };
}

function subscriptionFactor(i: InsightInput, c: InsightsConfig): Partialfactor {
  const base = { key: 'subscription' as const, label: 'Subscription', baseMaxPoints: c.health.weights.subscription };
  const status = i.subscription.status;
  const share = status ? c.health.subscription[status] : undefined;
  if (status === null || share === undefined) {
    return { ...base, available: false, share: 0, raw: { status },
      explanation: status ? `Subscription status ${status} is not mapped to points.` : 'No subscription on record.' };
  }
  const words: Record<string, string> = { ACTIVE: 'Active and paid', TRIALING: 'On trial', PAST_DUE: 'Past due', CANCELLED: 'Cancelled' };
  return { ...base, available: true, share, raw: { status },
    explanation: `${words[status] ?? status}: ${pct(share)} of the subscription points.` };
}

// ── value tier ──────────────────────────────────────────────────────────────

function valueTier(i: InsightInput, c: InsightsConfig) {
  const v = c.value;
  const measurable = i.modules.filter((m) => m.used !== 'unknown');
  const breadthRatio = measurable.length ? measurable.filter((m) => m.used === 'yes').length / measurable.length : null;
  const planShare = v.planLevel[i.plan];
  const comps: Array<Omit<ValueComponent, 'points' | 'maxPoints'> & { baseMaxPoints: number }> = [
    { key: 'value90', available: true, baseMaxPoints: v.weights.value90, share: clamp01(i.value90 / v.value90FullAt),
      explanation: `Processed ${money(i.value90)} in the last 90 days (full at ${money(v.value90FullAt)}).` },
    { key: 'activeUsers', available: true, baseMaxPoints: v.weights.activeUsers, share: clamp01(i.users.active30 / v.activeUsersFullAt),
      explanation: `${i.users.active30} active user${i.users.active30 === 1 ? '' : 's'} in the last 30 days (full at ${v.activeUsersFullAt}).` },
    { key: 'breadth', available: breadthRatio !== null, baseMaxPoints: v.weights.breadth, share: breadthRatio ?? 0,
      explanation: breadthRatio === null ? 'No module has a usage signal.' : `Uses ${pct(breadthRatio)} of its measurable modules.` },
    { key: 'plan', available: planShare !== undefined, baseMaxPoints: v.weights.plan, share: planShare ?? 0,
      explanation: `On the ${i.plan.charAt(0) + i.plan.slice(1).toLowerCase()} plan.` },
  ];
  const scale = redistribute(comps);
  const components: ValueComponent[] = comps.map(({ baseMaxPoints, ...rest }) => {
    const maxPoints = rest.available ? round1(baseMaxPoints * scale) : 0;
    return { ...rest, maxPoints, points: rest.available ? round1(rest.share * baseMaxPoints * scale) : 0 };
  });
  const score = Math.round(components.reduce((s, x) => s + x.points, 0));
  const tier: Tier = score >= v.tiers.keyAccount ? 'KEY_ACCOUNT' : score >= v.tiers.growth ? 'GROWTH' : 'STANDARD';
  const reasons = components.filter((x) => x.points > 0).sort((a, b) => b.points - a.points).slice(0, 3).map((x) => x.explanation);
  return { score, tier, components, reasons: reasons.length ? reasons : ['No sales, active users, module use or plan level to count yet.'] };
}

// ── flags ───────────────────────────────────────────────────────────────────

function flagsFor(i: InsightInput, c: InsightsConfig, daysSince: number | null, trend: { pct: number | null; lowConfidence: boolean }): Flag[] {
  const f = c.flags;
  const flags: Flag[] = [];
  const ageDays = dayDiff(i.approvedDay, i.asOf);
  if (daysSince !== null ? daysSince >= f.dormantDays : ageDays >= f.dormantDays) {
    flags.push({ code: 'DORMANT', label: daysSince === null ? 'No activity since joining' : `No activity for ${daysSince} days`,
      values: { daysSinceActivity: daysSince, thresholdDays: f.dormantDays } });
  }
  if (trend.pct !== null && !trend.lowConfidence && trend.pct <= f.decliningPct) {
    flags.push({ code: 'DECLINING', label: `Activity down ${Math.abs(Math.round(trend.pct))}% on the previous 30 days`,
      values: { changePct: Math.round(trend.pct), thresholdPct: f.decliningPct } });
  }
  if (i.subscription.status === 'PAST_DUE') flags.push({ code: 'PAST_DUE', label: 'Subscription past due', values: { status: 'PAST_DUE' } });
  if (i.subscription.trialEndsDay) {
    const left = dayDiff(i.asOf, i.subscription.trialEndsDay);
    if (left >= 0 && left <= f.trialEndingDays) {
      flags.push({ code: 'TRIAL_ENDING', label: `Trial ends in ${left} day${left === 1 ? '' : 's'}`, values: { daysLeft: left, trialEndsDay: i.subscription.trialEndsDay } });
      if (i.activeDays30 >= f.trialHighUsageActiveDays) {
        flags.push({ code: 'TRIAL_CONVERSION_OPPORTUNITY', label: 'Trial ending with high usage: conversion opportunity',
          values: { daysLeft: left, activeDays30: i.activeDays30, thresholdActiveDays: f.trialHighUsageActiveDays } });
      }
    }
  }
  if (i.sales30.value > 0) {
    const rate = (i.sales30.returnsValue / i.sales30.value) * 100;
    if (rate > f.highReturnsPct) {
      flags.push({ code: 'HIGH_RETURNS', label: `Returns ${Math.round(rate)}% of sales value in 30 days`,
        values: { returnsValue: i.sales30.returnsValue, salesValue: i.sales30.value, ratePct: Math.round(rate), thresholdPct: f.highReturnsPct } });
    }
  }
  if (i.users.total > 0 && i.users.active30 / i.users.total < f.fewUsersRatio) {
    flags.push({ code: 'FEW_USERS_ACTIVE', label: `${i.users.active30} of ${i.users.total} users active in 30 days`,
      values: { activeUsers: i.users.active30, totalUsers: i.users.total, thresholdRatio: f.fewUsersRatio } });
  }
  return flags;
}

// ── entry point ─────────────────────────────────────────────────────────────

export function computeInsight(i: InsightInput, c: InsightsConfig): InsightResult {
  const daysSince = i.lastActivityDay ? Math.max(0, dayDiff(i.lastActivityDay, i.asOf)) : null;
  const trend = trendFactor(i, c);
  const value = valueTier(i, c);
  const flags = flagsFor(i, c, daysSince, trend);
  const common = { asOf: i.asOf, daysSinceActivity: daysSince, trendPct: trend.pct === null ? null : Math.round(trend.pct), trendLowConfidence: trend.lowConfidence, value, flags };
  const unscored = (state: TenantState, stateReason: string): InsightResult =>
    ({ ...common, state, stateReason, score: null, band: null, partial: false, missingFactors: [], factors: [] });

  if (i.status === 'SUSPENDED') return unscored('SUSPENDED', 'Suspended tenants are not scored.');
  if (i.status === 'INACTIVE') return unscored('INACTIVE', 'Deactivated tenants are not scored.');
  const ageDays = dayDiff(i.approvedDay, i.asOf);
  if (ageDays < c.states.onboardingDays) {
    return unscored('ONBOARDING', `Approved ${ageDays} day${ageDays === 1 ? '' : 's'} ago; scoring starts after ${c.states.onboardingDays} days.`);
  }
  if (i.snapshotDays < c.states.minHistoryDays) {
    return unscored('INSUFFICIENT_DATA', `Only ${i.snapshotDays} days of snapshot history; at least ${c.states.minHistoryDays} needed.`);
  }
  if (i.missingDaysIn30 > c.states.maxMissingDaysIn30) {
    return unscored('INSUFFICIENT_DATA', `${i.missingDaysIn30} of the last 30 days have no snapshot; history is inconsistent.`);
  }

  const partials = [recencyFactor(i, c, daysSince), frequencyFactor(i, c), trend.factor, adoptionFactor(i, c), breadthFactor(i, c), subscriptionFactor(i, c)];
  const scale = redistribute(partials);
  const factors: Factor[] = partials.map(({ share, ...f }) => ({
    ...f,
    maxPoints: f.available ? round1(f.baseMaxPoints * scale) : 0,
    points: f.available ? round1(share * f.baseMaxPoints * scale) : 0,
  }));
  const missingFactors = factors.filter((f) => !f.available).map((f) => f.key);
  const score = Math.round(factors.reduce((s, f) => s + f.points, 0));
  const band: Band = score >= c.health.bands.healthy ? 'HEALTHY' : score >= c.health.bands.needsAttention ? 'NEEDS_ATTENTION' : 'AT_RISK';
  return { ...common, state: 'SCORED', stateReason: null, score, band, partial: missingFactors.length > 0, missingFactors, factors };
}
