-- Security held against a credit sale (an ID card, a phone, a tool). Free text
-- because there is no useful enum for it, and separate from `notes` so it can be
-- looked up rather than buried in prose.
ALTER TABLE "sales" ADD COLUMN "credit_collateral" TEXT;

-- Matching a returning credit customer by phone is the whole point of the
-- lightweight capture, and it runs on every retail credit sale.
CREATE INDEX "customers_tenant_phone_idx" ON "customers" ("tenant_id", "phone");
