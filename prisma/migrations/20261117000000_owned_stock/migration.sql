-- Serialized products whose units were already owned: no expense, no purchase approval.
ALTER TABLE "inventory_categories" ADD COLUMN IF NOT EXISTS "owned_stock" BOOLEAN NOT NULL DEFAULT false;
