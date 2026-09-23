-- Which sales channels a product may be sold through.
--
-- Independent booleans, not an exclusive type: the same stock is often sold both
-- ways (rice by the bag at retail, by the pallet wholesale). Existing products
-- default to available on both channels, which preserves today's behaviour where
-- every product shows up everywhere.
ALTER TABLE "inventory_categories"
  ADD COLUMN "retail_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "wholesale_enabled" BOOLEAN NOT NULL DEFAULT true;

-- Reading the pickers by channel is the hot path once filtering is on.
CREATE INDEX "inventory_categories_tenant_retail_idx"
  ON "inventory_categories" ("tenant_id", "retail_enabled");
CREATE INDEX "inventory_categories_tenant_wholesale_idx"
  ON "inventory_categories" ("tenant_id", "wholesale_enabled");
