import { prisma } from '../db.js';

type Tx = any;

/** Digits only, so 6 77 12 34 56 and 677123456 are recognised as one person. */
export const normalizePhone = (raw: string): string => raw.replace(/\D/g, '');

/**
 * Finds or creates the lightweight customer behind a retail credit sale.
 *
 * A shop extending credit over the counter should not be sent to a customer
 * registration screen mid-sale — but the debt still has to be attached to
 * somebody, or it never appears in Credit Customers and the owner has no record
 * of who owes them. getCreditCustomers skips any sale without a customer row,
 * which is exactly what used to happen to these.
 *
 * Phone is the identity: it is the one thing a shopkeeper reliably asks for, and
 * it is what makes the second sale to the same person attach to the same record
 * instead of creating a duplicate.
 */
export async function findOrCreateCreditCustomer(
  tx: Tx,
  tenantId: string,
  input: { phone: string; name?: string | null },
): Promise<{ id: string; name: string; created: boolean }> {
  const digits = normalizePhone(input.phone);
  if (!digits) throw new Error('A phone number is required for a credit sale.');

  // Compared on digits so formatting differences do not create a second record
  // for the same person. Scoped to the tenant, and to a plausible page of rows
  // rather than the whole table.
  const candidates = await tx.customer.findMany({
    where: { tenantId, phone: { not: null } },
    select: { id: true, name: true, phone: true },
  });
  const existing = candidates.find(
    (c: any) => normalizePhone(c.phone ?? '') === digits,
  );
  if (existing) return { id: existing.id, name: existing.name, created: false };

  const created = await tx.customer.create({
    data: {
      tenantId,
      // The counter often has a first name and nothing else; the phone is the
      // fallback label so the record is still recognisable in a list.
      name: input.name?.trim() || `Credit customer ${input.phone.trim()}`,
      phone: input.phone.trim(),
      notes: 'Created automatically from a retail credit sale.',
    },
    select: { id: true, name: true },
  });
  return { ...created, created: true };
}
