-- Branches, phase 1 (foundation). See StockVero_Branches_Design.md.
--
-- A tenant can now run several branches. Daily-work tables gain a required
-- branch_id; company tables (roles, users, modules, number sequences) do not.
-- Uniqueness that is about a branch's own catalogue (SKU, barcode, category
-- name, unit system id, default price list, daily summary, finance balance)
-- moves from per tenant to per branch. Sale, return and delivery-note numbers
-- stay unique per tenant: one company-wide sequence.
--
-- Safe on a populated database: the columns are added nullable, every row is
-- assigned to its tenant's new main branch, and only then made NOT NULL.

-- DropIndex
DROP INDEX "inventory_items_tenant_id_sku_key";

-- DropIndex
DROP INDEX "product_categories_tenant_id_normalized_name_key";

-- DropIndex
DROP INDEX "inventory_categories_tenant_id_sku_key";

-- DropIndex
DROP INDEX "inventory_categories_tenant_id_barcode_key";

-- DropIndex
DROP INDEX "product_variants_tenant_id_sku_key";

-- DropIndex
DROP INDEX "product_variants_tenant_id_barcode_key";

-- DropIndex
DROP INDEX "product_items_tenant_id_system_id_key";

-- DropIndex
DROP INDEX "tenant_finance_balance_tenant_id_key";

-- DropIndex
DROP INDEX "price_lists_one_default_per_tenant";

-- DropIndex
DROP INDEX "daily_summaries_tenant_id_date_key";

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "branch_id" TEXT;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "product_categories" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "inventory_categories" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "product_items" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "product_item_maintenance_logs" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "category_stock_logs" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "customer_contacts" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "customer_purchases" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "project_milestones" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "project_materials" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "project_assignments" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "invoice_payments" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "tenant_finance_balance" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "branch_id" TEXT;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "branch_id" TEXT;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "sale_returns" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "price_lists" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "delivery_notes" ADD COLUMN "branch_id" TEXT;

-- AlterTable
ALTER TABLE "daily_summaries" ADD COLUMN "branch_id" TEXT;

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "is_main" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_access" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_access_pkey" PRIMARY KEY ("id")
);


-- ─── Backfill ────────────────────────────────────────────────────────────────
-- Every tenant gets its main branch, and everything recorded before branches
-- existed belongs to it. Employees keep their current role, now in that branch.
INSERT INTO "branches" ("id", "tenant_id", "name", "code", "is_main", "is_active", "created_at", "updated_at")
SELECT gen_random_uuid(), t."id", 'Main branch', 'MAIN', true, true, NOW(), NOW()
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."tenant_id" = t."id" AND b."is_main");

UPDATE "employees" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "inventory_items" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "product_categories" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "inventory_categories" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "product_variants" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "product_items" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "product_item_maintenance_logs" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "category_stock_logs" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "inventory_movements" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "stock_movements" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "customers" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "customer_contacts" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "customer_purchases" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "projects" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "project_milestones" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "project_materials" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "project_assignments" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "transactions" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "invoices" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "invoice_payments" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "tenant_finance_balance" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "documents" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "sales" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "sale_returns" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "price_lists" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "delivery_notes" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "daily_summaries" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;

-- Past audit entries and notifications all happened in the main branch.
UPDATE "audit_logs" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;
UPDATE "notifications" x SET "branch_id" = b."id" FROM "branches" b WHERE b."tenant_id" = x."tenant_id" AND b."is_main" AND x."branch_id" IS NULL;

ALTER TABLE "employees" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "inventory_items" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "product_categories" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "inventory_categories" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "product_variants" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "product_items" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "product_item_maintenance_logs" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "category_stock_logs" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "inventory_movements" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "stock_movements" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "customers" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "customer_contacts" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "customer_purchases" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "projects" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "project_milestones" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "project_materials" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "project_assignments" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "transactions" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "invoices" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "invoice_payments" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "tenant_finance_balance" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "sales" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "sale_returns" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "price_lists" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "delivery_notes" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "daily_summaries" ALTER COLUMN "branch_id" SET NOT NULL;
-- ─── End backfill ────────────────────────────────────────────────────────────

-- CreateIndex
CREATE INDEX "branches_tenant_id_idx" ON "branches"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenant_id_code_key" ON "branches"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenant_id_name_key" ON "branches"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "branches_one_main_per_tenant" ON "branches"("tenant_id") WHERE (is_main);

-- CreateIndex
CREATE INDEX "branch_access_tenant_id_idx" ON "branch_access"("tenant_id");

-- CreateIndex
CREATE INDEX "branch_access_branch_id_idx" ON "branch_access"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_access_employee_id_branch_id_key" ON "branch_access"("employee_id", "branch_id");

-- CreateIndex
CREATE INDEX "roles_branch_id_idx" ON "roles"("branch_id");

-- CreateIndex
CREATE INDEX "employees_branch_id_idx" ON "employees"("branch_id");

