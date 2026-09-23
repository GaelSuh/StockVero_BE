import { prisma } from '../db.js';

/**
 * Resolves the display name of whoever performed an action, from the database
 * rather than from the request or the token.
 *
 * Sales were storing whatever the client sent (or a token field that is not
 * always populated), which produced empty "Sold by" values that cannot be
 * recovered later. Looking the person up is the only reliable source.
 */
export async function resolvePersonName(
  id: string,
  type: 'OWNER' | 'EMPLOYEE',
): Promise<string> {
  try {
    if (type === 'OWNER') {
      const user = await (prisma as any).user.findUnique({
        where: { id },
        select: { firstName: true, lastName: true, email: true },
      });
      if (user) {
        const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
        return full || user.email || 'Owner';
      }
      return 'Owner';
    }

    const employee = await (prisma as any).employee.findUnique({
      where: { id },
      select: { firstName: true, lastName: true, email: true },
    });
    if (employee) {
      const full = [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim();
      return full || employee.email || 'Employee';
    }
    return 'Employee';
  } catch {
    return type === 'OWNER' ? 'Owner' : 'Employee';
  }
}

/**
 * Fills in a name that was never recorded, for rows written before the name was
 * resolved properly. Returns the stored value untouched when it has one.
 */
export async function backfillPersonName(
  stored: string | null | undefined,
  id: string,
  type: 'OWNER' | 'EMPLOYEE',
): Promise<string> {
  if (stored && stored.trim()) return stored;
  return resolvePersonName(id, type);
}
