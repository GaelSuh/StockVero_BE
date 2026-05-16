-- Add project invoice instalments, tenant running balances, and project budget tracking.

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "invoice_payment_id" TEXT;

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "total_approved" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "remaining_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "is_fully_paid" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "available_budget" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "spent_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "remaining_budget" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "invoice_approved" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "invoice_payments" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "transaction_id" TEXT NOT NULL,
  "approved_by" TEXT NOT NULL,
  "percentage_approved" DECIMAL(5,2) NOT NULL,
  "amount_approved" DECIMAL(15,2) NOT NULL,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "tenant_finance_balance" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "total_income" DECIMAL(15,2) NOT NULL DEFAULT 0,
  "total_expense" DECIMAL(15,2) NOT NULL DEFAULT 0,
  "net_balance" DECIMAL(15,2) NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_finance_balance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "invoice_payments_transaction_id_key"
  ON "invoice_payments"("transaction_id");
CREATE INDEX IF NOT EXISTS "invoice_payments_tenant_id_invoice_id_idx"
  ON "invoice_payments"("tenant_id", "invoice_id");
CREATE INDEX IF NOT EXISTS "invoice_payments_transaction_id_idx"
  ON "invoice_payments"("transaction_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_finance_balance_tenant_id_key"
  ON "tenant_finance_balance"("tenant_id");
CREATE INDEX IF NOT EXISTS "transactions_invoice_payment_id_idx"
  ON "transactions"("invoice_payment_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payments_tenant_id_fkey'
  ) THEN
    ALTER TABLE "invoice_payments"
      ADD CONSTRAINT "invoice_payments_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payments_invoice_id_fkey'
  ) THEN
    ALTER TABLE "invoice_payments"
      ADD CONSTRAINT "invoice_payments_invoice_id_fkey"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payments_transaction_id_fkey'
  ) THEN
    ALTER TABLE "invoice_payments"
      ADD CONSTRAINT "invoice_payments_transaction_id_fkey"
      FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_finance_balance_tenant_id_fkey'
  ) THEN
    ALTER TABLE "tenant_finance_balance"
      ADD CONSTRAINT "tenant_finance_balance_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
