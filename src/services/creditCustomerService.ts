import { prisma } from '../db.js';

type Tx = any;

/** Digits only, so 6 77 12 34 56 and 677123456 are recognised as one person. */
export const normalizePhone = (raw: string): string => raw.replace(/\D/g, '');

/** Name comparison form: trimmed, spaces collapsed, accents folded, lowercased. */
export const normalizePersonName = (raw?: string | null): string =>
  (raw ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Customers the till can match a credit phone against, so it can ask "is this
 * the same person?" before the sale is recorded, even with no connection.
 */
export async function listCreditContacts(tenantId: string) {
  const rows = await prisma.customer.findMany({
    where: { tenantId, phone: { not: null } },
    select: { id: true, name: true, phone: true },
  });
  return rows
    .map((c) => ({ id: c.id, name: c.name, phoneDigits: normalizePhone(c.phone ?? '') }))
    .filter((c) => c.phoneDigits);
}

/**
 * Finds or creates the lightweight customer behind a retail credit sale.
 *
 * A shop extending credit over the counter should not be sent to a customer
 * registration screen mid-sale — but the debt still has to be attached to
 * somebody, or it never appears in Credit Customers and the owner has no record
 * of who owes them. getCreditCustomers skips any sale without a customer row,
 * which is exactly what used to happen to these.
 *
 * Phone finds the returning customer, but it is not the whole identity: phones
 * are shared within families and between friends, so a sale is only attached to
 * an existing customer when the name agrees too (or no name was typed). A
 * different name never re-links the sale to someone else; it creates a new
 * customer with the same phone, noted so the owner can merge them if they turn
 * out to be one person.
 *
 * `decision: 'new'` is the cashier's answer at the till ("this is someone
 * else"): always a new customer, no matching.
 */
export async function findOrCreateCreditCustomer(
  tx: Tx,
  tenantId: string,
  input: { phone: string; name?: string | null; decision?: 'new' | null },
): Promise<{ id: string; name: string; created: boolean }> {
  const digits = normalizePhone(input.phone);
  if (!digits) throw new Error('A phone number is required for a credit sale.');
  const typedName = normalizePersonName(input.name);

  let sharedWith: string | null = null;
  if (input.decision !== 'new') {
    // Compared on digits so formatting differences do not create a second record
    // for the same person.
    const candidates = await tx.customer.findMany({
      where: { tenantId, phone: { not: null } },
      select: { id: true, name: true, phone: true },
    });
    const samePhone = candidates.filter((c: any) => normalizePhone(c.phone ?? '') === digits);
    const match = samePhone.find((c: any) => !typedName || normalizePersonName(c.name) === typedName);
    if (match) return { id: match.id, name: match.name, created: false };
    sharedWith = samePhone[0]?.name ?? null;
  }

  const created = await tx.customer.create({
    data: {
      tenantId,
      // The counter often has a first name and nothing else; the phone is the
      // fallback label so the record is still recognisable in a list.
      name: input.name?.trim() || `Credit customer ${input.phone.trim()}`,
      phone: input.phone.trim(),
      notes: sharedWith
        ? `Created automatically from a retail credit sale. Same phone as ${sharedWith}; merge them if this is the same person.`
        : 'Created automatically from a retail credit sale.',
    },
    select: { id: true, name: true },
  });
  return { ...created, created: true };
}
