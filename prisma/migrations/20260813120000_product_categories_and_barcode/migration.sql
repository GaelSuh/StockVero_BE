-- Product grouping for Retail & Wholesale products (inventory_categories rows).
-- A product belongs to at most one ProductCategory; the category name is unique
-- per tenant on its normalized (trimmed + lowercased) form, so "Soap", "soap "
-- and "SOAP" can never coexist as three separate categories.

-- CreateTable
CREATE TABLE "product_categories" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_categories_tenant_id_idx" ON "product_categories"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_tenant_id_normalized_name_key" ON "product_categories"("tenant_id", "normalized_name");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "inventory_categories" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "product_category_id" TEXT;

-- CreateIndex
CREATE INDEX "inventory_categories_tenant_id_product_category_id_idx" ON "inventory_categories"("tenant_id", "product_category_id");

-- CreateIndex
CREATE INDEX "inventory_categories_tenant_id_barcode_idx" ON "inventory_categories"("tenant_id", "barcode");

-- A barcode identifies exactly one product within a tenant, but most products
-- have none — a partial unique index keeps NULLs unconstrained.
CREATE UNIQUE INDEX "inventory_categories_tenant_id_barcode_key" ON "inventory_categories"("tenant_id", "barcode") WHERE "barcode" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "inventory_categories" ADD CONSTRAINT "inventory_categories_product_category_id_fkey" FOREIGN KEY ("product_category_id") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
