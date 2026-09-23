-- Two business shapes the original four could not describe: a shop that sells
-- both retail and wholesale from one stock, and everything else.
--
-- Postgres cannot add an enum value inside a transaction that also uses it, so
-- these are separate statements. IF NOT EXISTS makes the migration re-runnable.
ALTER TYPE "OrganizationType" ADD VALUE IF NOT EXISTS 'RETAIL_WHOLESALE';
ALTER TYPE "OrganizationType" ADD VALUE IF NOT EXISTS 'OTHER';
