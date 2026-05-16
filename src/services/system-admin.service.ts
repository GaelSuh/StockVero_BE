import bcrypt from 'bcrypt';
import { prisma } from '../db.js';

let cachedSystemAdminId: string | null = null;
const SYSTEM_ADMIN_EMAIL = 'system@stockvero.local';

export async function getSystemAdminId() {
  if (cachedSystemAdminId) return cachedSystemAdminId;

  const existing = await prisma.superAdmin.findUnique({
    where: { email: SYSTEM_ADMIN_EMAIL },
    select: { id: true },
  });

  if (existing) {
    cachedSystemAdminId = existing.id;
    return existing.id;
  }

  const passwordHash = await bcrypt.hash(Math.random().toString(36).slice(2), 10);
  const created = await prisma.superAdmin.create({
    data: {
      email: SYSTEM_ADMIN_EMAIL,
      passwordHash,
      firstName: 'System',
      lastName: 'Billing',
    },
    select: { id: true },
  });

  cachedSystemAdminId = created.id;
  return created.id;
}
