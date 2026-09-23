/**
 * Single source of truth for "how much of this product is on hand".
 *
 * Two tracking models coexist:
 *   SERIALIZED — every unit is a ProductItem row; stock is the count of the ones
 *                marked AVAILABLE. This is the Installation model and is unchanged.
 *   QUANTITY   — there are no unit rows; stock is the quantityOnHand column.
 *
 * Before this existed, the inventory screens counted unit rows while the POS read
 * a column, so a bulk-imported product read as 50 on the till and 0 in inventory.
 * Every stock read now goes through here.
 *
 * Phase 1 of product variants (2026-09) extends this to be variant-aware
 * without breaking any existing 2-arg caller: the optional third parameter
 * defaults to undefined, which reproduces the pre-variants behavior exactly.
 */

export type StockTrackingMode = 'SERIALIZED' | 'QUANTITY';

export interface StockCarrier {
  stockTrackingMode?: StockTrackingMode | null;
  quantityOnHand?: number | null;
  type?: string | null;
}

/** Minimal shape getAvailableStock needs from a variant — pass the ProductVariant row. */
export interface VariantStockCarrier {
  quantityOnHand?: number | null;
}

export const isQuantityTracked = (category: StockCarrier): boolean =>
  (category.stockTrackingMode ?? 'SERIALIZED') === 'QUANTITY';

/**
 * @param category      the product row
 * @param availableUnits count of AVAILABLE ProductItem rows, for serialised
 *                       products — scoped to the variant (WHERE variantId =
 *                       variant's id) when `variant` is passed, scoped to
 *                       WHERE variantId IS NULL (or no filter, for a product
 *                       with no variants at all) otherwise. This function
 *                       does not run that query itself, same division of
 *                       responsibility as before phase 1 — the caller
 *                       counts, this decides which number to trust.
 * @param variant       pass the ProductVariant row to resolve stock for one
 *                       specific variant; omit (or pass null/undefined) for
 *                       a variant-less product — unchanged from before phase 1.
 */
export const getAvailableStock = (
  category: StockCarrier,
  availableUnits: number,
  variant?: VariantStockCarrier | null,
): number => {
  if (isQuantityTracked(category)) {
    return variant ? (variant.quantityOnHand ?? 0) : (category.quantityOnHand ?? 0);
  }
  return availableUnits;
};

export const resolveStockStatus = (availableCount: number, reorderThreshold: number) => {
  if (availableCount === 0) return 'OUT_OF_STOCK';
  if (availableCount <= reorderThreshold) return 'LOW_STOCK';
  return 'IN_STOCK';
};
