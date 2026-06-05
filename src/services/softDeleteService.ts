import { prisma, prismaBase } from '../db.js';
import { logAudit, AuditActorType } from './auditService.js';

export async function softDelete({
  model,
  id,
  tenantId,
  actorId,
  actorType,
  action,
  entityType,
  entityLabel,
  module,
  details,
}: {
  model: string;
  id: string;
  tenantId: string;
  actorId?: string;
  actorType: AuditActorType;
  action: string;
  entityType: string;
  entityLabel: string;
  module: string;
  details?: Record<string, any>;
}): Promise<void> {
  const modelClient = (prisma as any)[model];
  if (!modelClient) throw new Error(`Unknown model: ${model}`);

  await modelClient.update({
    where: { id },
    data: { isDeleted: true, deletedAt: new Date() },
  });

  void logAudit({
    tenantId,
    actorType,
    actorId,
    action,
    module,
    entityType,
    entityId: id,
    entityLabel,
    details: { softDeleted: true, deletedAt: new Date(), ...details },
  });
}

/**
 * After a findUnique/findFirst returns null, call this to determine whether
 * the record was soft-deleted vs genuinely missing.
 * Returns true if the record exists but is soft-deleted.
 */
export async function isSoftDeleted(model: string, id: string): Promise<boolean> {
  // Use prismaBase to bypass the soft-delete extension — we need to find
  // records where isDeleted IS true, which the extension would suppress.
  const modelClient = (prismaBase as any)[model];
  if (!modelClient) return false;
  const deleted = await modelClient.findFirst({ where: { id, isDeleted: true } });
  return Boolean(deleted);
}
