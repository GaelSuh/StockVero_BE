/**
 * The stock pool of a quantity product with variants. Shared by the variant
 * create, generate, edit and delete paths in variants.controller.ts.
 */

/** Thrown by shareOutStock when the pool is too small; caught to produce a 400. */
export class VariantQuantityCeilingError extends Error {}

/**
 * For a QUANTITY-tracked product with variants, the product's own
 * quantityOnHand is the stock NOT YET SHARED OUT to a variant (the pool).
 * Restocking the product adds to the pool; giving a variant stock moves it
 * out of the pool; lowering or deleting a variant moves it back. Sales,
 * returns, variant restocks and condition moves touch only the variant, so
 * none of them need to know about this. Product total = pool + variants.
 *
 * `delta` is the change to the variant's quantity: positive takes from the
 * pool (refused when the pool is too small), negative gives back to it.
 * SERIALIZED products are untouched: their variants carry no quantity.
 */
export async function shareOutStock(
  tx: any,
  tenantId: string,
  category: { id: string; stockTrackingMode: string },
  delta: number,
): Promise<void> {
  if (category.stockTrackingMode !== 'QUANTITY' || delta === 0) return;

  if (delta < 0) {
    await tx.inventoryCategory.update({
      where: { id: category.id },
      data: { quantityOnHand: { increment: -delta } },
    });
    return;
  }

  // Conditional decrement: two people sharing out at once can never take the
  // same units, and the pool can never go below zero.
  const taken = await tx.inventoryCategory.updateMany({
    where: { id: category.id, tenantId, quantityOnHand: { gte: delta } },
    data: { quantityOnHand: { decrement: delta } },
  });
  if (taken.count === 0) {
    const pool = await tx.inventoryCategory.findUnique({
      where: { id: category.id },
      select: { quantityOnHand: true },
    });
    const room = Math.max(pool?.quantityOnHand ?? 0, 0);
    throw new VariantQuantityCeilingError(
      `Only ${room} unit(s) are waiting to be shared out to variants. ` +
        `Restock the product to add more, or lower this quantity.`,
    );
  }
}
