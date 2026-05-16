-- Add INTERNAL transaction type and project-linked audit metadata.

ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'INTERNAL';

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "project_id" TEXT,
  ADD COLUMN IF NOT EXISTS "notes" TEXT;

CREATE INDEX IF NOT EXISTS "transactions_tenant_id_project_id_idx"
  ON "transactions"("tenant_id", "project_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_project_id_fkey'
  ) THEN
    ALTER TABLE "transactions"
      ADD CONSTRAINT "transactions_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
