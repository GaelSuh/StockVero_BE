-- ProductVariant.sku becomes optional, with a PARTIAL unique index.
--
-- Generating a variant matrix creates a dozen combinations in one action, and
-- there is no honest way to invent a dozen meaningful SKUs at that moment:
-- auto-generated codes are noise, and requiring one per combination up front
-- turns a bulk setup into a dozen uniqueness conflicts. Generated variants
-- therefore start with no sku and it is filled in per variant afterwards.
--
-- The index must be partial for the same reason barcode's is: a plain unique
-- would allow only ONE variant per tenant to have no sku, since Postgres
-- treats NULLs as distinct only under NULLS DISTINCT — and the moment two
-- generated variants both had no sku the second insert would fail. Filtered to
-- `WHERE sku IS NOT NULL`, any number may be blank while a sku that IS set
-- stays unique per tenant.
--
-- Widening only: every existing row has a sku and keeps it.

-- DropIndex
DROP INDEX "product_variants_tenant_id_sku_key";

-- AlterTable
ALTER TABLE "product_variants" ALTER COLUMN "sku" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_tenant_id_sku_key" ON "product_variants"("tenant_id", "sku") WHERE (sku IS NOT NULL);
