import { prisma } from '../db.js';

export async function logAuditAction(
  adminId: string,
  tenantId: string,
  action: string,
  details: Record<string, any> = {},
) {
  return prisma.tenantAuditLog.create({
    data: {
      adminId,
      tenantId,
      action,
      details,
    },
  });
}

