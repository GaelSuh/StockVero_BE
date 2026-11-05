/**
 * Unit tests for the pure insights scorer. Synthetic fixtures only (never production data).
 * Run: npm run test:insights
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInsight, type InsightInput } from './score.js';
import { insightsConfig as cfg } from '../../config/insights.config.js';

const AS_OF = '2026-10-05';
const daysAgo = (n: number) => { const d = new Date(`${AS_OF}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

/** A healthy, fully measurable tenant; tests override one thing at a time. */
const base = (o: Partial<InsightInput> = {}): InsightInput => ({
  asOf: AS_OF, status: 'ACTIVE', plan: 'GROWTH', approvedDay: daysAgo(200), snapshotDays: 200, missingDaysIn30: 0,
  lastActivityDay: AS_OF, activeDays30: 25,
  trend: { salesCur: 120, salesPrev: 100, actionsCur: 400, actionsPrev: 380 },
  users: { total: 4, active7: 4, active30: 4 },
  modules: [
    { key: 'inventory', used: 'yes', lastUsedDay: AS_OF }, { key: 'retail_sales', used: 'yes', lastUsedDay: AS_OF },
    { key: 'finance', used: 'yes', lastUsedDay: daysAgo(3) }, { key: 'dashboard', used: 'unknown', lastUsedDay: null },
  ],
  subscription: { status: 'ACTIVE', trialEndsDay: null }, sales30: { value: 3_000_000, returnsValue: 30_000 }, value90: 9_000_000,
  ...o,
});
const factor = (r: ReturnType<typeof computeInsight>, key: string) => r.factors.find((f) => f.key === key)!;
const flagCodes = (r: ReturnType<typeof computeInsight>) => r.flags.map((f) => f.code).sort();

test('config: health and value weights each sum to 100', () => {
  assert.equal(Object.values(cfg.health.weights).reduce((a, b) => a + b, 0), 100);
  assert.equal(Object.values(cfg.value.weights).reduce((a, b) => a + b, 0), 100);
});

test('recency: full within 3 days, midpoint at 12 days, zero at 21+ and when never active', () => {
  assert.equal(factor(computeInsight(base({ lastActivityDay: daysAgo(3) }), cfg), 'recency').points, 25);
  assert.equal(factor(computeInsight(base({ lastActivityDay: daysAgo(12) }), cfg), 'recency').points, 12.5);
  assert.equal(factor(computeInsight(base({ lastActivityDay: daysAgo(21) }), cfg), 'recency').points, 0);
  const never = factor(computeInsight(base({ lastActivityDay: null }), cfg), 'recency');
  assert.equal(never.points, 0);
  assert.match(never.explanation, /No activity recorded yet/);
});

test('frequency: zero, midpoint (10 days), full (20+ days)', () => {
  assert.equal(factor(computeInsight(base({ activeDays30: 0 }), cfg), 'frequency').points, 0);
  assert.equal(factor(computeInsight(base({ activeDays30: 10 }), cfg), 'frequency').points, 10);
  assert.equal(factor(computeInsight(base({ activeDays30: 20 }), cfg), 'frequency').points, 20);
});

test('trend: +10% full, -30% zero, -10% midpoint; capped at ±100%', () => {
  const t = (cur: number, prev: number) => factor(computeInsight(base({ trend: { salesCur: cur, salesPrev: prev, actionsCur: 0, actionsPrev: 0 } }), cfg), 'trend');
  assert.equal(t(110, 100).points, 20);
  assert.equal(t(70, 100).points, 0);
  assert.equal(t(90, 100).points, 10);
  assert.equal(t(500, 100).raw.changePct, 100);
  assert.equal(t(0, 100).raw.changePct, -100);
});

