-- Admin insights UI and account management (ADMIN_PROMPT_03). Additive only:
--   * tenants.tenant_type (CUSTOMER by default; INTERNAL/DEMO/TEST are excluded from insights by default)
--   * tenants.account_owner_id (optional Digisol admin responsible for the account)
--   * tenant_notes (timestamped notes log), tenant_follow_ups, admin_activity_logs (non-tenant admin actions)
-- Hand-written from `prisma migrate diff` between this repo's schema before and after; never diffed
-- against the live database (it carries CamPay changes this repo does not have).
-- tenants.notes is NOT changed or dropped; its content is copied into tenant_notes below.

-- CreateEnum
CREATE TYPE "TenantType" AS ENUM ('CUSTOMER', 'INTERNAL', 'DEMO', 'TEST');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "account_owner_id" TEXT,
ADD COLUMN     "tenant_type" "TenantType" NOT NULL DEFAULT 'CUSTOMER';

-- CreateTable
CREATE TABLE "tenant_notes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "author_id" TEXT,
    "body" TEXT NOT NULL,
    "migrated_from_legacy" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_follow_ups" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "due_day" DATE NOT NULL,
    "assignee_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "completed_at" TIMESTAMP(3),
    "completed_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_activity_logs" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_notes_tenant_id_created_at_idx" ON "tenant_notes"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "tenant_follow_ups_assignee_id_status_due_day_idx" ON "tenant_follow_ups"("assignee_id", "status", "due_day");

-- CreateIndex
CREATE INDEX "tenant_follow_ups_tenant_id_status_idx" ON "tenant_follow_ups"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "admin_activity_logs_created_at_idx" ON "admin_activity_logs"("created_at");

-- CreateIndex
CREATE INDEX "tenants_account_owner_id_idx" ON "tenants"("account_owner_id");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_account_owner_id_fkey" FOREIGN KEY ("account_owner_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_notes" ADD CONSTRAINT "tenant_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_notes" ADD CONSTRAINT "tenant_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_follow_ups" ADD CONSTRAINT "tenant_follow_ups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_follow_ups" ADD CONSTRAINT "tenant_follow_ups_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "super_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_follow_ups" ADD CONSTRAINT "tenant_follow_ups_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_activity_logs" ADD CONSTRAINT "admin_activity_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data: move each tenant's single internal note into the log as its first entry, text kept exactly.
-- created_at uses tenants.updated_at, the best available "last edited" time for the old field.
INSERT INTO "tenant_notes" ("id", "tenant_id", "author_id", "body", "migrated_from_legacy", "created_at")
SELECT gen_random_uuid()::text, "id", NULL, "notes", true, "updated_at"
FROM "tenants"
WHERE "notes" IS NOT NULL AND btrim("notes") <> '';
