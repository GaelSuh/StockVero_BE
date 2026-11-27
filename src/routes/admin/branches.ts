import { Router } from 'express';
import { adminGuard } from '../../middleware/adminAuth.js';
import { approveBranch, getBranch, listBranches, rejectBranch } from '../../controllers/admin.branches.controller.js';

/** Companies' branches: list, detail (stock and activity, no money), approve, reject. */
const router = Router();

router.get('/branches', adminGuard, listBranches);
router.get('/branches/:id', adminGuard, getBranch);
router.post('/branches/:id/approve', adminGuard, approveBranch);
router.post('/branches/:id/reject', adminGuard, rejectBranch);

export default router;
