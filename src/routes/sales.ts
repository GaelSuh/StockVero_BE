import { Router } from 'express';
import { tenantGuard, moduleGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import {
  createSale,
  listSales,
  getSale,
  updateSale,
  addPaymentToSale,
  getDailySalesSummary,
  getCreditCustomersController,
  resolvePricesController,
  cloneSaleController,
} from '../controllers/sales.controller.js';

const router = Router();

router.use(tenantGuard, mustChangePasswordGuard);

// Retail sales routes (guarded by retail_sales module)
const retailRouter = Router();
retailRouter.use(moduleGuard('retail_sales'));
retailRouter.get('/retail', permissionGuard('retail_sales', 'canRead'), listSales);
retailRouter.get('/retail/:id', permissionGuard('retail_sales', 'canRead'), getSale);
retailRouter.post('/retail', permissionGuard('retail_sales', 'canCreate'), createSale);
retailRouter.patch('/retail/:id', permissionGuard('retail_sales', 'canUpdate'), updateSale);
retailRouter.post('/retail/:id/payments', permissionGuard('retail_sales', 'canUpdate'), addPaymentToSale);
retailRouter.post('/retail/:id/clone', permissionGuard('retail_sales', 'canRead'), cloneSaleController);
retailRouter.get('/retail/summary/daily', permissionGuard('retail_sales', 'canRead'), getDailySalesSummary);
retailRouter.get('/retail/credit/customers', permissionGuard('retail_sales', 'canRead'), getCreditCustomersController);

// Wholesale sales routes (guarded by wholesale_sales module)
const wholesaleRouter = Router();
wholesaleRouter.use(moduleGuard('wholesale_sales'));
wholesaleRouter.get('/wholesale', permissionGuard('wholesale_sales', 'canRead'), listSales);
wholesaleRouter.get('/wholesale/:id', permissionGuard('wholesale_sales', 'canRead'), getSale);
wholesaleRouter.post('/wholesale', permissionGuard('wholesale_sales', 'canCreate'), createSale);
wholesaleRouter.patch('/wholesale/:id', permissionGuard('wholesale_sales', 'canUpdate'), updateSale);
wholesaleRouter.post('/wholesale/:id/payments', permissionGuard('wholesale_sales', 'canUpdate'), addPaymentToSale);
wholesaleRouter.post('/wholesale/:id/clone', permissionGuard('wholesale_sales', 'canRead'), cloneSaleController);
wholesaleRouter.post('/wholesale/resolve-prices', permissionGuard('wholesale_sales', 'canRead'), resolvePricesController);
wholesaleRouter.get('/wholesale/summary/daily', permissionGuard('wholesale_sales', 'canRead'), getDailySalesSummary);
wholesaleRouter.get('/wholesale/credit/customers', permissionGuard('wholesale_sales', 'canRead'), getCreditCustomersController);

router.use(retailRouter);
router.use(wholesaleRouter);

export default router;
