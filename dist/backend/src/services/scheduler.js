import cron from 'node-cron';
import { runProjectDueDateCheck } from '../jobs/projectDueDateJob.js';
export function startCronJobs() {
    // Run every day at 05:00 server time
    cron.schedule('0 5 * * *', async () => {
        console.log(`[CRON] ${new Date().toISOString()} — Running project due date check...`);
        try {
            await runProjectDueDateCheck();
        }
        catch (err) {
            console.error('[CRON] Project due date job failed catastrophically:', err);
        }
    });
    console.log('[CRON] Scheduled: runProjectDueDateCheck (daily at 05:00)');
}