-- CreateIndex
CREATE INDEX "inventory_items_branch_id_idx" ON "inventory_items"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_tenant_id_branch_id_sku_key" ON "inventory_items"("tenant_id", "branch_id", "sku");

-- CreateIndex
CREATE INDEX "product_categories_branch_id_idx" ON "product_categories"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_tenant_id_branch_id_normalized_name_key" ON "product_categories"("tenant_id", "branch_id", "normalized_name");

-- CreateIndex
CREATE INDEX "inventory_categories_branch_id_idx" ON "inventory_categories"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_categories_tenant_id_branch_id_sku_key" ON "inventory_categories"("tenant_id", "branch_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_categories_tenant_id_branch_id_barcode_key" ON "inventory_categories"("tenant_id", "branch_id", "barcode") WHERE (barcode IS NOT NULL);

-- CreateIndex
CREATE INDEX "product_variants_branch_id_idx" ON "product_variants"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_tenant_id_branch_id_sku_key" ON "product_variants"("tenant_id", "branch_id", "sku") WHERE (sku IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_tenant_id_branch_id_barcode_key" ON "product_variants"("tenant_id", "branch_id", "barcode") WHERE (barcode IS NOT NULL);

-- CreateIndex
CREATE INDEX "product_items_branch_id_idx" ON "product_items"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_items_tenant_id_branch_id_system_id_key" ON "product_items"("tenant_id", "branch_id", "system_id");

-- CreateIndex
CREATE INDEX "product_item_maintenance_logs_branch_id_idx" ON "product_item_maintenance_logs"("branch_id");

-- CreateIndex
CREATE INDEX "category_stock_logs_branch_id_idx" ON "category_stock_logs"("branch_id");

-- CreateIndex
CREATE INDEX "inventory_movements_branch_id_idx" ON "inventory_movements"("branch_id");

-- CreateIndex
CREATE INDEX "stock_movements_branch_id_idx" ON "stock_movements"("branch_id");

-- CreateIndex
CREATE INDEX "customers_branch_id_idx" ON "customers"("branch_id");

-- CreateIndex
CREATE INDEX "customer_contacts_branch_id_idx" ON "customer_contacts"("branch_id");

-- CreateIndex
CREATE INDEX "customer_purchases_branch_id_idx" ON "customer_purchases"("branch_id");

-- CreateIndex
CREATE INDEX "projects_branch_id_idx" ON "projects"("branch_id");

-- CreateIndex
CREATE INDEX "project_milestones_branch_id_idx" ON "project_milestones"("branch_id");

-- CreateIndex
CREATE INDEX "project_materials_branch_id_idx" ON "project_materials"("branch_id");

-- CreateIndex
CREATE INDEX "project_assignments_branch_id_idx" ON "project_assignments"("branch_id");

-- CreateIndex
CREATE INDEX "transactions_branch_id_idx" ON "transactions"("branch_id");

-- CreateIndex
CREATE INDEX "invoices_branch_id_idx" ON "invoices"("branch_id");

-- CreateIndex
CREATE INDEX "invoice_payments_branch_id_idx" ON "invoice_payments"("branch_id");

-- CreateIndex
CREATE INDEX "tenant_finance_balance_branch_id_idx" ON "tenant_finance_balance"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_finance_balance_tenant_id_branch_id_key" ON "tenant_finance_balance"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_branch_id_idx" ON "notifications"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "documents_branch_id_idx" ON "documents"("branch_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_branch_id_idx" ON "audit_logs"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "sales_branch_id_idx" ON "sales"("branch_id");

-- CreateIndex
CREATE INDEX "sale_returns_branch_id_idx" ON "sale_returns"("branch_id");

-- CreateIndex
CREATE INDEX "price_lists_branch_id_idx" ON "price_lists"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_one_default_per_branch" ON "price_lists"("tenant_id", "branch_id") WHERE (is_default);

-- CreateIndex
CREATE INDEX "delivery_notes_branch_id_idx" ON "delivery_notes"("branch_id");

-- CreateIndex
CREATE INDEX "daily_summaries_branch_id_idx" ON "daily_summaries"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_summaries_tenant_id_branch_id_date_key" ON "daily_summaries"("tenant_id", "branch_id", "date");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_access" ADD CONSTRAINT "branch_access_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_access" ADD CONSTRAINT "branch_access_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_access" ADD CONSTRAINT "branch_access_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_access" ADD CONSTRAINT "branch_access_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_categories" ADD CONSTRAINT "inventory_categories_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_items" ADD CONSTRAINT "product_items_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_item_maintenance_logs" ADD CONSTRAINT "product_item_maintenance_logs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_stock_logs" ADD CONSTRAINT "category_stock_logs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_purchases" ADD CONSTRAINT "customer_purchases_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_materials" ADD CONSTRAINT "project_materials_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_assignments" ADD CONSTRAINT "project_assignments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_finance_balance" ADD CONSTRAINT "tenant_finance_balance_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