test('trend: division by zero cannot happen; both windows zero → 0 points', () => {
  const none = computeInsight(base({ trend: { salesCur: 0, salesPrev: 0, actionsCur: 0, actionsPrev: 0 } }), cfg);
  assert.equal(factor(none, 'trend').points, 0);
  assert.equal(none.trendPct, null);
  const fromZero = computeInsight(base({ trend: { salesCur: 7, salesPrev: 0, actionsCur: 0, actionsPrev: 0 } }), cfg);
  assert.equal(fromZero.trendPct, 100);
  assert.equal(fromZero.trendLowConfidence, true);
});

test('trend: low confidence (earlier window below base, current active) → half points and flagged, never Declining', () => {
  const r = computeInsight(base({ trend: { salesCur: 2, salesPrev: 4, actionsCur: 10, actionsPrev: 0 } }), cfg);
  assert.equal(factor(r, 'trend').points, 10);
  assert.equal(factor(r, 'trend').lowConfidence, true);
  assert.ok(!flagCodes(r).includes('DECLINING'));
});

test('trend: no current activity → 0 points whatever the earlier window (small or large), not low confidence', () => {
  for (const prev of [1, 4, 25]) {
    const r = computeInsight(base({ trend: { salesCur: 0, salesPrev: prev, actionsCur: 0, actionsPrev: 3 } }), cfg);
    assert.equal(factor(r, 'trend').points, 0, `prev ${prev}`);
    assert.equal(r.trendLowConfidence, false);
    assert.match(factor(r, 'trend').explanation, /No current activity earns no trend points/);
  }
  // Actions alone in the current window count as activity: the low-confidence rule still applies.
  const actionsOnly = computeInsight(base({ trend: { salesCur: 0, salesPrev: 2, actionsCur: 5, actionsPrev: 1 } }), cfg);
  assert.equal(factor(actionsOnly, 'trend').points, 10);
});

test('trend: falls back to user actions when no sales in either window (base 20)', () => {
  const r = computeInsight(base({ trend: { salesCur: 0, salesPrev: 0, actionsCur: 22, actionsPrev: 20 } }), cfg);
  assert.equal(factor(r, 'trend').raw.measure, 'user actions');
  assert.equal(factor(r, 'trend').points, 20);
});

test('adoption: zero, midpoint (35%), full (70%+)', () => {
  assert.equal(factor(computeInsight(base({ users: { total: 10, active7: 0, active30: 0 } }), cfg), 'adoption').points, 0);
  assert.equal(factor(computeInsight(base({ users: { total: 20, active7: 7, active30: 7 } }), cfg), 'adoption').points, 7.5);
  assert.equal(factor(computeInsight(base({ users: { total: 10, active7: 7, active30: 7 } }), cfg), 'adoption').points, 15);
});

test('breadth: unknown modules are excluded from the ratio, not counted as unused', () => {
  const mods = (used: Array<'yes' | 'no' | 'unknown'>) => used.map((u, k) => ({ key: `m${k}`, used: u, lastUsedDay: null }));
  assert.equal(factor(computeInsight(base({ modules: mods(['no', 'no', 'unknown']) }), cfg), 'breadth').points, 0);
  assert.equal(factor(computeInsight(base({ modules: mods(['yes', 'no', 'no', 'no', 'no', 'no', 'unknown']) }), cfg), 'breadth').points, 2.8); // 1/6 ÷ 0.6 × 10
  assert.equal(factor(computeInsight(base({ modules: mods(['yes', 'yes', 'yes', 'no', 'no', 'unknown']) }), cfg), 'breadth').points, 10); // 60%
});

test('subscription: active 100%, trial 70%, past due 0%', () => {
  const s = (status: string) => factor(computeInsight(base({ subscription: { status, trialEndsDay: null } }), cfg), 'subscription').points;
  assert.equal(s('ACTIVE'), 10);
  assert.equal(s('TRIALING'), 7);
  assert.equal(s('PAST_DUE'), 0);
});

