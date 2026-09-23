import { Router } from 'express';
import { tenantGuard, moduleGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import {
  createDeliveryNote,
  listDeliveryNotes,
  getDeliveryNote,
  updateDeliveryNoteStatus,
} from '../controllers/delivery.controller.js';

const router = Router();

router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('wholesale_sales'));

router.get('/', permissionGuard('wholesale_sales', 'canRead'), listDeliveryNotes);
router.post('/', permissionGuard('wholesale_sales', 'canCreate'), createDeliveryNote);
router.get('/:id', permissionGuard('wholesale_sales', 'canRead'), getDeliveryNote);
router.patch('/:id/status', permissionGuard('wholesale_sales', 'canUpdate'), updateDeliveryNoteStatus);

export default router;
