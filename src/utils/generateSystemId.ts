import { prisma } from '../db.js';

export async function generateSystemId(
  categoryAbbreviation: string,
  tenantId: string,
): Promise<string> {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
  const prefix = `${categoryAbbreviation.toUpperCase()}-${datePart}`;

  // Count existing items with this prefix for this tenant to get next sequence
  const count = await (prisma as any).productItem.count({
    where: {
      tenantId,
      systemId: { startsWith: prefix },
    },
  });

  const sequence = String(count + 1).padStart(4, '0');
  return `${prefix}-${sequence}`;
}
