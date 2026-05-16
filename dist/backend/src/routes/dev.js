import { Router } from 'express';
import { runProjectDueDateCheck } from '../jobs/projectDueDateJob.js';
const router = Router();
router.post('/trigger-due-date-check', async (req, res) => {
    try {
        await runProjectDueDateCheck();
        res.json({ success: true, message: 'Due date check completed. Check server logs.' });
    }
    catch (err) {
        res.status(500).json({ success: false, message: 'Job failed', error: String(err) });
    }
});
export default router;
