import { Router, Response, NextFunction } from 'express';
import { tenantGuard, mustChangePasswordGuard } from '../middleware/auth.js';
import { AuthRequest } from '../types/index.js';
import {
  listMyBranches, listBranches, getBranch, createBranch, updateBranch,
  listBranchMembers, grantBranchAccess, revokeBranchAccess,
} from '../controllers/branches.controller.js';

const router = Router();
router.use(tenantGuard, mustChangePasswordGuard);

/** Opening, closing and staffing branches is the business owner's call. */
function ownerOnly(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.accountType === 'owner') return next();
  return res.status(403).json({ code: 'PERMISSION_DENIED', message: 'Only the business owner can manage branches.' });
}

/**
 * @openapi
 * /api/v1/branches:
 *   get:
 *     summary: Branches the current user can switch to, and the active one
 *     tags: [Branches]
 */
router.get('/', listMyBranches);

/**
 * @openapi
 * /api/v1/branches/manage:
 *   get:
 *     summary: All branches with staff counts (owner)
 *     tags: [Branches]
 */
router.get('/manage', ownerOnly, listBranches);
router.post('/', ownerOnly, createBranch);
router.get('/:id', ownerOnly, getBranch);
router.patch('/:id', ownerOnly, updateBranch);
router.get('/:id/members', ownerOnly, listBranchMembers);
router.put('/:id/access', ownerOnly, grantBranchAccess);
router.delete('/:id/access/:employeeId', ownerOnly, revokeBranchAccess);

export default router;
