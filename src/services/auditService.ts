import { prisma } from '../db.js';
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

export async function logAudit(params: AuditParams): Promise<void> {
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
        details: params.details as any,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        notes: params.notes,
      },
    });
  } catch (err) {
    // Never throw — audit failure must never break business logic
    console.error('[AuditLog] Failed to write audit entry:', err);
  }
}

function resolveActorName(type: AuditActorType): string {
  if (type === AuditActorType.SYSTEM) return 'System (Automatic)';
  return 'Unknown';
}

/** Extract IP address and user agent from an Express request */
export function extractRequestContext(req: Request): { ipAddress?: string; userAgent?: string } {
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
export function buildDiff(
  before: Record<string, any>,
  after: Record<string, any>,
): Record<string, any> {
  const changed: { before: Record<string, any>; after: Record<string, any> } = {
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
export function resolveActorNameFromRecord(
  record: { firstName?: string; lastName?: string } | null | undefined,
): string | undefined {
  if (!record) return undefined;
  const parts = [record.firstName, record.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}
