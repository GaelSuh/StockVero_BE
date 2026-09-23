import { prisma } from '../db.js';

export async function generateSystemId(
  categoryAbbreviation: string,
  tenantId: string,
): Promise<string> {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
  const prefix = `${categoryAbbreviation.toUpperCase()}-${datePart}`;

  // The highest existing sequence for this tenant+prefix, not a row count —
  // count+1 meant a deleted unit's sequence number got reused by the next
  // insert, which could collide with a systemId still referenced elsewhere
  // (a soft-deleted row, or a historical sale/log record). systemId sorts
  // lexicographically the same as numerically here because the prefix is a
  // fixed length per call and the sequence is zero-padded to a constant
  // width, so ORDER BY systemId DESC LIMIT 1 finds the true max.
  const last = await prisma.productItem.findFirst({
    where: { tenantId, systemId: { startsWith: `${prefix}-` } },
    orderBy: { systemId: 'desc' },
    select: { systemId: true },
  });

  let nextSequence = 1;
  if (last?.systemId) {
    const suffix = last.systemId.slice(prefix.length + 1);
    const parsed = parseInt(suffix, 10);
    if (Number.isFinite(parsed)) nextSequence = parsed + 1;
  }

  const sequence = String(nextSequence).padStart(4, '0');
  // Uniqueness is now enforced by the DB as UNIQUE(tenant_id, system_id) —
  // not globally, matching what this ID was always meant to be: a per-tenant
  // document number. Two tenants independently generating "PH-20260911-0001"
  // is fine now and no longer collides.
  //
  // NOTE: this read-then-write is not itself race-proof — two concurrent
  // "add unit" requests for the same tenant+category+day could still compute
  // the same next sequence before either commits. That race pre-dates this
  // fix (the old count-based version had it too) and is not what this pass
  // was asked to close. If it needs closing, the right place is a
  // retry-on-unique-violation wrapper around whatever inserts the
  // ProductItem row (in saleInventoryService.ts / wherever units get added),
  // not this function.
  return `${prefix}-${sequence}`;
}
