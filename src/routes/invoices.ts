import { Router } from 'express';
import { tenantGuard, moduleGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import {
  listInvoices,
  getInvoiceSummary,
  getInvoiceById,
  approveInvoice,
  rejectInvoice,
  createClientInvoiceHandler,
  sendClientInvoice,
  getInvoicePdfData,
  approveProjectInstalment,
  deleteInvoice,
} from '../controllers/invoice.controller.js';

const router = Router();
router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('finance'));

// List and summary
router.get('/', permissionGuard('finance', 'canRead'), listInvoices);
router.get('/summary', permissionGuard('finance', 'canRead'), getInvoiceSummary);

// Create client invoice (PM generates invoice from project)
router.post('/client', permissionGuard('finance', 'canCreate'), createClientInvoiceHandler);

// Single invoice
router.get('/:id', permissionGuard('finance', 'canRead'), getInvoiceById);
router.get('/:id/pdf', permissionGuard('finance', 'canRead'), getInvoicePdfData);

// Approve / reject (finance manager)
router.patch('/:id/approve', permissionGuard('finance', 'canUpdate'), approveInvoice);
router.patch('/:id/reject', permissionGuard('finance', 'canUpdate'), rejectInvoice);
router.patch('/:id/approve-instalment', permissionGuard('finance', 'canUpdate'), approveProjectInstalment);

// Send client invoice (DRAFT → PENDING)
router.patch('/:id/send', permissionGuard('finance', 'canUpdate'), sendClientInvoice);

// Delete invoice (PENDING / DRAFT / REJECTED only)
router.delete('/:id', permissionGuard('finance', 'canDelete'), deleteInvoice);

export default router;
