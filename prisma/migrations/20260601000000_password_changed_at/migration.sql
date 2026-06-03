-- Add password_changed_at column to users and employees tables.
-- This tracks the last time a user voluntarily changed their password
-- via Settings (not via forgot-password or admin-reset flows).
-- The backend enforces a 3-month cooldown between voluntary changes.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMP(3);
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMP(3);
