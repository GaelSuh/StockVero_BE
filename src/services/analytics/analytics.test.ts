import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketKeys, bucketOf, changePct, doualaDayHour, parseFilters, FilterError } from './period.js';
import { abcClasses, forecast } from './sales.js';
import { suggestedReorder } from './stock.js';
import { ageingBucket } from './customers.js';
import { averageCostAt } from '../saleCostService.js';

test('filters default to the last 30 days and pick daily buckets', () => {
  const f = parseFilters({}, '2026-10-14');
  assert.equal(f.from, '2026-09-15');
  assert.equal(f.to, '2026-10-14');
  assert.equal(f.days, 30);
  assert.equal(f.granularity, 'day');
  assert.equal(f.buckets.length, 30);
  assert.deepEqual([f.previous.from, f.previous.to], ['2026-08-16', '2026-09-14']);
});

test('long ranges use months and keep years apart', () => {
  const f = parseFilters({ from: '2025-11-01', to: '2026-02-10' }, '2026-10-14');
  assert.equal(f.granularity, 'month');
  assert.deepEqual(f.buckets, ['2025-11', '2025-12', '2026-01', '2026-02']);
});

test('bad filters are rejected', () => {
  assert.throws(() => parseFilters({ from: '2026-10-10', to: '2026-10-01' }), FilterError);
  assert.throws(() => parseFilters({ from: 'yesterday' }), FilterError);
});

test('days and hours are Douala time (UTC+1)', () => {
  assert.equal(bucketOf('2026-10-13T23:30:00Z', 'day'), '2026-10-14');
  assert.deepEqual(doualaDayHour('2026-10-13T23:30:00Z'), { dow: 3, hour: 0 });
  assert.deepEqual(bucketKeys('2026-12-30', '2027-01-02', 'day'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});

test('change percentage has no base when the previous value is zero', () => {
  assert.equal(changePct(120, 100), 20);
  assert.equal(changePct(5, 0), null);
});

test('ABC classes: A carries the first 80% of revenue', () => {
  const rows = abcClasses([{ revenue: 10 }, { revenue: 70 }, { revenue: 15 }, { revenue: 5 }]);
  assert.deepEqual(rows.map((r) => [r.revenue, r.class]), [[70, 'A'], [15, 'A'], [10, 'B'], [5, 'C']]);
});

test('forecast needs two weeks of days', () => {
  assert.equal(forecast(new Map(), ['2026-10-01']), null);
  const days = Array.from({ length: 14 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  const f = forecast(new Map(days.map((d) => [d, 1000])), days);
  assert.deepEqual(f, { dailyAverage: 1000, next30Days: 30000, trendPct: 0 });
});

test('reorder covers 30 days of sales plus the threshold', () => {
  assert.equal(suggestedReorder(4, 2, 5), 61);
  assert.equal(suggestedReorder(100, 1, 5), 0);
});

test('debt ageing buckets', () => {
  assert.deepEqual([0, 1, 30, 31, 60, 61].map(ageingBucket), ['notDue', 'd1_30', 'd1_30', 'd31_60', 'd31_60', 'd61_plus']);
});

test('backfill cost is the weighted average of purchases made before the sale', () => {
  const purchases = [
    { at: 100, qty: 10, amount: 1000 },
    { at: 200, qty: 10, amount: 2000 },
  ];
  assert.equal(averageCostAt(purchases, 50), null);
  assert.equal(averageCostAt(purchases, 150), 100);
  assert.equal(averageCostAt(purchases, 250), 150);
});
