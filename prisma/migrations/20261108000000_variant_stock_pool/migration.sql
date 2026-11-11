-- Variant stock pool.
--
-- For a QUANTITY product with variants, the product's own quantity_on_hand
-- now means stock NOT YET SHARED OUT to a variant (sellable as the product
-- itself); the product's total is that plus what its variants hold. Before,
-- it was read as the total that variants were carved out of, while every
-- variant sale, return, restock and condition move changed only the variant,
-- so the old number drifted away from reality.
--
-- Every one of those variant movements is logged against its variant in
-- category_stock_logs, and giving stock to a variant logged nothing. So:
--
--   real total       = old product number + sum of logged variant movements
--   not shared out   = real total - what the variants hold now
--
-- Examples from the development database: a shoe at 15 whose variants were
-- sold down by 3 to 12 becomes 0 (nothing left unshared); an adapter at 41
-- with 21 in variants and no variant movements becomes 20.
--
-- Serialized products and products without variants are not touched.
-- Never below zero (the stock CHECK constraint forbids it).
WITH variant_stock AS (
  SELECT category_id, SUM(quantity_on_hand) AS held
  FROM product_variants
  GROUP BY category_id
),
variant_moves AS (
  SELECT category_id, SUM(delta) AS moved
  FROM category_stock_logs
  WHERE variant_id IS NOT NULL
  GROUP BY category_id
)
UPDATE inventory_categories AS c
SET quantity_on_hand = GREATEST(
  0,
  c.quantity_on_hand + COALESCE(m.moved, 0) - vs.held
)
FROM variant_stock AS vs
LEFT JOIN variant_moves AS m ON m.category_id = vs.category_id
WHERE vs.category_id = c.id
  AND c.stock_tracking_mode = 'QUANTITY';
