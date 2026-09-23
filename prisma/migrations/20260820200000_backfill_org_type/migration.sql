-- organizationType was declared on the tenant model but nothing ever wrote it,
-- so every existing tenant has NULL and Settings would show "not set" for all of
-- them. The modules a tenant actually runs are the best available evidence of
-- what kind of business it is, so the type is inferred from those rather than
-- interrupting anyone to ask.
--
-- Only rows with no type are touched: a tenant that has since chosen one keeps
-- its answer.
UPDATE "tenants" AS t
SET "organization_type" = CASE
  WHEN EXISTS (SELECT 1 FROM "tenant_modules" m WHERE m."tenant_id" = t."id" AND m."module_key" = 'retail_sales'    AND m."is_enabled")
   AND EXISTS (SELECT 1 FROM "tenant_modules" m WHERE m."tenant_id" = t."id" AND m."module_key" = 'wholesale_sales' AND m."is_enabled")
    THEN 'RETAIL_WHOLESALE'::"OrganizationType"
  WHEN EXISTS (SELECT 1 FROM "tenant_modules" m WHERE m."tenant_id" = t."id" AND m."module_key" = 'wholesale_sales' AND m."is_enabled")
    THEN 'WHOLESALE_DISTRIBUTION'::"OrganizationType"
  WHEN EXISTS (SELECT 1 FROM "tenant_modules" m WHERE m."tenant_id" = t."id" AND m."module_key" = 'retail_sales'    AND m."is_enabled")
    THEN 'RETAIL_SHOP'::"OrganizationType"
  WHEN EXISTS (SELECT 1 FROM "tenant_modules" m WHERE m."tenant_id" = t."id" AND m."module_key" = 'projects'        AND m."is_enabled")
    THEN 'SERVICE_INSTALLATION'::"OrganizationType"
  ELSE 'OTHER'::"OrganizationType"
END
WHERE t."organization_type" IS NULL;
