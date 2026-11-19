-- A price-list rule is now either a fixed unit price or a percentage off the
-- product's own price. Additive: every existing rule keeps its unit price.
ALTER TABLE "price_rules" ALTER COLUMN "unit_price" DROP NOT NULL;
ALTER TABLE "price_rules" ADD COLUMN "discount_percent" DECIMAL(5,2);

-- Exactly one of the two, and a percentage that leaves a price above zero.
-- Prisma does not model CHECK constraints and leaves them alone on later diffs.
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_price_or_discount"
  CHECK (
    ("unit_price" IS NOT NULL AND "discount_percent" IS NULL)
    OR ("unit_price" IS NULL AND "discount_percent" > 0 AND "discount_percent" < 100)
  );
