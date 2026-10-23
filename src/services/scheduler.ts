import cron from 'node-cron';
import { runProjectDueDateCheck } from '../jobs/projectDueDateJob.js';
import { runNightlyMetrics, latestCompleteDay, METRICS_TZ } from './tenantMetrics.service.js';
import { storeDailyScores } from './insights/index.js';

export function startCronJobs(): void {
  // Run every day at 05:00 server time
  cron.schedule('0 5 * * *', async () => {
    console.log(`[CRON] ${new Date().toISOString()} — Running project due date check...`);
    try {
      await runProjectDueDateCheck();
    } catch (err) {
      console.error('[CRON] Project due date job failed catastrophically:', err);
    }
  });

  // Daily tenant metrics for the Douala day that just ended. In-process because the API runs
  // as a single long-lived Railway instance (no host scheduler is configured); writes are
  // idempotent and a day that already succeeded is skipped, so an overlapping instance during
  // a deploy is harmless. Host-cron alternative: `npm run metrics:snapshot -- --nightly`.
  cron.schedule('30 0 * * *', async () => {
    try {
      await runNightlyMetrics();
      // Stage 2: score history for the same day (idempotent; runs even if stage 1 was skipped as already done).
      await storeDailyScores(latestCompleteDay());
    } catch (err) {
      console.error('[CRON] Tenant metrics job failed catastrophically:', err);
    }
  }, { timezone: METRICS_TZ });

  console.log('[CRON] Scheduled: runProjectDueDateCheck (daily at 05:00)');
  console.log(`[CRON] Scheduled: runNightlyMetrics (daily at 00:30 ${METRICS_TZ})`);
}
