-- An EXCHANGE records the replacement goods as a normal sale, so they deduct
-- stock and count as income like any other. This column is the link back from
-- the return to that sale. Nullable: every existing return is a plain refund.
ALTER TABLE "sale_returns" ADD COLUMN "exchange_sale_id" TEXT;
