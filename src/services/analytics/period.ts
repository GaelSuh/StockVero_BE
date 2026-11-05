import { addDays, doualaToday } from '../tenantMetrics.service.js';

/**
 * Filters shared by every analytics endpoint, parsed once from the query string.
 *
 * Days are Africa/Douala calendar days, like the nightly metrics. Douala is UTC+1
 * all year (no DST), so a fixed offset is exact.
 */

const DOUALA_OFFSET_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366 * 3;
/** Up to two months a chart shows days; beyond that, months. */
const DAILY_LIMIT_DAYS = 62;

export type Channel = 'RETAIL' | 'WHOLESALE';
export type Granularity = 'day' | 'month';

export interface Period {
  from: string;
  to: string;
  start: Date;
  end: Date;
  days: number;
}

export interface AnalyticsFilters extends Period {
  granularity: Granularity;
  /** Every bucket key in range, in order, so charts have no gaps. */
  buckets: string[];
  previous: Period;
  compare: boolean;
  advanced: boolean;
  channel: Channel | null;
  /** ProductCategory id. */
  categoryId: string | null;
}

export class FilterError extends Error {}

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const truthy = (v: unknown) => v === 'true' || v === '1';

export const dayStart = (day: string) => new Date(`${day}T00:00:00.000+01:00`);
export const dayEnd = (day: string) => new Date(`${day}T23:59:59.999+01:00`);

/** Douala calendar day of an instant. */
export const doualaDay = (at: Date | string | number) => new Date(new Date(at).getTime() + DOUALA_OFFSET_MS).toISOString().slice(0, 10);

/** Douala weekday (0 = Sunday) and hour of an instant. */
export const doualaDayHour = (at: Date | string | number) => {
  const local = new Date(new Date(at).getTime() + DOUALA_OFFSET_MS);
  return { dow: local.getUTCDay(), hour: local.getUTCHours() };
};

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;

export const period = (from: string, to: string): Period => ({
  from,
  to,
  start: dayStart(from),
  end: dayEnd(to),
  days: daysBetween(from, to),
});

export const bucketOf = (at: Date | string | number, granularity: Granularity) => {
  const day = doualaDay(at);
  return granularity === 'day' ? day : day.slice(0, 7);
};

export function bucketKeys(from: string, to: string, granularity: Granularity): string[] {
  const keys: string[] = [];
  if (granularity === 'day') {
    for (let d = from; d <= to; d = addDays(d, 1)) keys.push(d);
    return keys;
  }
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const last = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    keys.push(key);
    if (key >= last) return keys;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
}

/** Defaults to the last 30 days ending today. Throws FilterError on bad input. */
export function parseFilters(query: Record<string, unknown>, today: string = doualaToday()): AnalyticsFilters {
  const to = query.to === undefined ? today : query.to;
  if (!isDay(to)) throw new FilterError('"to" must be a date (YYYY-MM-DD)');
  const from = query.from === undefined ? addDays(to, -29) : query.from;
  if (!isDay(from)) throw new FilterError('"from" must be a date (YYYY-MM-DD)');
  if (from > to) throw new FilterError('"from" must be on or before "to"');

  const current = period(from, to);
  if (current.days > MAX_RANGE_DAYS) throw new FilterError('The date range can be at most 3 years');

  const channelRaw = String(query.channel ?? '').toUpperCase();
  const channel = channelRaw === 'RETAIL' || channelRaw === 'WHOLESALE' ? channelRaw : null;
  const granularity: Granularity = current.days <= DAILY_LIMIT_DAYS ? 'day' : 'month';

  return {
    ...current,
    granularity,
    buckets: bucketKeys(from, to, granularity),
    previous: period(addDays(from, -current.days), addDays(from, -1)),
    compare: truthy(query.compare),
    advanced: truthy(query.advanced),
    channel,
    categoryId: typeof query.categoryId === 'string' && query.categoryId ? query.categoryId : null,
  };
}

/** Percentage change, or null when there is no base to compare against. */
export const changePct = (current: number, previous: number): number | null =>
  previous === 0 ? null : Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;

export const round2 = (n: number) => Math.round(n * 100) / 100;
