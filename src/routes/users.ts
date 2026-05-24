import { Router } from 'express';
import { tenantGuard, mustChangePasswordGuard } from '../middleware/auth.js';
import {
  getMyProfile,
  updateMyProfile,
  updateMyPassword,
  getMyPreferences,
  updateMyPreferences,
} from '../controllers/users.controller.js';

const router = Router();

// All personal-settings routes require only a valid tenant session.
// No role/permission check — every user can manage their own data.
router.use(tenantGuard);

router.get('/me/profile', mustChangePasswordGuard, getMyProfile);
router.patch('/me/profile', mustChangePasswordGuard, updateMyProfile);
// Password change is allowed even when mustChangePassword=true (that's the point)
router.patch('/me/password', updateMyPassword);
router.get('/me/preferences', mustChangePasswordGuard, getMyPreferences);
router.patch('/me/preferences', mustChangePasswordGuard, updateMyPreferences);

export default router;
