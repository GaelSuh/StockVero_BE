import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../types/index.js';
import { supabase, STORAGE_BUCKET, deleteStorageFiles, extractStorageKey } from '../lib/storage.js';
import fs from 'fs';
import path from 'path';

const UploadSchema = z.object({
  context: z.enum(['inventory', 'customer', 'project', 'profile']),
});

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 4000}`;

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

    // Try Supabase first
    if (supabase) {
      const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(key, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

      if (!error) {
        const { data: { publicUrl } } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(key);
        return res.status(201).json({
          success: true,
          message: 'File uploaded successfully',
          data: { url: publicUrl, key },
        });
      }

      console.warn('[files] Supabase upload failed, falling back to local storage:', error.message);
    }

    // In production, Supabase is required — local disk is ephemeral on Railway
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        success: false,
        message: 'File storage is temporarily unavailable. Please try again.',
      });
    }

    // Local disk fallback (development only)
    const uploadDir = path.resolve('uploads', parsed.data.context);
    fs.mkdirSync(uploadDir, { recursive: true });
    const localPath = path.join(uploadDir, filename);
    fs.writeFileSync(localPath, req.file.buffer);
    const url = `${BASE_URL}/uploads/${parsed.data.context}/${filename}`;

    return res.status(201).json({
      success: true,
      message: 'File uploaded successfully',
      data: { url, key: `local/${parsed.data.context}/${filename}` },
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

    await deleteStorageFiles([url]);

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
