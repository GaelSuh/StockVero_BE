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
    // If actorName was not provided but we have an actorId, look it up so the
    // audit log never shows "Unknown" for a real person.
    let actorName = params.actorName;
    if (!actorName && params.actorId) {
      actorName = await resolveActorNameFromDb(params.actorType, params.actorId);
    }
    if (!actorName) {
      actorName = resolveActorNameFallback(params.actorType);
    }

    await prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        actorType: params.actorType,
        actorId: params.actorId,
        actorName,
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

async function resolveActorNameFromDb(type: AuditActorType, actorId: string): Promise<string | null> {
  try {
    if (type === AuditActorType.OWNER) {
      const user = await prisma.user.findUnique({
        where: { id: actorId },
        select: { firstName: true, lastName: true },
      });
      if (user) return `${user.firstName} ${user.lastName}`;
    } else if (type === AuditActorType.EMPLOYEE) {
      const emp = await prisma.employee.findUnique({
        where: { id: actorId },
        select: { firstName: true, lastName: true },
      });
      if (emp) return `${emp.firstName} ${emp.lastName}`;
    }
  } catch {
    // Non-critical — fall through to fallback
  }
  return null;
}

function resolveActorNameFallback(type: AuditActorType): string {
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
