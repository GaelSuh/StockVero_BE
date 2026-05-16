import { Router, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { tenantGuard } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { logAudit, extractRequestContext, AuditActorType } from '../services/auditService.js';
import { supabase, STORAGE_BUCKET } from '../lib/storage.js';

const router = Router();
router.use(tenantGuard);

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 4000}`;

const upload = multer({ storage: multer.memoryStorage() });

const VALID_MODULES = ['PROJECT', 'INVENTORY', 'FINANCE', 'CUSTOMER', 'PRODUCT_ITEM'] as const;
type DocModule = typeof VALID_MODULES[number];

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/** Verify that the source record belongs to this tenant */
async function verifySourceRecord(
  tenantId: string,
  sourceModule: DocModule,
  sourceId: string,
): Promise<{ found: boolean; denied?: boolean }> {
  try {
    let record: { tenantId: string } | null = null;
    if (sourceModule === 'PROJECT') {
      record = await prisma.project.findUnique({ where: { id: sourceId }, select: { tenantId: true } });
    } else if (sourceModule === 'INVENTORY') {
      record = await (prisma as any).inventoryCategory.findUnique({ where: { id: sourceId }, select: { tenantId: true } });
    } else if (sourceModule === 'PRODUCT_ITEM') {
      record = await (prisma as any).productItem.findUnique({ where: { id: sourceId }, select: { tenantId: true } });
    } else if (sourceModule === 'FINANCE') {
      record = await prisma.transaction.findUnique({ where: { id: sourceId }, select: { tenantId: true } });
    } else if (sourceModule === 'CUSTOMER') {
      record = await prisma.customer.findUnique({ where: { id: sourceId }, select: { tenantId: true } });
    }
    if (!record) return { found: false };
    if (record.tenantId !== tenantId) return { found: true, denied: true };
    return { found: true };
  } catch (err) {
    console.error('[documents] verifySourceRecord error:', err);
    return { found: false };
  }
}

// POST /api/v1/documents/upload
router.post('/upload', upload.single('file'), async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenantId!;
  const { sourceModule, sourceId, docType, description } = req.body as Record<string, string>;

  if (!VALID_MODULES.includes(sourceModule as DocModule)) {
    return res.status(422).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid source module.' });
  }
  if (!req.file) {
    return res.status(422).json({ success: false, message: 'No file provided.' });
  }
  if (req.file.size > MAX_FILE_SIZE) {
    return res.status(422).json({ success: false, message: 'File size must not exceed 10MB.' });
  }
  if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
    return res.status(422).json({ success: false, message: 'File type not supported. Allowed: PDF, JPG, PNG, WEBP, DOC, DOCX.' });
  }

  const source = await verifySourceRecord(tenantId, sourceModule as DocModule, sourceId);
  if (!source.found) {
    return res.status(404).json({ success: false, message: 'Source record not found.' });
  }
  if (source.denied) {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }

  const cleanName = req.file.originalname.replace(/\s+/g, '_');
  const storagePath = `${tenantId}/${sourceModule.toLowerCase()}s/${sourceId}/${Date.now()}_${cleanName}`;

  let publicUrl = '';
  let finalStoragePath = storagePath;

  // Try Supabase first
  if (supabase) {
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype });

    if (!uploadError) {
      const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
      publicUrl = urlData?.publicUrl ?? '';
    } else {
      console.warn('[documents] Supabase upload failed, falling back to local storage:', uploadError.message);
    }
  }

  // In production, Supabase is required — local disk is ephemeral on Railway
  if (!publicUrl && process.env.NODE_ENV === 'production') {
    return res.status(503).json({ success: false, message: 'File storage is temporarily unavailable. Please try again.' });
  }

  // Local disk fallback (development only)
  if (!publicUrl) {
    try {
      const uploadDir = path.resolve('uploads', 'documents', sourceModule.toLowerCase(), sourceId);
      fs.mkdirSync(uploadDir, { recursive: true });
      const localFilename = `${Date.now()}_${cleanName}`;
      const localPath = path.join(uploadDir, localFilename);
      fs.writeFileSync(localPath, req.file.buffer);
      publicUrl = `${BASE_URL}/uploads/documents/${sourceModule.toLowerCase()}/${sourceId}/${localFilename}`;
      finalStoragePath = `local/documents/${sourceModule.toLowerCase()}/${sourceId}/${localFilename}`;
    } catch (localErr) {
      console.error('[documents] Local fallback also failed:', localErr);
      return res.status(500).json({ success: false, message: 'File upload failed. Please try again.' });
    }
  }

  const doc = await prisma.document.create({
    data: {
      tenantId,
      sourceModule: sourceModule as any,
      sourceId,
      name: req.file.originalname,
      docType: docType?.trim() || null,
      description: description?.trim() || null,
      url: publicUrl,
      storagePath: finalStoragePath,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      uploadedBy: req.user!.id,
    },
  });

  void logAudit({
    tenantId,
    actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
    actorId: req.user?.id,
    action: 'DOCUMENT_UPLOADED',
    module: sourceModule,
    entityType: 'Document',
    entityId: doc.id,
    entityLabel: doc.name,
    details: { sourceModule, sourceId, fileSize: doc.fileSize, mimeType: doc.mimeType },
    ...extractRequestContext(req),
  });

  return res.status(201).json({ success: true, message: 'Document uploaded successfully.', data: doc });
});

// GET /api/v1/documents?sourceModule=&sourceId=
router.get('/', async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenantId!;
  const { sourceModule, sourceId } = req.query as Record<string, string>;

  if (!sourceModule || !sourceId) {
    return res.status(422).json({ success: false, message: 'sourceModule and sourceId are required.' });
  }
  if (!VALID_MODULES.includes(sourceModule as DocModule)) {
    return res.status(422).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid source module.' });
  }

  const source = await verifySourceRecord(tenantId, sourceModule as DocModule, sourceId);
  if (!source.found) {
    return res.status(404).json({ success: false, message: 'Source record not found.' });
  }
  if (source.denied) {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }

  const docs = await prisma.document.findMany({
    where: { tenantId, sourceModule: sourceModule as any, sourceId },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({ success: true, data: docs });
});

// GET /api/v1/documents/:id/signed-url
router.get('/:id/signed-url', async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenantId!;

  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ success: false, message: 'Document not found.' });
  if (doc.tenantId !== tenantId) return res.status(403).json({ success: false, message: 'Access denied.' });

  // Local files — just return the stored URL directly
  if (doc.storagePath.startsWith('local/')) {
    return res.json({ success: true, data: { url: doc.url } });
  }

  if (!supabase) return res.status(500).json({ success: false, message: 'Storage not configured.' });

  // 1-hour signed URL — long enough to open/download in the browser
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(doc.storagePath, 60 * 60, {
      download: false, // let browser decide (inline for PDF/images, download for Office)
    });

  if (error || !data?.signedUrl) {
    console.error('Signed URL error:', error);
    return res.status(500).json({ success: false, message: 'Could not generate a view URL. Please try again.' });
  }

  return res.json({ success: true, data: { url: data.signedUrl } });
});

// PATCH /api/v1/documents/:id
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenantId!;
  const { docType, description } = req.body as { docType?: string; description?: string };

  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ success: false, message: 'Document not found.' });
  if (doc.tenantId !== tenantId) return res.status(403).json({ success: false, message: 'Access denied.' });

  const updated = await prisma.document.update({
    where: { id: doc.id },
    data: {
      docType: docType !== undefined ? (docType.trim() || null) : undefined,
      description: description !== undefined ? (description.trim() || null) : undefined,
    },
  });

  return res.json({ success: true, data: updated });
});

// DELETE /api/v1/documents/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenantId!;

  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ success: false, message: 'Document not found.' });
  if (doc.tenantId !== tenantId) return res.status(403).json({ success: false, message: 'Access denied.' });

  if (doc.storagePath.startsWith('local/')) {
    // Local file — remove from disk
    const relativePath = doc.storagePath.replace(/^local\//, '');
    const fullPath = path.resolve('uploads', relativePath);
    try { fs.unlinkSync(fullPath); } catch { /* file may already be gone */ }
  } else if (supabase) {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([doc.storagePath]);
    if (error) console.error('Storage delete error (continuing):', error);
  }

  await prisma.document.delete({ where: { id: doc.id } });

  void logAudit({
    tenantId,
    actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
    actorId: req.user?.id,
    action: 'DOCUMENT_DELETED',
    module: doc.sourceModule,
    entityType: 'Document',
    entityId: doc.id,
    entityLabel: doc.name,
    details: { sourceModule: doc.sourceModule, sourceId: doc.sourceId },
    ...extractRequestContext(req),
  });

  return res.json({ success: true });
});

export default router;
