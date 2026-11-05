import { isQuantityTracked } from '../lib/stock.js';

/**
 * The condition of stock: GOOD can be sold; FAULTY is set aside and may be
 * repaired; DAMAGED is unusable. Serialized units carry it as their status;
 * quantity products keep one count per condition (quantityOnHand is GOOD).
 */
export type StockCondition = 'GOOD' | 'FAULTY' | 'DAMAGED';

export const STOCK_CONDITIONS: StockCondition[] = ['GOOD', 'FAULTY', 'DAMAGED'];

/** Anything missing or unknown counts as GOOD, the shop's default. */
export const parseCondition = (value: unknown): StockCondition =>
  value === 'FAULTY' || value === 'DAMAGED' ? value : 'GOOD';

/** The ProductItem.stockStatus a serialized unit gets for each condition. */
export const UNIT_STATUS: Record<StockCondition, 'AVAILABLE' | 'FAULTY' | 'COMPLETELY_BAD'> = {
  GOOD: 'AVAILABLE',
  FAULTY: 'FAULTY',
  DAMAGED: 'COMPLETELY_BAD',
};

/** The quantity column holding each condition, on a product or a variant. */
export const QUANTITY_FIELD: Record<StockCondition, 'quantityOnHand' | 'quantityFaulty' | 'quantityDamaged'> = {
  GOOD: 'quantityOnHand',
  FAULTY: 'quantityFaulty',
  DAMAGED: 'quantityDamaged',
};

export class StockConditionError extends Error {}

type QuantityField = 'quantityOnHand' | 'quantityFaulty' | 'quantityDamaged';

/**
 * Takes `quantity` off one stock count only if at least that much is there,
 * checked by Postgres on the row at write time. Two tills, or two phones syncing
 * at once, can never both spend the same stock or push a count below 0.
 * Returns the count after, or null when there was not enough (nothing changed).
 * The database CHECK constraints (migration 20261021000000) are the backstop.
 */
export async function decrementIfAvailable(
  tx: any,
  model: 'inventoryCategory' | 'productVariant',
  id: string,
  field: QuantityField,
  quantity: number,
): Promise<number | null> {
  try {
    const row = await tx[model].update({
      where: { id, [field]: { gte: quantity } },
      data: { [field]: { decrement: quantity } },
      select: { [field]: true },
    });
    return Number(row[field]);
  } catch (error: any) {
    if (error?.code === 'P2025') return null; // no row matched: not enough stock
    throw error;
  }
}

interface MoveInput {
  tenantId: string;
  categoryId: string;
  variantId?: string | null;
  from: StockCondition;
  to: StockCondition;
  quantity: number;
  reason?: string | null;
  performedBy?: string | null;
}

/**
 * Moves part of a quantity product's stock between conditions: shelf stock
 * found broken (GOOD → FAULTY), a repair (FAULTY → GOOD), a write-off
 * (FAULTY → DAMAGED). The total never changes, only where it sits; the move is
 * written to the stock history with the sellable count before and after.
 */
export async function moveStockCondition(tx: any, input: MoveInput) {
  const { tenantId, categoryId, from, to, quantity } = input;
  if (from === to) throw new StockConditionError('Choose two different conditions.');
  if (!Number.isInteger(quantity) || quantity <= 0) throw new StockConditionError('The quantity must be a whole number above 0.');

  const product = await tx.inventoryCategory.findFirst({
    where: { id: categoryId, tenantId },
    select: { id: true, name: true, stockTrackingMode: true, quantityOnHand: true, quantityFaulty: true, quantityDamaged: true },
  });
  if (!product) throw new StockConditionError('Product not found.');
  if (!isQuantityTracked(product)) {
    throw new StockConditionError('Items tracked one by one change condition on the unit itself.');
  }

  const variant = input.variantId
    ? await tx.productVariant.findFirst({
        where: { id: input.variantId, categoryId },
        select: { id: true, label: true, quantityOnHand: true, quantityFaulty: true, quantityDamaged: true },
      })
    : null;
  if (input.variantId && !variant) throw new StockConditionError('Variant not found.');

  const holder = variant ?? product;
  const available = Number(holder[QUANTITY_FIELD[from]] ?? 0);
  if (quantity > available) {
    throw new StockConditionError(`Only ${available} ${from.toLowerCase()} in stock.`);
  }

  // The count read above can be stale by now (another move or a sale), so the
  // take itself is conditional; the add only happens once the take succeeded.
  const model = variant ? 'productVariant' : 'inventoryCategory';
  const holderId = variant ? variant.id : product.id;
  const left = await decrementIfAvailable(tx, model, holderId, QUANTITY_FIELD[from], quantity);
  if (left === null) {
    throw new StockConditionError(`Not enough ${from.toLowerCase()} stock left to move ${quantity}.`);
  }
  const updated = await tx[model].update({
    where: { id: holderId },
    data: { [QUANTITY_FIELD[to]]: { increment: quantity } },
    select: { quantityOnHand: true, quantityFaulty: true, quantityDamaged: true },
  });

  const sellableDelta = to === 'GOOD' ? quantity : from === 'GOOD' ? -quantity : 0;
  const sellableBefore = Number(updated.quantityOnHand) - sellableDelta;
  await tx.categoryStockLog.create({
    data: {
      tenantId,
      categoryId,
      variantId: variant?.id ?? null,
      eventType: to === 'GOOD' ? 'CONDITION_RESTORED' : to === 'FAULTY' ? 'MARKED_FAULTY' : 'MARKED_DAMAGED',
      stockBefore: sellableBefore,
      stockAfter: Number(updated.quantityOnHand),
      delta: Number(updated.quantityOnHand) - sellableBefore,
      title: `${quantity} × ${product.name}${variant?.label ? ` (${variant.label})` : ''}: ${from.toLowerCase()} → ${to.toLowerCase()}${input.reason ? ` — ${input.reason}` : ''}`,
      performedBy: input.performedBy ?? null,
    },
  });

  return { product, variant, counts: updated };
}
