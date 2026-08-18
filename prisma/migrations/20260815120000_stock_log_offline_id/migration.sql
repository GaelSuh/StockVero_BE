-- Idempotency key for stock movements recorded on a device with no connection.
--
-- A restock queued offline is replayed when the signal returns. If the response
-- to an earlier attempt never arrived, the retry must not receive the same
-- delivery twice, so the device's own id is stored and checked.

-- AlterTable
ALTER TABLE "category_stock_logs" ADD COLUMN "offline_id" TEXT;

-- Only one movement per device-generated id. NULLs are unconstrained, so every
-- movement recorded while online (the vast majority) is unaffected.
CREATE UNIQUE INDEX "category_stock_logs_tenant_id_offline_id_key"
  ON "category_stock_logs"("tenant_id", "offline_id")
  WHERE "offline_id" IS NOT NULL;
