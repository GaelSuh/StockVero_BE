-- Faulty / damaged stock for quantity-tracked products and variants, and the
-- condition of each returned line. Additive: existing rows default to 0 / GOOD.
ALTER TABLE "inventory_categories" ADD COLUMN "quantity_faulty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_categories" ADD COLUMN "quantity_damaged" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "product_variants" ADD COLUMN "quantity_faulty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "product_variants" ADD COLUMN "quantity_damaged" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sale_return_items" ADD COLUMN "condition" TEXT NOT NULL DEFAULT 'GOOD';
