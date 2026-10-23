-- Campay payment gateway.
--
-- RECONSTRUCTED. The original file was applied to production on 2026-07-21
-- from a branch whose source is no longer available, so it never reached this
-- repository. Production's _prisma_migrations records it as applied; without a
-- matching folder here, `migrate status` reports the histories as diverged and
-- the Prisma schema cannot describe what production actually contains.
--
-- This SQL was rebuilt from production's live catalog (information_schema,
-- pg_enum, pg_indexes) and reproduces exactly what that migration left behind.
-- Its checksum will NOT match the one production recorded; that is expected.
--
-- Written to be idempotent, because it must also run on databases that never
-- had the original (dev, fresh environments) without failing on production-like
-- ones that already do.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PaymentProvider" AS ENUM ('NONE', 'CAMPAY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterEnum
ALTER TYPE "PaymentTransactionType" ADD VALUE IF NOT EXISTS 'SIGNUP_CHARGE';

-- AlterEnum: the older sale flow marked sold units SOLD. Production holds rows
-- with this value, so it must exist wherever that data may land.
ALTER TYPE "StockItemStatus" ADD VALUE IF NOT EXISTS 'SOLD';

-- AlterTable: signup charges are taken before any subscription exists.
ALTER TABLE "payment_transactions" ALTER COLUMN "subscription_id" DROP NOT NULL;

ALTER TABLE "payment_transactions"
  ADD COLUMN IF NOT EXISTS "provider" "PaymentProvider" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "provider_reference" TEXT,
  ADD COLUMN IF NOT EXISTS "external_reference" TEXT,
  ADD COLUMN IF NOT EXISTS "provider_status" TEXT,
  ADD COLUMN IF NOT EXISTS "payer_phone" TEXT,
  ADD COLUMN IF NOT EXISTS "operator" TEXT,
  ADD COLUMN IF NOT EXISTS "operator_reference" TEXT,
  ADD COLUMN IF NOT EXISTS "ussd_code" TEXT,
  ADD COLUMN IF NOT EXISTS "provider_payload" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_provider_reference_key" ON "payment_transactions"("provider_reference");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_transactions_external_reference_idx" ON "payment_transactions"("external_reference");
