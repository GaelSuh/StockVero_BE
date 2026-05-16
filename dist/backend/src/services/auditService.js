import { prisma } from '../db.js';
import { AuditActorType, AuditStatus } from '@prisma/client';
export { AuditActorType, AuditStatus };
export async function logAudit(params) {
    try {
        await prisma.auditLog.create({
            data: {
                tenantId: params.tenantId,
                actorType: params.actorType,
                actorId: params.actorId,
                actorName: params.actorName ?? resolveActorName(params.actorType),
                action: params.action,
                module: params.module,
                status: params.status ?? AuditStatus.SUCCESS,
                entityType: params.entityType,
                entityId: params.entityId,
                entityLabel: params.entityLabel,
                details: params.details,
                ipAddress: params.ipAddress,
                userAgent: params.userAgent,
                notes: params.notes,
            },
        });
    }
    catch (err) {
        // Never throw — audit failure must never break business logic
        console.error('[AuditLog] Failed to write audit entry:', err);
    }
}
function resolveActorName(type) {
    if (type === AuditActorType.SYSTEM)
        return 'System (Automatic)';
    return 'Unknown';
}
/** Extract IP address and user agent from an Express request */
export function extractRequestContext(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : (req.socket?.remoteAddress ?? req.ip);
    return {
        ipAddress: ip,
        userAgent: req.headers['user-agent'],
    };
}
/**
 * Build a diff object for update operations — only includes fields that changed.
 * Automatically strips sensitive fields (passwordHash, password).
 */
export function buildDiff(before, after) {
    const changed = {
        before: {},
        after: {},
    };
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of allKeys) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
            changed.before[key] = before[key];
            changed.after[key] = after[key];
        }
    }
    // Strip sensitive fields
    const sensitive = ['passwordHash', 'password', 'otpHash'];
    for (const field of sensitive) {
        delete changed.before[field];
        delete changed.after[field];
    }
    return changed;
}
/** Resolve actor name from a user or employee object */
export function resolveActorNameFromRecord(record) {
    if (!record)
        return undefined;
    const parts = [record.firstName, record.lastName].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : undefined;
}
