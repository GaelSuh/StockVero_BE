-- Production-readiness migration: add performance indexes and fix schema defaults
-- This migration adds critical indexes for query performance and fixes the InventoryItem.deprecated default.

-- ═══════════════════════════════════════════════════════════════════════════════
-- PERFORMANCE INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Transactions: critical for balance calculations (filter by status + type)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions_tenant_id_status_idx"
  ON "transactions" ("tenant_id", "status");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions_tenant_id_status_type_idx"
  ON "transactions" ("tenant_id", "status", "type");

-- Invoice line items: needed for invoice detail fetches
CREATE INDEX CONCURRENTLY IF NOT EXISTS "invoice_line_items_invoice_id_idx"
  ON "invoice_line_items" ("invoice_id");

-- Notifications: covers ordered queries with isRead filter
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_tenant_user_read_created_idx"
  ON "notifications" ("tenant_id", "user_id", "is_read", "created_at");

-- Tenant audit logs: time-range queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenant_audit_logs_created_at_idx"
  ON "tenant_audit_logs" ("created_at");

-- ═══════════════════════════════════════════════════════════════════════════════
-- SCHEMA FIXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Fix: InventoryItem.deprecated was defaulting to TRUE (new items were immediately deprecated)
ALTER TABLE "inventory_items" ALTER COLUMN "deprecated" SET DEFAULT false;

-- Fix: Transaction.currency should default to XAF (CFA Franc), not USD
ALTER TABLE "transactions" ALTER COLUMN "currency" SET DEFAULT 'XAF';
