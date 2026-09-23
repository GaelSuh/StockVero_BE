-- Per-product stock tracking mode, plus a tenant-level settings blob.
--
-- SERIALIZED keeps counting ProductItem rows (the Installation model, unchanged).
-- QUANTITY reads quantity_on_hand directly — the Retail/Wholesale model.

-- CreateEnum
CREATE TYPE "StockTrackingMode" AS ENUM ('SERIALIZED', 'QUANTITY');

-- AlterTable
ALTER TABLE "inventory_categories"
  ADD COLUMN "stock_tracking_mode" "StockTrackingMode" NOT NULL DEFAULT 'SERIALIZED',
  ADD COLUMN "quantity_on_hand" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "settings_config" JSONB;

-- Backfill: products that carry a planned quantity but have never had a single
-- serialised unit are exactly the ones created by the bulk-import path, which
-- wrote planned_qty and no product_items. The POS has been selling from that
-- number all along. Leaving them on SERIALIZED would count zero units and show
-- every one of them as out of stock the moment this ships — including on tills
-- that are actively selling the stock today.
--
-- Cost basis is deliberately NOT booked here: this stock was acquired before
-- this migration, and dating that expense to migration day would misstate the
-- ledger. Only stock added from now on records an expense.
UPDATE "inventory_categories" AS c
SET "stock_tracking_mode" = 'QUANTITY',
    "quantity_on_hand" = c."planned_qty"
WHERE c."planned_qty" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "product_items" AS pi WHERE pi."category_id" = c."id"
  );

-- Everything else keeps the SERIALIZED default and behaves exactly as before.
