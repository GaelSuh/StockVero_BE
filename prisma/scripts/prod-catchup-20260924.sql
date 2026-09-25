-- Production catch-up, 2026-09-24.
--
-- Production stopped at 20260601000000_password_changed_at (+ the Campay
-- migration). The 18 migrations after that cannot be replayed on it: the
-- migration files do not create every table the schema uses (e.g. sales,
-- sale_returns, price_lists, invoices were introduced via `db push`), so
-- `migrate deploy` fails at 20260819200000_return_exchange_link.
--
-- Instead this script applies:
--   1. `prisma migrate diff` from production's live schema to schema.prisma
--      (structural changes only; generated, not hand-written), then
--   2. the three data backfills those 18 migrations carry, in order.
-- Afterwards the 18 migrations are marked applied with `migrate resolve`.
--
-- Everything runs in one transaction: it either all applies or none of it.

BEGIN;

-- ===================== 1. Structural diff (generated) =====================
-- CreateEnum
CREATE TYPE "StockTrackingMode" AS ENUM ('SERIALIZED', 'QUANTITY');

-- CreateEnum
CREATE TYPE "TenantVerificationIdType" AS ENUM ('TAX_ID', 'NATIONAL_ID');

-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('RETAIL_SHOP', 'WHOLESALE_DISTRIBUTION', 'RETAIL_WHOLESALE', 'MANUFACTURING', 'SERVICE_INSTALLATION', 'OTHER');

