-- Admin insights (ADMIN_PROMPT_02). Additive only: one new table for the nightly score history.
-- Hand-trimmed from `prisma migrate diff`: the full diff against the live database also wants to
-- drop the CamPay columns/enum values that exist on the database but not in this repo's schema.
-- Those statements are deliberately NOT included. No existing table or column is touched.

-- CreateTable
CREATE TABLE "tenant_daily_scores" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "state" TEXT NOT NULL,
    "score" INTEGER,
    "band" TEXT,
    "tier" TEXT NOT NULL,
    "value_score" INTEGER NOT NULL,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_daily_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_daily_scores_day_band_idx" ON "tenant_daily_scores"("day", "band");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_daily_scores_tenant_id_day_key" ON "tenant_daily_scores"("tenant_id", "day");

-- AddForeignKey
ALTER TABLE "tenant_daily_scores" ADD CONSTRAINT "tenant_daily_scores_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

