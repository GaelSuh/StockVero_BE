import { prisma } from '../db.js';
export async function logAuditAction(adminId, tenantId, action, details = {}) {
    return prisma.tenantAuditLog.create({
        data: {
            adminId,
            tenantId,
            action,
            details,
        },
    });
}
