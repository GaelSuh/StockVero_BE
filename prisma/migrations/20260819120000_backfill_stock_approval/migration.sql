-- The stockApprovalRequired default flips from true to false: recording that
-- stock arrived is a statement of fact, not a request to spend.
--
-- Tenants already running projects were relying on the old default, so their
-- choice is written down explicitly before the default changes underneath them.
-- Nobody's behaviour changes without an owner deciding; the Settings toggle is
-- how they turn it off.
UPDATE "tenants" AS t
SET "settings_config" =
      COALESCE(t."settings_config", '{}'::jsonb)
      || jsonb_build_object('stockApprovalRequired', true)
WHERE
  -- Only where no explicit choice has been recorded yet.
  (t."settings_config" IS NULL OR NOT (t."settings_config" ? 'stockApprovalRequired'))
  AND EXISTS (
    SELECT 1 FROM "tenant_modules" AS m
    WHERE m."tenant_id" = t."id"
      AND m."module_key" = 'projects'
      AND m."is_enabled" = true
  );
