import { AuditActorType, AuditStatus } from '@prisma/client';
import { Request } from 'express';
export { AuditActorType, AuditStatus };
export interface AuditParams {
    tenantId: string;
    actorType: AuditActorType;
    actorId?: string;
    actorName?: string;
    action: string;
    module: string;
    status?: AuditStatus;
    entityType?: string;
    entityId?: string;
    entityLabel?: string;
    details?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
    notes?: string;
}
export declare function logAudit(params: AuditParams): Promise<void>;
/** Extract IP address and user agent from an Express request */
export declare function extractRequestContext(req: Request): {
    ipAddress?: string;
    userAgent?: string;
};
/**
 * Build a diff object for update operations — only includes fields that changed.
 * Automatically strips sensitive fields (passwordHash, password).
 */
export declare function buildDiff(before: Record<string, any>, after: Record<string, any>): Record<string, any>;
/** Resolve actor name from a user or employee object */
export declare function resolveActorNameFromRecord(record: {
    firstName?: string;
    lastName?: string;
} | null | undefined): string | undefined;
