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
 */

export type StockTrackingMode = 'SERIALIZED' | 'QUANTITY';

export interface StockCarrier {
  stockTrackingMode?: StockTrackingMode | null;
  quantityOnHand?: number | null;
  type?: string | null;
}

export const isQuantityTracked = (category: StockCarrier): boolean =>
  (category.stockTrackingMode ?? 'SERIALIZED') === 'QUANTITY';

/**
 * @param category      the product row
 * @param availableUnits count of AVAILABLE ProductItem rows, for serialised products
 */
export const getAvailableStock = (category: StockCarrier, availableUnits: number): number =>
  isQuantityTracked(category) ? (category.quantityOnHand ?? 0) : availableUnits;

export const resolveStockStatus = (availableCount: number, reorderThreshold: number) => {
  if (availableCount === 0) return 'OUT_OF_STOCK';
  if (availableCount <= reorderThreshold) return 'LOW_STOCK';
  return 'IN_STOCK';
};
