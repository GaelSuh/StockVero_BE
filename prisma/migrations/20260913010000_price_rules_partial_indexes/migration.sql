-- Replace the NULLS NOT DISTINCT constraint on price_rules with two partial
-- unique indexes that express the same rule.
--
-- Why: Prisma 7.8's diffing is blind to the NULLS NOT DISTINCT clause. It
-- matches a unique constraint on name + columns only, so a hand-written
-- NULLS NOT DISTINCT constraint that the schema does not declare reads to
-- Prisma as "an object that should not exist" -- and every `migrate diff`
-- from here to forever proposes dropping it. That is a permanent hazard, not
-- a one-migration one.
--
-- Two partial unique indexes say exactly the same thing and ARE visible to
-- Prisma (the `partialIndexes` preview feature is enabled), so schema.prisma
-- and the database agree and no future migration proposes dropping them:
--
--   product-level rules (variant_id IS NULL)  -> one per (list, category, tier)
--   variant-level rules (variant_id NOT NULL) -> one per (list, category, variant, tier)
--
-- Together those are equivalent to UNIQUE NULLS NOT DISTINCT over all four
-- columns, because the two predicates partition the table.
--
-- NOTE: the DROP below is DROP CONSTRAINT, not the DROP INDEX that
-- `prisma migrate diff` generates. price_rules_list_cat_variant_qty_key was
-- created with ALTER TABLE ... ADD CONSTRAINT, so Postgres owns it as a
-- constraint and refuses `DROP INDEX` on the index backing it
-- ("cannot drop index ... because constraint ... requires it"). Prisma's
-- generated form would fail here; this is the corrected version. The two
-- CREATE INDEX statements below are Prisma's own generated output verbatim.

ALTER TABLE "price_rules" DROP CONSTRAINT IF EXISTS "price_rules_list_cat_variant_qty_key";

-- CreateIndex
CREATE UNIQUE INDEX "price_rules_product_tier_key" ON "price_rules"("price_list_id", "category_id", "min_quantity") WHERE (variant_id IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "price_rules_variant_tier_key" ON "price_rules"("price_list_id", "category_id", "variant_id", "min_quantity") WHERE (variant_id IS NOT NULL);
