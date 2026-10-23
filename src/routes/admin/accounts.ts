import { Router } from 'express';
import { adminGuard } from '../../middleware/adminAuth.js';
import {
  addNote, bulkSetAccountOwner, createFollowUp, deleteFollowUp, deleteNote, listDueFollowUps, listNotes,
  listTenantFollowUps, setAccountOwner, updateFollowUp,
} from '../../controllers/admin.accounts.controller.js';

/**
 * Account management: account owner, notes log, follow-ups. All changes are audit-logged.
 * TODO(admin-roles): restrict account-owner assignment (single and bulk) to the owner role.
 * @openapi tags: [Admin Accounts]
 */
const router = Router();

router.post('/tenants/account-owner/bulk', adminGuard, bulkSetAccountOwner);
router.patch('/tenants/:id/account-owner', adminGuard, setAccountOwner);

router.get('/tenants/:id/notes', adminGuard, listNotes);
router.post('/tenants/:id/notes', adminGuard, addNote);
router.delete('/tenants/:id/notes/:noteId', adminGuard, deleteNote);

router.get('/tenants/:id/follow-ups', adminGuard, listTenantFollowUps);
router.post('/tenants/:id/follow-ups', adminGuard, createFollowUp);
router.get('/follow-ups/due', adminGuard, listDueFollowUps);
router.patch('/follow-ups/:id', adminGuard, updateFollowUp);
router.delete('/follow-ups/:id', adminGuard, deleteFollowUp);

export default router;