test('bands: 70 → Healthy, 69 → Needs attention, 40 → Needs attention, 39 → At risk', () => {
  // Every factor full except frequency, which is tuned to land on the boundary.
  const at = (score: number) => computeInsight(base({ activeDays30: score - 80 }), cfg); // 80 + activeDays points
  assert.equal(at(100).score, 100);
  const band = (activeDays: number, users = 4) =>
    computeInsight(base({ activeDays30: activeDays, users: { total: users, active7: 0, active30: 0 } }), cfg); // adoption 0 → max 85
  assert.equal(computeInsight(base({ activeDays30: 0, trend: { salesCur: 0, salesPrev: 0, actionsCur: 0, actionsPrev: 0 }, users: { total: 1, active7: 1, active30: 1 } }), cfg).score, 60);
  assert.equal(band(5).score, 70); assert.equal(band(5).band, 'HEALTHY');
  assert.equal(band(4).score, 69); assert.equal(band(4).band, 'NEEDS_ATTENTION');
  const low = (recencyDays: number) => computeInsight(base({ lastActivityDay: daysAgo(recencyDays), activeDays30: 0,
    trend: { salesCur: 0, salesPrev: 0, actionsCur: 0, actionsPrev: 0 }, users: { total: 4, active7: 0, active30: 0 } }), cfg);
  assert.equal(low(21).score, 20); // breadth 10 + subscription 10
  assert.equal(computeInsight(base({ lastActivityDay: daysAgo(21), activeDays30: 0, trend: { salesCur: 0, salesPrev: 0, actionsCur: 0, actionsPrev: 0 },
    users: { total: 4, active7: 0, active30: 0 }, modules: [], subscription: { status: 'ACTIVE', trialEndsDay: null } }), cfg).score, 11); // breadth missing → redistributed
  const forty = computeInsight(base({ lastActivityDay: daysAgo(3), activeDays30: 5, trend: { salesCur: 0, salesPrev: 0, actionsCur: 0, actionsPrev: 0 },
    users: { total: 4, active7: 0, active30: 0 }, modules: [{ key: 'a', used: 'no', lastUsedDay: null }] }), cfg); // 25 + 5 + 0 + 0 + 0 + 10
  assert.equal(forty.score, 40); assert.equal(forty.band, 'NEEDS_ATTENTION');
  const thirtyNine = computeInsight(base({ lastActivityDay: daysAgo(3), activeDays30: 4, trend: { salesCur: 0, salesPrev: 0, actionsCur: 0, actionsPrev: 0 },
    users: { total: 4, active7: 0, active30: 0 }, modules: [{ key: 'a', used: 'no', lastUsedDay: null }] }), cfg);
  assert.equal(thirtyNine.score, 39); assert.equal(thirtyNine.band, 'AT_RISK');
});

test('missing factor: points redistributed so the scale is still 0–100, result marked partial', () => {
  const r = computeInsight(base({ subscription: { status: null, trialEndsDay: null } }), cfg);
  assert.equal(r.partial, true);
  assert.deepEqual(r.missingFactors, ['subscription']);
  assert.equal(factor(r, 'subscription').maxPoints, 0);
  assert.equal(factor(r, 'recency').maxPoints, 27.8); // 25 × 100/90
  assert.equal(Math.round(r.factors.reduce((s, f) => s + f.maxPoints, 0)), 100);
  assert.equal(r.score, 100); // everything measurable is at full marks
});

test('special states: onboarding, insufficient data (short or gappy history), suspended, inactive', () => {
  const onb = computeInsight(base({ approvedDay: daysAgo(5) }), cfg);
  assert.equal(onb.state, 'ONBOARDING'); assert.equal(onb.score, null); assert.equal(onb.band, null);
  const shortHist = computeInsight(base({ snapshotDays: 10 }), cfg);
  assert.equal(shortHist.state, 'INSUFFICIENT_DATA'); assert.equal(shortHist.score, null);
  assert.equal(computeInsight(base({ missingDaysIn30: 3 }), cfg).state, 'INSUFFICIENT_DATA');
  const sus = computeInsight(base({ status: 'SUSPENDED' }), cfg);
  assert.equal(sus.state, 'SUSPENDED'); assert.equal(sus.score, null); assert.equal(sus.factors.length, 0);
  assert.equal(computeInsight(base({ status: 'INACTIVE' }), cfg).state, 'INACTIVE');
});

