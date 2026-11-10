import { Prisma } from '@prisma/client';
import { prismaUnscoped as db } from '../db.js';
import { ApiError } from '../lib/errors.js';

/**
 * Customers across branches. Each branch keeps its own customer records (its
 * own balance, debt and history); the same person buying in two branches has
 * a record in each. This finds a person already known elsewhere in the
 * company, and adds them to the active branch from that record — copying who
 * they are, never what they owe or bought.
 *
 * Phones are stored as typed ("+237 692 52 15 65", "692521565"). Two numbers
 * are the same person when their last 9 digits match (a full Cameroonian
 * number), so the country code may be present on one and not the other.
 */

const SAME_PHONE_DIGITS = 9;

export const phoneKey = (raw?: string | null): string => {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.slice(-SAME_PHONE_DIGITS);
};

type Match = { id: string; name: string; phone: string | null; email: string | null; branchId: string };

export interface CustomerLookup {
  /** Already a customer of the active branch. */
  here: Array<Omit<Match, 'branchId'>>;
  /** Known in other branches only: name and contact, nothing else. */
  elsewhere: Array<Omit<Match, 'branchId'> & { branch: { id: string; name: string; code: string } }>;
}

async function findMatches(tenantId: string, phone?: string, email?: string): Promise<Match[]> {
  const key = phoneKey(phone);
  const mail = email?.trim().toLowerCase();
  // Too few digits to tell people apart: phone is not used to match.
  const usePhone = key.length >= 7;
  if (!usePhone && !mail) return [];
  return db.$queryRaw<Match[]>(Prisma.sql`
    SELECT id, name, phone, email, branch_id AS "branchId"
    FROM customers
    WHERE tenant_id = ${tenantId}
      AND (
        ${usePhone ? Prisma.sql`right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), ${SAME_PHONE_DIGITS}) = ${key}` : Prisma.sql`false`}
        OR ${mail ? Prisma.sql`lower(email) = ${mail}` : Prisma.sql`false`}
      )
    ORDER BY created_at ASC
    LIMIT 20`);
}

export async function lookupCustomer(
  tenantId: string,
  activeBranchId: string,
  query: { phone?: string; email?: string },
): Promise<CustomerLookup> {
  const matches = await findMatches(tenantId, query.phone, query.email);
  const here = matches.filter((m) => m.branchId === activeBranchId);
  const others = matches.filter((m) => m.branchId !== activeBranchId);
  const branches = others.length
    ? await db.branch.findMany({
        where: { id: { in: [...new Set(others.map((m) => m.branchId))] } },
        select: { id: true, name: true, code: true },
      })
    : [];
  const byId = new Map(branches.map((b) => [b.id, b]));
  const strip = ({ branchId: _b, ...m }: Match) => m;
  return {
    here: here.map(strip),
    // One entry per branch is enough to recognise the person.
    elsewhere: others
      .filter((m, i, all) => all.findIndex((x) => x.branchId === m.branchId) === i)
      .map((m) => ({ ...strip(m), branch: byId.get(m.branchId)! })),
  };
}

/**
 * Adds a customer known in another branch to the active branch. If they are
 * already a customer here (same phone or email), that record is returned
 * instead of making a second one.
 */
export async function addCustomerToBranch(
  tenantId: string,
  sourceCustomerId: string,
  branchId: string,
): Promise<{ customer: { id: string; name: string }; alreadyHere: boolean }> {
  const source = await db.customer.findFirst({
    where: { id: sourceCustomerId, tenantId },
    select: { id: true, name: true, email: true, phone: true, location: true, address: true, avatarUrl: true, branchId: true },
  });
  if (!source) throw new ApiError(404, 'Customer not found.', 'CUSTOMER_NOT_FOUND');
  if (source.branchId === branchId) return { customer: { id: source.id, name: source.name }, alreadyHere: true };

  const existing = (await findMatches(tenantId, source.phone ?? undefined, source.email ?? undefined)).find(
    (m) => m.branchId === branchId,
  );
  if (existing) return { customer: { id: existing.id, name: existing.name }, alreadyHere: true };

  const created = await db.customer.create({
    data: {
      tenantId,
      branchId,
      name: source.name,
      email: source.email,
      phone: source.phone,
      location: source.location,
      address: source.address,
      avatarUrl: source.avatarUrl,
    },
    select: { id: true, name: true },
  });
  return { customer: created, alreadyHere: false };
}
