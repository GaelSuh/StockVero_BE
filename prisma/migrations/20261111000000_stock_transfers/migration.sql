-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('PENDING', 'APPROVED', 'RECEIVED', 'REJECTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "StockItemStatus" ADD VALUE 'IN_TRANSIT';

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "from_branch_id" TEXT NOT NULL,
    "to_branch_id" TEXT NOT NULL,
    "from_product_id" TEXT NOT NULL,
    "to_product_id" TEXT NOT NULL,
    "from_variant_id" TEXT,
    "to_variant_id" TEXT,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'PENDING',
    "quantity_requested" INTEGER NOT NULL,
    "quantity_approved" INTEGER,
    "unit_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "close_reason" TEXT,
    "requested_by_name" TEXT NOT NULL,
    "approved_by_name" TEXT,
    "received_by_name" TEXT,
    "closed_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_transfers_tenant_id_from_branch_id_status_idx" ON "stock_transfers"("tenant_id", "from_branch_id", "status");

-- CreateIndex
CREATE INDEX "stock_transfers_tenant_id_to_branch_id_status_idx" ON "stock_transfers"("tenant_id", "to_branch_id", "status");

-- CreateIndex
CREATE INDEX "stock_transfers_from_product_id_idx" ON "stock_transfers"("from_product_id");

-- CreateIndex
CREATE INDEX "stock_transfers_to_product_id_idx" ON "stock_transfers"("to_product_id");

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_branch_id_fkey" FOREIGN KEY ("from_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_branch_id_fkey" FOREIGN KEY ("to_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_product_id_fkey" FOREIGN KEY ("from_product_id") REFERENCES "inventory_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_product_id_fkey" FOREIGN KEY ("to_product_id") REFERENCES "inventory_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

