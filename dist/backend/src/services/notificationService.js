import { prisma } from '../db.js';
import { pushToUser } from './sseManager.js';
const DEFAULT_PREFS = {
    cadence: 'realtime',
    categories: {
        crm: true, inventory: true, finance: true, projects: true,
        billing: true, admin: true, system: true, analytics: true,
    },
};
/** Maps broadcast moduleKey values to their matching preferences category key */
const MODULE_KEY_MAP = {
    administration: 'admin',
    contacts: 'crm',
    settings: 'system',
};
/** Derive the module key from a dot-separated notification type, e.g. 'project.assigned' → 'projects' */
function moduleFromType(type) {
    const prefix = type.split('.')[0].toLowerCase();
    // normalise singular/alias → preference category key
    if (prefix === 'project')
        return 'projects';
    if (prefix === 'administration')
        return 'admin';
    if (prefix === 'customer')
        return 'crm';
    if (prefix === 'contacts')
        return 'crm';
    if (prefix === 'employee')
        return 'admin';
    if (prefix === 'settings')
        return 'system';
    return prefix;
}
/** Fetch the persisted notification preferences for a user or return defaults. */
async function getUserPrefs(userId, userType) {
    try {
        let raw;
        if (userType === 'OWNER') {
            const u = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPreferences: true } });
            raw = u?.notificationPreferences;
        }
        else {
            const e = await prisma.employee.findUnique({ where: { id: userId }, select: { notificationPreferences: true } });
            raw = e?.notificationPreferences;
        }
        if (!raw || typeof raw !== 'object')
            return DEFAULT_PREFS;
        return { ...DEFAULT_PREFS, ...raw };
    }
    catch {
        return DEFAULT_PREFS;
    }
}
export async function sendNotification(params) {
    try {
        // Resolve the module key for category checking (normalise aliases like 'administration' → 'admin')
        const rawKey = params.moduleKey ?? moduleFromType(params.type);
        const moduleKey = MODULE_KEY_MAP[rawKey] ?? rawKey;
        // Fetch user preferences and gate on category toggle
        const prefs = await getUserPrefs(params.userId, params.userType);
        const categoryEnabled = prefs.categories[moduleKey] !== false; // default-allow unknown keys
        if (!categoryEnabled)
            return null; // user has turned off this category
        const notification = await prisma.notification.create({
            data: {
                tenantId: params.tenantId,
                userId: params.userId,
                userType: params.userType,
                type: params.type,
                title: params.title,
                message: params.message,
                link: params.link ?? null,
            },
        });
        // Only push SSE immediately for 'realtime' cadence.
        // For 'daily' / 'weekly' the notification is saved to DB and the user
        // will see it in the notification centre on their own schedule.
        if (prefs.cadence === 'realtime') {
            pushToUser(params.userId, {
                id: notification.id,
                tenantId: notification.tenantId,
                userId: notification.userId,
                userType: notification.userType,
                type: notification.type,
                title: notification.title,
                message: notification.message,
                isRead: notification.isRead,
                link: notification.link,
                createdAt: notification.createdAt.toISOString(),
            });
        }
        return notification;
    }
    catch (error) {
        console.error('[notificationService] Error sending notification:', error);
        return null;
    }
}
export async function broadcastToTenant(tenantId, params) {
    try {
        const owners = await prisma.user.findMany({ where: { tenantId }, select: { id: true } });
        const employees = await prisma.employee.findMany({ where: { tenantId }, select: { id: true } });
        const sendPromises = [
            ...owners.map(o => sendNotification({ ...params, tenantId, userId: o.id, userType: 'OWNER' })),
            ...employees.map(e => sendNotification({ ...params, tenantId, userId: e.id, userType: 'EMPLOYEE' }))
        ];
        await Promise.all(sendPromises);
    }
    catch (error) {
        console.error('[notificationService] Error broadcasting to tenant:', error);
    }
}
/**
 * Sends a notification to all users in a tenant who have at least 'read' access to a specific module.
 * Each recipient's category toggle and cadence preference are respected.
 * Owners always receive the notification (subject to their own preferences).
 */
export async function broadcastToModule(tenantId, moduleKey, params) {
    try {
        // Normalise the module key so it matches preference category keys (e.g. 'administration' → 'admin')
        const prefKey = MODULE_KEY_MAP[moduleKey] ?? moduleKey;
        // 1. Owners always get it (preferences checked inside sendNotification)
        const owners = await prisma.user.findMany({ where: { tenantId }, select: { id: true } });
        // 2. Employees with read permission on the module
        const rolesWithPermission = await prisma.role.findMany({
            where: {
                tenantId,
                permissions: { some: { moduleKey, canRead: true } }
            },
            select: { id: true }
        });
        const roleIds = rolesWithPermission.map(r => r.id);
        const employees = await prisma.employee.findMany({
            where: { tenantId, roleId: { in: roleIds }, isActive: true },
            select: { id: true }
        });
        const sendPromises = [
            ...owners.map(o => sendNotification({ ...params, moduleKey: prefKey, tenantId, userId: o.id, userType: 'OWNER' })),
            ...employees.map(e => sendNotification({ ...params, moduleKey: prefKey, tenantId, userId: e.id, userType: 'EMPLOYEE' }))
        ];
        await Promise.all(sendPromises);
    }
    catch (error) {
        console.error(`[notificationService] Error broadcasting to module ${moduleKey}:`, error);
    }
}
