-- Stock counts can never go below zero. The app already refuses a sale or a
-- condition move that would (decrementIfAvailable); these constraints are the
-- backstop so no code path, script or manual edit can store a negative count.
-- Prisma does not model CHECK constraints and leaves them alone on later diffs.
-- Fails if a negative row already exists: fix those rows first.

ALTER TABLE "inventory_categories"
  ADD CONSTRAINT "inventory_categories_quantities_non_negative"
  CHECK ("quantity_on_hand" >= 0 AND "quantity_faulty" >= 0 AND "quantity_damaged" >= 0);

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_quantities_non_negative"
  CHECK ("quantity_on_hand" >= 0 AND "quantity_faulty" >= 0 AND "quantity_damaged" >= 0);
