-- Admin monitoring foundations (ADMIN_PROMPT_01). Additive only:
--   * tenant_daily_metrics: one row per tenant per Africa/Douala day (counts and sums only).
--   * metrics_job_runs: one row per nightly / backfill / rebuild execution.
--   * users.last_seen_at, employees.last_seen_at: nullable, written by tenantGuard at most once per 5 min.
--   * sale_returns(tenant_id, created_at): the daily flow query reads returns by tenant and day.
-- No existing column is changed or dropped.


-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_seen_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "last_seen_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "tenant_daily_metrics" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "sales_count" INTEGER NOT NULL DEFAULT 0,
    "sales_value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "retail_sales_count" INTEGER NOT NULL DEFAULT 0,
    "retail_sales_value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "wholesale_sales_count" INTEGER NOT NULL DEFAULT 0,
    "wholesale_sales_value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "returns_count" INTEGER NOT NULL DEFAULT 0,
    "returns_value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "active_users" INTEGER NOT NULL DEFAULT 0,
    "user_actions" INTEGER NOT NULL DEFAULT 0,
    "product_count" INTEGER,
    "variant_count" INTEGER,
    "serialized_units_in_stock" INTEGER,
    "quantity_units_in_stock" INTEGER,
    "stock_value_at_cost" DECIMAL(16,2),
    "out_of_stock_count" INTEGER,
    "low_stock_count" INTEGER,
    "dead_stock_count" INTEGER,
    "flow_computed_at" TIMESTAMP(3) NOT NULL,
    "point_in_time_captured_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_daily_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_job_runs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from_day" DATE NOT NULL,
    "to_day" DATE NOT NULL,
    "tenant_id" TEXT,
    "triggered_by" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tenants_processed" INTEGER NOT NULL DEFAULT 0,
    "tenants_failed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "metrics_job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_daily_metrics_day_idx" ON "tenant_daily_metrics"("day");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_daily_metrics_tenant_id_day_key" ON "tenant_daily_metrics"("tenant_id", "day");

-- CreateIndex
CREATE INDEX "metrics_job_runs_kind_to_day_idx" ON "metrics_job_runs"("kind", "to_day");

-- CreateIndex
CREATE INDEX "metrics_job_runs_started_at_idx" ON "metrics_job_runs"("started_at");

-- CreateIndex
CREATE INDEX "sale_returns_tenant_id_created_at_idx" ON "sale_returns"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "tenant_daily_metrics" ADD CONSTRAINT "tenant_daily_metrics_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

