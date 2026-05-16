-- Add TransactionStatus enum and status column
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');
ALTER TABLE "transactions" ADD COLUMN "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING';
UPDATE "transactions" SET "status" = 'ACCEPTED';
