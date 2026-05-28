-- Migration: Seed default RolePermission rows for the "administration" module
-- on every existing role, replacing the blunt isAdmin boolean gate.
--
-- Rules:
--   - Roles with is_admin = true  → canRead: true,  canCreate: true,  canUpdate: false, canDelete: false
--   - Roles with is_admin = false → canRead: false, canCreate: false, canUpdate: false, canDelete: false
--
-- ON CONFLICT DO NOTHING ensures idempotency: running this twice is safe.

INSERT INTO "role_permissions" (
  "id",
  "role_id",
  "module_key",
  "can_read",
  "can_create",
  "can_update",
  "can_delete"
)
SELECT
  gen_random_uuid(),
  r."id",
  'administration',
  r."is_admin",    -- canRead  = true for admin roles, false for others
  r."is_admin",    -- canCreate = true for admin roles, false for others
  false,
  false
FROM "roles" r
WHERE NOT EXISTS (
  SELECT 1
  FROM "role_permissions" rp
  WHERE rp."role_id" = r."id"
    AND rp."module_key" = 'administration'
);
