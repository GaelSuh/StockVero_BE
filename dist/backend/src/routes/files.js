import { Router } from 'express';
import { tenantGuard, mustChangePasswordGuard } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { uploadFile, deleteFile } from '../controllers/files.controller.js';
const router = Router();
router.use(tenantGuard, mustChangePasswordGuard);
/**
 * @openapi
 * /api/v1/files/upload:
 *   post:
 *     summary: Upload a file to storage
 *     tags: [Files]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, context]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               context:
 *                 type: string
 *                 enum: [inventory, customer, project, profile]
 *     responses:
 *       201:
 *         description: File uploaded
 */
router.post('/upload', upload.single('file'), uploadFile);
router.delete('/delete', deleteFile);
export default router;
