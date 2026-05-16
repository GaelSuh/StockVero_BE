import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { verifyToken } from '../lib/jwt.js';
import { tenantGuard } from '../middleware/auth.js';
import { addConnection } from '../services/sseManager.js';
const router = Router();
const NotificationPreferencesSchema = z.object({
    cadence: z.enum(['realtime', 'daily', 'weekly']),
    categories: z.object({
        crm: z.boolean(),
        inventory: z.boolean(),
        finance: z.boolean(),
        projects: z.boolean(),
        billing: z.boolean(),
        admin: z.boolean(),
        system: z.boolean(),
        analytics: z.boolean(),
    }),
});
/**
 * GET /notifications/stream
 */
router.get('/stream', async (req, res) => {
    try {
        const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
        if (!token)
            return res.status(401).json({ error: 'Missing authorization token' });
        let decoded;
        try {
            decoded = verifyToken(token);
        }
        catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (!decoded.tenantId || !decoded.userId)
            return res.status(401).json({ error: 'Invalid token' });
        if (decoded.accountType === 'owner') {
            const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
            if (!user || user.tenantId !== decoded.tenantId || !user.isActive)
                return res.status(401).json({ error: 'Invalid token' });
        }
        else if (decoded.accountType === 'employee') {
            const employee = await prisma.employee.findUnique({ where: { id: decoded.userId } });
            if (!employee || employee.tenantId !== decoded.tenantId || !employee.isActive)
                return res.status(401).json({ error: 'Invalid token' });
        }
        addConnection(decoded.userId, decoded.tenantId, req, res);
    }
    catch (error) {
        if (!res.headersSent)
            res.status(500).json({ error: 'Failed to establish connection' });
    }
});
router.use(tenantGuard);
/**
 * GET /notifications
 */
router.get('/', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = 20;
        const skip = (page - 1) * limit;
        const isReadParam = req.query.isRead;
        const where = { tenantId: req.tenantId, userId: req.user.id };
        if (isReadParam === 'true')
            where.isRead = true;
        if (isReadParam === 'false')
            where.isRead = false;
        const [notifications, total] = await Promise.all([
            prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
            prisma.notification.count({ where }),
        ]);
        // Wrapped in data to play nice with frontend unwrap utility
        return res.json({
            success: true,
            data: {
                notifications,
                pagination: {
                    page,
                    limit,
                    total,
                    pages: Math.ceil(total / limit)
                },
            }
        });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to retrieve notifications' });
    }
});
/**
 * DELETE /notifications/bulk
 */
router.delete('/bulk', async (req, res) => {
    try {
        if (req.user?.accountType !== 'owner') {
            return res.status(403).json({ success: false, message: 'Only owners can bulk delete' });
        }
        const ids = req.body.ids;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid IDs' });
        }
        await prisma.notification.deleteMany({
            where: {
                id: { in: ids },
                tenantId: req.tenantId,
                userId: req.user.id
            }
        });
        return res.json({ success: true, message: 'Notifications deleted', data: null });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to delete notifications' });
    }
});
/**
 * DELETE /notifications/all
 */
router.delete('/all', async (req, res) => {
    try {
        if (req.user?.accountType !== 'owner') {
            return res.status(403).json({ success: false, message: 'Only owners can clear notifications' });
        }
        await prisma.notification.deleteMany({
            where: {
                tenantId: req.tenantId
            }
        });
        return res.json({ success: true, message: 'All notifications cleared', data: null });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to clear notifications' });
    }
});
/**
 * GET /notifications/unread-count
 */
router.get('/unread-count', async (req, res) => {
    try {
        const count = await prisma.notification.count({
            where: { tenantId: req.tenantId, userId: req.user.id, isRead: false },
        });
        return res.json({ success: true, data: { count } });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to get count' });
    }
});
/**
 * PATCH /notifications/:id/read
 */
router.patch('/:id/read', async (req, res) => {
    try {
        const n = await prisma.notification.update({
            where: { id: req.params.id, tenantId: req.tenantId, userId: req.user.id },
            data: { isRead: true },
        });
        return res.json({ success: true, message: 'Marked as read', data: n });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to update' });
    }
});
/**
 * PATCH /notifications/read-all
 */
router.patch('/read-all', async (req, res) => {
    try {
        const result = await prisma.notification.updateMany({
            where: { tenantId: req.tenantId, userId: req.user.id, isRead: false },
            data: { isRead: true },
        });
        return res.json({ success: true, message: 'All marked as read', data: { updated: result.count } });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to update all' });
    }
});
/**
 * GET /notifications/preferences
 */
router.get('/preferences', async (req, res) => {
    try {
        let preferences;
        if (req.user?.accountType === 'owner') {
            const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { notificationPreferences: true } });
            preferences = user?.notificationPreferences;
        }
        else {
            const employee = await prisma.employee.findUnique({ where: { id: req.user.id }, select: { notificationPreferences: true } });
            preferences = employee?.notificationPreferences;
        }
        return res.json({
            success: true,
            data: preferences || {
                cadence: 'realtime',
                categories: {
                    crm: true,
                    inventory: true,
                    finance: true,
                    projects: true,
                    billing: true,
                    admin: true,
                    system: true,
                    analytics: true,
                },
            },
        });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to get preferences' });
    }
});
/**
 * PATCH /notifications/preferences
 */
router.patch('/preferences', async (req, res) => {
    try {
        const parsed = NotificationPreferencesSchema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message });
        if (req.user?.accountType === 'owner') {
            await prisma.user.update({ where: { id: req.user.id }, data: { notificationPreferences: parsed.data } });
        }
        else {
            await prisma.employee.update({ where: { id: req.user.id }, data: { notificationPreferences: parsed.data } });
        }
        return res.json({ success: true, message: 'Preferences updated', data: parsed.data });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to update preferences' });
    }
});
export default router;
