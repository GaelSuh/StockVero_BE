-- New branches wait for a StockVero admin before anyone can sign in to them.
CREATE TYPE "BranchApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "branches" ADD COLUMN "approval_status" "BranchApprovalStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "approved_at" TIMESTAMP(3),
ADD COLUMN "rejection_reason" TEXT,
ADD COLUMN "reviewed_by" TEXT;

-- Every branch that exists today is already in use: approve it, so nobody is locked out.
UPDATE "branches" SET "approval_status" = 'APPROVED', "approved_at" = "created_at";

CREATE INDEX "branches_approval_status_idx" ON "branches"("approval_status");
