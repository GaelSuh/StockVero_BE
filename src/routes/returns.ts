import { Router } from 'express';
import { tenantGuard, mustChangePasswordGuard } from '../middleware/auth.js';
import { createReturn, listReturns, getReturn } from '../controllers/returns.controller.js';
import { AuthRequest } from '../types/index.js';
import { Response, NextFunction } from 'express';

const router = Router();

router.use(tenantGuard, mustChangePasswordGuard);

function salesPermissionGuard(action: 'canCreate' | 'canRead') {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const activeModules = req.activeModules ?? [];
    const permissions = req.permissions ?? {};
    const isOwner = req.user?.accountType === 'owner';

    const hasRetail = isOwner
      ? activeModules.includes('retail_sales')
      : permissions['retail_sales']?.[action];
    const hasWholesale = isOwner
      ? activeModules.includes('wholesale_sales')
      : permissions['wholesale_sales']?.[action];

    if (hasRetail || hasWholesale) return next();
    return res.status(403).json({ success: false, message: 'Insufficient permissions' });
  };
}

router.post('/', salesPermissionGuard('canCreate'), createReturn);
router.get('/', salesPermissionGuard('canRead'), listReturns);
router.get('/:id', salesPermissionGuard('canRead'), getReturn);

export default router;