-- CreateEnum
CREATE TYPE "SaleMode" AS ENUM ('RETAIL', 'WHOLESALE');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('DRAFT', 'COMPLETED', 'PARTIAL', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "SalePaymentStatus" AS ENUM ('PAID', 'PARTIAL', 'CREDIT', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SalePaymentMethod" AS ENUM ('CASH', 'MTN_MOMO', 'ORANGE_MONEY', 'CARD', 'BANK_TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "ReturnType" AS ENUM ('REFUND', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'PARTIAL_DELIVERY');

-- DropIndex
DROP INDEX "product_items_system_id_key";

-- AlterTable
ALTER TABLE "category_stock_logs" ADD COLUMN     "offline_id" TEXT,
ADD COLUMN     "variant_id" TEXT;

-- AlterTable
ALTER TABLE "customer_purchases" ADD COLUMN     "product_item_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "inventory_categories" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "has_unique_per_unit_barcode" BOOLEAN,
ADD COLUMN     "product_category_id" TEXT,
ADD COLUMN     "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retail_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "stock_tracking_mode" "StockTrackingMode" NOT NULL DEFAULT 'SERIALIZED',
ADD COLUMN     "wholesale_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "product_items" ADD COLUMN     "variant_id" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "organization_type" "OrganizationType",
ADD COLUMN     "settings_config" JSONB,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "verification_doc_mime" TEXT,
ADD COLUMN     "verification_doc_name" TEXT,
ADD COLUMN     "verification_doc_path" TEXT,
ADD COLUMN     "verification_id_number" TEXT,
ADD COLUMN     "verification_id_type" "TenantVerificationIdType";

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

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "axis_order" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "label" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "price_override" DECIMAL(15,2),
    "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_otps" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sale_number" TEXT NOT NULL,
    "mode" "SaleMode" NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "customer_id" TEXT,
    "customer_name" TEXT,
    "sold_by_id" TEXT NOT NULL,
    "sold_by_type" "NotificationUserType" NOT NULL,
    "sold_by_name" TEXT NOT NULL,
    "subtotal" DECIMAL(15,2) NOT NULL,
    "discount_type" "DiscountType",
    "discount_value" DECIMAL(15,2),
    "discount_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(15,2) NOT NULL,
    "payment_status" "SalePaymentStatus" NOT NULL DEFAULT 'PAID',
    "amount_paid" DECIMAL(15,2) NOT NULL,
    "amount_owed" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "tip_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "credit_due_date" TIMESTAMP(3),
    "delivery_status" "DeliveryStatus",
    "delivery_notes_text" TEXT,
    "minimum_order_met" BOOLEAN,
    "credit_collateral" TEXT,
    "offline_id" TEXT,
    "created_offline" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" TIMESTAMP(3),
    "transaction_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "sku" TEXT,
    "unit_price" DECIMAL(15,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "discount_type" "DiscountType",
    "discount_value" DECIMAL(15,2),
    "discount_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(15,2) NOT NULL,
    "batch_number" TEXT,
    "lot_number" TEXT,
    "product_item_id" TEXT,
    "serial_number" TEXT,
    "variant_id" TEXT,
    "variant_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_payments" (
    "id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "method" "SalePaymentMethod" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "reference" TEXT,
    "paid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by_id" TEXT NOT NULL,
    "recorded_by_name" TEXT NOT NULL,

    CONSTRAINT "sale_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_returns" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "return_number" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "return_type" "ReturnType" NOT NULL,
    "refund_amount" DECIMAL(15,2) NOT NULL,
    "refund_method" "SalePaymentMethod",
    "processed_by_id" TEXT NOT NULL,
    "processed_by_name" TEXT NOT NULL,
    "exchange_sale_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_items" (
    "id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(15,2) NOT NULL,
    "variant_id" TEXT,

    CONSTRAINT "sale_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_lists" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_rules" (
    "id" TEXT NOT NULL,
    "price_list_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "min_quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(15,2) NOT NULL,

    CONSTRAINT "price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_price_lists" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "price_list_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_notes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "note_number" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "dispatched_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "driver_name" TEXT,
    "vehicle_info" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_note_items" (
    "id" TEXT NOT NULL,
    "delivery_note_id" TEXT NOT NULL,
    "sale_item_id" TEXT NOT NULL,
    "quantity_shipped" INTEGER NOT NULL,
    "quantity_received" INTEGER,

    CONSTRAINT "delivery_note_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_summaries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "total_sales" INTEGER NOT NULL DEFAULT 0,
    "total_revenue" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "cash_collected" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "mobile_money_collected" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "card_collected" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "credit_given" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "returns_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_sequences" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "last_seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sale_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_categories_tenant_id_idx" ON "product_categories"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_tenant_id_normalized_name_key" ON "product_categories"("tenant_id", "normalized_name");

-- CreateIndex
CREATE INDEX "product_variants_tenant_id_idx" ON "product_variants"("tenant_id");

-- CreateIndex
CREATE INDEX "product_variants_tenant_id_category_id_idx" ON "product_variants"("tenant_id", "category_id");

-- CreateIndex
CREATE INDEX "product_variants_tenant_id_category_id_is_active_idx" ON "product_variants"("tenant_id", "category_id", "is_active");

-- CreateIndex
CREATE INDEX "product_variants_tenant_id_barcode_idx" ON "product_variants"("tenant_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_tenant_id_sku_key" ON "product_variants"("tenant_id", "sku") WHERE (sku IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_tenant_id_barcode_key" ON "product_variants"("tenant_id", "barcode") WHERE (barcode IS NOT NULL);

-- CreateIndex
CREATE INDEX "email_verification_otps_email_idx" ON "email_verification_otps"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sales_offline_id_key" ON "sales"("offline_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_transaction_id_key" ON "sales"("transaction_id");

-- CreateIndex
CREATE INDEX "sales_tenant_id_created_at_idx" ON "sales"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "sales_tenant_id_customer_id_idx" ON "sales"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "sales_tenant_id_mode_idx" ON "sales"("tenant_id", "mode");

-- CreateIndex
CREATE INDEX "sales_tenant_id_payment_status_idx" ON "sales"("tenant_id", "payment_status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenant_id_sale_number_key" ON "sales"("tenant_id", "sale_number");

-- CreateIndex
CREATE INDEX "sale_items_sale_id_idx" ON "sale_items"("sale_id");

-- CreateIndex
CREATE INDEX "sale_items_category_id_idx" ON "sale_items"("category_id");

-- CreateIndex
CREATE INDEX "sale_items_product_item_id_idx" ON "sale_items"("product_item_id");

-- CreateIndex
CREATE INDEX "sale_items_variant_id_idx" ON "sale_items"("variant_id");

-- CreateIndex
CREATE INDEX "sale_payments_sale_id_idx" ON "sale_payments"("sale_id");

-- CreateIndex
CREATE INDEX "sale_returns_tenant_id_idx" ON "sale_returns"("tenant_id");

-- CreateIndex
CREATE INDEX "sale_returns_sale_id_idx" ON "sale_returns"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenant_id_return_number_key" ON "sale_returns"("tenant_id", "return_number");

-- CreateIndex
CREATE INDEX "sale_return_items_return_id_idx" ON "sale_return_items"("return_id");

-- CreateIndex
CREATE INDEX "sale_return_items_variant_id_idx" ON "sale_return_items"("variant_id");

-- CreateIndex
CREATE INDEX "price_lists_tenant_id_idx" ON "price_lists"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_one_default_per_tenant" ON "price_lists"("tenant_id") WHERE (is_default);

-- CreateIndex
CREATE INDEX "price_rules_price_list_id_idx" ON "price_rules"("price_list_id");

-- CreateIndex
CREATE INDEX "price_rules_category_id_idx" ON "price_rules"("category_id");

-- CreateIndex
CREATE INDEX "price_rules_price_list_id_category_id_variant_id_idx" ON "price_rules"("price_list_id", "category_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_rules_product_tier_key" ON "price_rules"("price_list_id", "category_id", "min_quantity") WHERE (variant_id IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "price_rules_variant_tier_key" ON "price_rules"("price_list_id", "category_id", "variant_id", "min_quantity") WHERE (variant_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "customer_price_lists_customer_id_idx" ON "customer_price_lists"("customer_id");

-- CreateIndex
CREATE INDEX "customer_price_lists_price_list_id_idx" ON "customer_price_lists"("price_list_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_price_lists_customer_id_price_list_id_key" ON "customer_price_lists"("customer_id", "price_list_id");

-- CreateIndex
CREATE INDEX "delivery_notes_tenant_id_idx" ON "delivery_notes"("tenant_id");

-- CreateIndex
CREATE INDEX "delivery_notes_sale_id_idx" ON "delivery_notes"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_notes_tenant_id_note_number_key" ON "delivery_notes"("tenant_id", "note_number");

-- CreateIndex
CREATE INDEX "delivery_note_items_delivery_note_id_idx" ON "delivery_note_items"("delivery_note_id");

-- CreateIndex
CREATE INDEX "daily_summaries_tenant_id_idx" ON "daily_summaries"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_summaries_tenant_id_date_key" ON "daily_summaries"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "sale_sequences_tenant_id_key" ON "sale_sequences"("tenant_id");

-- CreateIndex
CREATE INDEX "category_stock_logs_tenant_id_category_id_variant_id_idx" ON "category_stock_logs"("tenant_id", "category_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_stock_logs_tenant_id_offline_id_key" ON "category_stock_logs"("tenant_id", "offline_id") WHERE (offline_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "inventory_categories_tenant_id_product_category_id_idx" ON "inventory_categories"("tenant_id", "product_category_id");

-- CreateIndex
CREATE INDEX "inventory_categories_tenant_id_barcode_idx" ON "inventory_categories"("tenant_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_categories_tenant_id_barcode_key" ON "inventory_categories"("tenant_id", "barcode") WHERE (barcode IS NOT NULL);

-- CreateIndex
CREATE INDEX "product_items_tenant_id_category_id_variant_id_stock_status_idx" ON "product_items"("tenant_id", "category_id", "variant_id", "stock_status");

-- CreateIndex
CREATE INDEX "product_items_tenant_id_category_id_variant_id_inventory_st_idx" ON "product_items"("tenant_id", "category_id", "variant_id", "inventory_status");

-- CreateIndex
CREATE UNIQUE INDEX "product_items_tenant_id_system_id_key" ON "product_items"("tenant_id", "system_id");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_categories" ADD CONSTRAINT "inventory_categories_product_category_id_fkey" FOREIGN KEY ("product_category_id") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "inventory_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_items" ADD CONSTRAINT "product_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_stock_logs" ADD CONSTRAINT "category_stock_logs_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "inventory_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_item_id_fkey" FOREIGN KEY ("product_item_id") REFERENCES "product_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "sale_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "inventory_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_price_lists" ADD CONSTRAINT "customer_price_lists_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_price_lists" ADD CONSTRAINT "customer_price_lists_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_note_items" ADD CONSTRAINT "delivery_note_items_delivery_note_id_fkey" FOREIGN KEY ("delivery_note_id") REFERENCES "delivery_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_sequences" ADD CONSTRAINT "sale_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===================== 2. Data backfills (verbatim from migrations) =====================

-- from 20260814120000_stock_tracking_mode
UPDATE "inventory_categories" AS c
SET "stock_tracking_mode" = 'QUANTITY',
    "quantity_on_hand" = c."planned_qty"
WHERE c."planned_qty" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "product_items" AS pi WHERE pi."category_id" = c."id"
  );

-- from 20260819120000_backfill_stock_approval
UPDATE "tenants" AS t
SET "settings_config" =
      COALESCE(t."settings_config", '{}'::jsonb)
      || jsonb_build_object('stockApprovalRequired', true)
WHERE
  -- Only where no explicit choice has been recorded yet.
  (t."settings_config" IS NULL OR NOT (t."settings_config" ? 'stockApprovalRequired'))
  AND EXISTS (
    SELECT 1 FROM "tenant_modules" AS m
    WHERE m."tenant_id" = t."id"
      AND m."module_key" = 'projects'
      AND m."is_enabled" = true
  );

-- from 20260820200000_backfill_org_type
UPDATE "tenants" AS t
SET "organization_type" = CASE
  WHEN EXISTS (SELECT 1 FROM "tenant_modules" m WHERE m."tenant_id" = t."id" AND m."module_key" = 'retail_sales'    AND m."is_enabled")
   AND EXISTS (SELECT 1 FROM "tenant_modules" m WHERE m."tenant_id" = t."id" AND m."module_key" = 'wholesale_sales' AND m."is_enabled")
    THEN 'RETAIL_WHOLESALE'::"OrganizationType"
  WHEN EXISTS (SELECT 1 FROM "tenant_modules" m WHERE m."tenant_id" = t."id" AND m."module_key" = 'wholesale_sales' AND m."is_enabled")
    THEN 'WHOLESALE_DISTRIBUTION'::"OrganizationType"
  WHEN EXISTS (SELECT 1 FROM "tenant_modules" m WHERE m."tenant_id" = t."id" AND m."module_key" = 'retail_sales'    AND m."is_enabled")
    THEN 'RETAIL_SHOP'::"OrganizationType"
  WHEN EXISTS (SELECT 1 FROM "tenant_modules" m WHERE m."tenant_id" = t."id" AND m."module_key" = 'projects'        AND m."is_enabled")
    THEN 'SERVICE_INSTALLATION'::"OrganizationType"
  ELSE 'OTHER'::"OrganizationType"
END
WHERE t."organization_type" IS NULL;

COMMIT;
