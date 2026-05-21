import { z } from 'zod';
import { supabase, STORAGE_BUCKET, deleteStorageFiles, extractStorageKey } from '../lib/storage.js';
const UploadSchema = z.object({
    context: z.enum(['inventory', 'customer', 'project', 'profile']),
});
export const uploadFile = async (req, res) => {
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
        return res.status(201).json({
            success: true,
            message: 'File uploaded successfully',
            data: { url: publicUrl, key },
        });
    }
    catch (error) {
        console.error('Error uploading file:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to upload file',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
function getFileExtension(filename) {
    const match = filename.match(/\.[^.]*$/);
    return match ? match[0] : '';
}
export const deleteFile = async (req, res) => {
    try {
        const { url } = req.body;
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
    }
    catch (error) {
        console.error('Error deleting file:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete file',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
