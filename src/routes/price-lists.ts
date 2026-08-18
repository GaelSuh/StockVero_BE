import { Router } from 'express';
import { tenantGuard, moduleGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import {
  createPriceList,
  listPriceLists,
  getPriceList,
  updatePriceList,
  deletePriceList,
  assignCustomerToPriceList,
  removeCustomerFromPriceList,
} from '../controllers/price-lists.controller.js';

const router = Router();

router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('wholesale_sales'));

router.get('/', permissionGuard('wholesale_sales', 'canRead'), listPriceLists);
router.post('/', permissionGuard('wholesale_sales', 'canCreate'), createPriceList);
router.get('/:id', permissionGuard('wholesale_sales', 'canRead'), getPriceList);
router.patch('/:id', permissionGuard('wholesale_sales', 'canUpdate'), updatePriceList);
router.delete('/:id', permissionGuard('wholesale_sales', 'canDelete'), deletePriceList);
router.post('/:id/customers', permissionGuard('wholesale_sales', 'canUpdate'), assignCustomerToPriceList);
router.delete('/:id/customers/:customerId', permissionGuard('wholesale_sales', 'canUpdate'), removeCustomerFromPriceList);

export default router;
