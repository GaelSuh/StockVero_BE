/**
 * Tenant daily metrics from the command line.
 *
 *   npm run metrics:snapshot -- --nightly [--force]          yesterday (+ trailing flow window), catalogue captured, then scores
 *   npm run metrics:snapshot -- --scores [--day YYYY-MM-DD]  score history only (default: latest complete day)
 *   npm run metrics:snapshot -- --backfill [--tenant <id>]   full history, flow metrics only
 *   npm run metrics:snapshot -- --from 2026-09-01 --to 2026-09-30 [--tenant <id>]   flow metrics for a range
 *
 * Every mode is idempotent and safe to re-run. Catalogue (point-in-time) metrics are only
 * ever captured by --nightly, for the day that just ended.
 */
import 'dotenv/config';
import { prisma } from '../db.js';
import { isDay, latestCompleteDay, runBackfill, runMetrics, runNightlyMetrics } from '../services/tenantMetrics.service.js';
import { storeDailyScores } from '../services/insights/index.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const tenantId = value('tenant');
  if (flag('nightly')) {
    const snap = await runNightlyMetrics(new Date(), { force: flag('force') });
    const scores = await storeDailyScores(latestCompleteDay(), 'cli');
    return snap ? { ...snap, scores } : { status: scores.status, scores };
  }
  if (flag('scores')) {
    const day = value('day') ?? latestCompleteDay();
    if (!isDay(day)) throw new Error('--day must be YYYY-MM-DD');
    return storeDailyScores(day, 'cli');
  }
  if (flag('backfill')) return runBackfill('cli', tenantId);

  const from = value('from');
  const to = value('to') ?? latestCompleteDay();
  if (!isDay(from) || !isDay(to) || from > to) {
    throw new Error('Usage: --nightly | --backfill | --from YYYY-MM-DD [--to YYYY-MM-DD] [--tenant <id>]');
  }
  return runMetrics({ kind: 'REBUILD', from, to, tenantId, triggeredBy: 'cli' });
}

main()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result && result.status !== 'SUCCESS' ? 1 : 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
