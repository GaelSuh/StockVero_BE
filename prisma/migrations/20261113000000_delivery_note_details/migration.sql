-- Delivery details collected on the delivery note form, which had nowhere to go:
-- the address, the planned delivery date and the driver's phone. Additive only;
-- existing notes keep NULL.
ALTER TABLE "delivery_notes" ADD COLUMN IF NOT EXISTS "delivery_address" TEXT;
ALTER TABLE "delivery_notes" ADD COLUMN IF NOT EXISTS "delivery_date" TIMESTAMP(3);
ALTER TABLE "delivery_notes" ADD COLUMN IF NOT EXISTS "driver_phone" TEXT;