test('fixture: healthy', () => {
  const r = computeInsight(base(), cfg);
  assert.equal(r.state, 'SCORED'); assert.equal(r.band, 'HEALTHY'); assert.equal(r.score, 100);
  assert.deepEqual(flagCodes(r), []);
});

test('fixture: at risk', () => {
  const r = computeInsight(base({ lastActivityDay: daysAgo(18), activeDays30: 2, trend: { salesCur: 30, salesPrev: 100, actionsCur: 50, actionsPrev: 300 },
    users: { total: 10, active7: 0, active30: 1 } }), cfg);
  assert.equal(r.band, 'AT_RISK');
  assert.ok(r.score! < 40, `score ${r.score}`);
});

test('fixture: dormant (no activity 14+ days) flags DORMANT', () => {
  const r = computeInsight(base({ lastActivityDay: daysAgo(15), activeDays30: 6 }), cfg);
  assert.ok(flagCodes(r).includes('DORMANT'));
  assert.equal(r.daysSinceActivity, 15);
});

test('fixture: declining (−40%, confident) flags DECLINING', () => {
  const r = computeInsight(base({ trend: { salesCur: 60, salesPrev: 100, actionsCur: 0, actionsPrev: 0 } }), cfg);
  assert.ok(flagCodes(r).includes('DECLINING'));
  assert.equal(factor(r, 'trend').points, 0);
});

test('fixture: past due flags PAST_DUE and earns no subscription points', () => {
  const r = computeInsight(base({ subscription: { status: 'PAST_DUE', trialEndsDay: null } }), cfg);
  assert.ok(flagCodes(r).includes('PAST_DUE'));
  assert.equal(factor(r, 'subscription').points, 0);
});

test('flags: trial ending, conversion opportunity, high returns, few users active', () => {
  const r = computeInsight(base({ subscription: { status: 'TRIALING', trialEndsDay: daysAgo(-5) }, sales30: { value: 100_000, returnsValue: 20_000 },
    users: { total: 10, active7: 2, active30: 2 } }), cfg);
  assert.deepEqual(flagCodes(r), ['FEW_USERS_ACTIVE', 'HIGH_RETURNS', 'TRIAL_CONVERSION_OPPORTUNITY', 'TRIAL_ENDING']);
  const quiet = computeInsight(base({ activeDays30: 3, subscription: { status: 'TRIALING', trialEndsDay: daysAgo(-2) } }), cfg);
  assert.ok(flagCodes(quiet).includes('TRIAL_ENDING') && !flagCodes(quiet).includes('TRIAL_CONVERSION_OPPORTUNITY'));
});

test('value tier: thresholds, reasons and redistribution', () => {
  const top = computeInsight(base({ plan: 'ENTERPRISE', value90: 10_000_000, users: { total: 6, active7: 6, active30: 6 } }), cfg);
  assert.equal(top.value.tier, 'KEY_ACCOUNT'); assert.equal(top.value.score, 100); assert.equal(top.value.reasons.length, 3);
  const none = computeInsight(base({ plan: 'UNKNOWN', value90: 0, users: { total: 1, active7: 0, active30: 0 }, modules: [] }), cfg);
  assert.equal(none.value.score, 0); assert.equal(none.value.tier, 'STANDARD');
  assert.match(none.value.reasons[0], /No sales/);
});

test('every factor carries raw values, points, max points and a sentence', () => {
  for (const f of computeInsight(base(), cfg).factors) {
    assert.ok(f.explanation.length > 20 && f.explanation.endsWith('.'), f.key);
    assert.ok(f.points <= f.maxPoints && f.raw && typeof f.label === 'string', f.key);
  }
});
