import { Router, Response } from 'express';
import { tenantGuard, moduleGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import { AuthRequest } from '../types/index.js';
import { checkInvoiceDependencies } from '../services/dependencyCheckService.js';
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

// Can-delete check
router.get('/:id/can-delete', permissionGuard('finance', 'canDelete'), async (req: AuthRequest, res: Response) => {
  try {
    const report = await checkInvoiceDependencies(req.params.id, req.tenantId!);
    return res.json({ success: true, data: report });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Dependency check failed' });
  }
});

// Delete invoice
router.delete('/:id', permissionGuard('finance', 'canDelete'), async (req: AuthRequest, res: Response) => {
  const report = await checkInvoiceDependencies(req.params.id, req.tenantId!);
  if (!report.canDelete) {
    return res.status(409).json({ success: false, message: 'Cannot delete: unresolved dependencies', data: report });
  }
  return deleteInvoice(req, res);
});

// Approve / reject (finance manager)
router.patch('/:id/approve', permissionGuard('finance', 'canUpdate'), approveInvoice);
router.patch('/:id/reject', permissionGuard('finance', 'canUpdate'), rejectInvoice);
router.patch('/:id/approve-instalment', permissionGuard('finance', 'canUpdate'), approveProjectInstalment);

// Send client invoice (DRAFT → PENDING)
router.patch('/:id/send', permissionGuard('finance', 'canUpdate'), sendClientInvoice);

export default router;
