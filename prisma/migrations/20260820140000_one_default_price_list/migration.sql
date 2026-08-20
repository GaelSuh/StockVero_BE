-- Only one price list per tenant may be the default.
--
-- resolvePrice picks the default with findFirst, so two of them would return an
-- arbitrary one and silently misprice every wholesale sale — a wrong number with
-- no error anywhere. The controller already clears the previous default on write;
-- this makes the database refuse the state outright, including on a race between
-- two concurrent updates.
--
-- Partial index: rows with is_default = false are unconstrained.
CREATE UNIQUE INDEX "price_lists_one_default_per_tenant"
  ON "price_lists" ("tenant_id")
  WHERE "is_default";
