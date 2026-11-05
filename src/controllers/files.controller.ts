import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../types/index.js';
import { supabase, STORAGE_BUCKET, deleteStorageFiles, extractStorageKey } from '../lib/storage.js';
import { auditRequest } from '../services/auditService.js';

// Upload context -> audit module key.
const AUDIT_MODULE: Record<string, string> = { inventory: 'inventory', customer: 'contacts', project: 'projects', profile: 'settings' };

const UploadSchema = z.object({
  context: z.enum(['inventory', 'customer', 'project', 'profile']),
});

export const uploadFile = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided' });
    }

    const parsed = UploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const maxSize = 10 * 1024 * 1024;
    if (req.file.size > maxSize) {
      return res.status(400).json({ success: false, message: 'File size exceeds 10MB limit' });
    }

    const ext = getFileExtension(req.file.originalname);
    const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`;
    const key = `${req.tenantId}/${parsed.data.context}/${filename}`;

    // Try Supabase upload
    if (!supabase) {
      return res.status(503).json({
        success: false,
        message: 'File storage is not configured. Please contact support.',
      });
    }

    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(key, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

    if (error) {
      console.error('[files] Supabase upload failed:', error.message);
      return res.status(503).json({
        success: false,
        message: 'File storage is temporarily unavailable. Please try again.',
      });
    }

    const { data: { publicUrl } } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(key);
    auditRequest(req, {
      action: 'FILE_UPLOADED',
      module: AUDIT_MODULE[parsed.data.context] ?? 'settings',
      entityType: 'File',
      entityId: key,
      entityLabel: req.file.originalname,
      details: { context: parsed.data.context, size: req.file.size, mimeType: req.file.mimetype },
    });
    return res.status(201).json({
      success: true,
      message: 'File uploaded successfully',
      data: { url: publicUrl, key },
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to upload file',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

function getFileExtension(filename: string): string {
  const match = filename.match(/\.[^.]*$/);
  return match ? match[0] : '';
}

export const deleteFile = async (req: AuthRequest, res: Response) => {
  try {
    const { url } = req.body as { url?: string };
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, message: 'url is required' });
    }

    const key = extractStorageKey(url);
    if (!key) {
      // Not a Supabase URL — might be local, just acknowledge
      return res.status(200).json({ success: true, message: 'File removed' });
    }

    // Keys are `${tenantId}/${context}/${filename}`: only this tenant's own files may be deleted.
    const [owner, context, filename] = key.split('/');
    if (owner !== req.tenantId) {
      return res.status(403).json({ success: false, message: 'You can only delete your own files' });
    }

    await deleteStorageFiles([url]);
    auditRequest(req, {
      action: 'FILE_DELETED',
      module: AUDIT_MODULE[context] ?? 'settings',
      entityType: 'File',
      entityId: key,
      entityLabel: filename ?? key,
      details: { context },
    });

    return res.status(200).json({ success: true, message: 'File deleted successfully' });
  } catch (error) {
    console.error('Error deleting file:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete file',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
