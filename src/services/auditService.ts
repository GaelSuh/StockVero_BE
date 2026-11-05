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
      actorName = (await resolveActorNameFromDb(params.actorType, params.actorId)) ?? undefined;
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

type RequestLike = Request & {
  tenantId?: string;
  user?: { id?: string; accountType?: string };
};

/**
 * logAudit for a request made by a signed-in owner or employee: tenant, actor,
 * IP and device come from the request, so a call site only says what happened.
 *
 * Work queued on a device while offline arrives later with an `offlineId` and
 * the device time it happened (`recordedAt`); both are kept in `details`, so
 * the log shows when it really happened and when it reached the server.
 */
export function auditRequest(
  req: RequestLike,
  entry: Omit<AuditParams, 'tenantId' | 'actorType' | 'actorId' | 'ipAddress' | 'userAgent'> & { tenantId?: string },
): void {
  const tenantId = entry.tenantId ?? req.tenantId;
  if (!tenantId) return;
  const body = (req.body ?? {}) as { offlineId?: unknown; recordedAt?: unknown };
  const recordedAt = typeof body.recordedAt === 'number' || typeof body.recordedAt === 'string' ? new Date(body.recordedAt) : null;
  const offline = typeof body.offlineId === 'string' && body.offlineId
    ? {
        offline: true,
        offlineId: body.offlineId,
        ...(recordedAt && !Number.isNaN(recordedAt.getTime()) ? { recordedOfflineAt: recordedAt.toISOString() } : {}),
        syncedAt: new Date().toISOString(),
      }
    : {};
  const accountType = req.user?.accountType;
  // Anyone who is neither the owner nor an employee (e.g. a platform admin acting
  // on a tenant) is not one of the tenant's people, so is not labelled as one.
  const actorType =
    accountType === 'owner' ? AuditActorType.OWNER
    : accountType === 'employee' ? AuditActorType.EMPLOYEE
    : AuditActorType.SYSTEM;
  void logAudit({
    ...entry,
    tenantId,
    actorType,
    actorId: req.user?.id,
    ...(actorType === AuditActorType.SYSTEM && !entry.actorName ? { actorName: 'Platform administrator' } : {}),
    details: { ...(entry.details ?? {}), ...offline },
    ...extractRequestContext(req),
  });
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
  const allKeys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of allKeys) {
    if (isTechnicalField(key)) continue;
    const b = auditValue(before?.[key]);
    const a = auditValue(after?.[key]);
    // A related record that was only loaded on one side is not a change.
    if (b === undefined || a === undefined) {
      if (isRelation(before?.[key]) || isRelation(after?.[key])) continue;
    }
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      changed.before[key] = b ?? null;
      changed.after[key] = a ?? null;
    }
  }
  return changed;
}

/**
 * Fields a person reading the audit log has no use for: identifiers, tenant,
 * bookkeeping timestamps, counters and secrets. The record itself is already
 * named by entityLabel.
 */
const TECHNICAL_FIELDS = new Set([
  'id', 'tenantId', 'createdAt', 'updatedAt', 'deletedAt', '_count', 'normalizedName',
  'passwordHash', 'password', 'otpHash', 'pinHash', 'offlineId', 'syncedAt',
]);
const isTechnicalField = (key: string) => TECHNICAL_FIELDS.has(key) || /Id$|Ids$/.test(key);

const isRelation = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !isDecimal(v);
const isDecimal = (v: any) => v && typeof v === 'object' && typeof v.toNumber === 'function';

/** Plain value for the log: decimals as numbers, related records by name. */
function auditValue(v: any): any {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (isDecimal(v)) return v.toNumber();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(auditValue);
  if (typeof v === 'object') {
    const label = v.name ?? v.label ?? v.title ?? [v.firstName, v.lastName].filter(Boolean).join(' ');
    return label || undefined;
  }
  return v;
}

/** Resolve actor name from a user or employee object */
export function resolveActorNameFromRecord(
  record: { firstName?: string; lastName?: string } | null | undefined,
): string | undefined {
  if (!record) return undefined;
  const parts = [record.firstName, record.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}
