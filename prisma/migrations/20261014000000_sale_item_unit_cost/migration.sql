-- Cost of each sold unit, captured on the sale line so profit is exact and stable.
-- Existing rows stay NULL until `npm run backfill:sale-costs` fills them.
ALTER TABLE "sale_items" ADD COLUMN "unit_cost" DECIMAL(15,2);
ALTER TABLE "sale_items" ADD COLUMN "cost_source" TEXT;
