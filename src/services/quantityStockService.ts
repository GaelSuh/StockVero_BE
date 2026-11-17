import { prisma } from '../db.js';
import { applyExpense, reverseExpense } from './balanceService.js';

type PrismaWriteClient =
  | typeof prisma
  | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>
  | any;

/**
 * Books the cost of acquiring quantity-tracked stock.
 *
 * Serialised stock already does this per unit through `deductUnitCost`; quantity
 * stock had no equivalent, which is why bulk-imported inventory had no cost basis
 * in Finance at all. There is no setting that turns this off — if stock was
 * bought, the money left.
 */
export async function recordQuantityStockExpense(
  tx: PrismaWriteClient,
  params: {
    tenantId: string;
    categoryId: string;
    categoryName: string;
    amount: number;
    quantity: number;
    note?: string;
  },
): Promise<void> {
  const { tenantId, categoryId, categoryName, amount, quantity, note } = params;
  if (amount <= 0) return;

  await (tx as any).transaction.create({
    data: {
      tenantId,
      type: 'EXPENSE',
      status: 'ACCEPTED',
      amount: amount as any,
      currency: 'XAF',
      description: `Stock acquired: ${quantity} x ${categoryName}`,
      category: 'Stock Purchase',
      moduleRef: 'inventory',
      entityId: categoryId,
      isAutomatic: true,
      notes: note ?? null,
      recordedAt: new Date(),
    },
  });

  // applyExpense, not recordExpense: buying stock is a fact being recorded, not a
  // spend being authorised. A shop stocking up before its first sale has a zero
  // balance, and refusing the import there would be refusing the truth.
  await applyExpense(tenantId, amount, tx);
}

export interface AddQuantityStockParams {
  tx: PrismaWriteClient;
  tenantId: string;
  categoryId: string;
  quantityAdded: number;
  costPrice: number;
  /**
   * False when the user is recording stock they already own (an opening balance
   * or a first-time catalogue import). The stock count still moves; no money is
   * booked, because none left the business today. Defaults to a real purchase.
   */
  isNewPurchase?: boolean;
  categoryName?: string;
  note?: string;
  /** Device-generated id, when this movement was recorded offline. */
  offlineId?: string;
  /**
   * Which option the stock is for. Credits that variant's own counter instead
   * of the parent product's — the same "variant if present, else the parent"
   * split deductStockForSale and availableFor already make. Null/absent keeps
   * the original category-level behaviour exactly.
   */
  variantId?: string | null;
}

/**
 * The single entry point for increasing quantity-tracked stock. Every surface
 * that adds stock — product creation, bulk import, restock — goes through here so
 * the count and the ledger can never drift apart.
 */
export async function addQuantityStock({
  tx,
  tenantId,
  categoryId,
  quantityAdded,
  costPrice,
  isNewPurchase = true,
  categoryName,
  note,
  offlineId,
  variantId,
}: AddQuantityStockParams): Promise<void> {
  if (quantityAdded <= 0) return;

  // A replayed sync must not receive the same delivery twice.
  if (offlineId) {
    const already = await (tx as any).categoryStockLog.findFirst({
      where: { tenantId, offlineId },
      select: { id: true },
    });
    if (already) return;
  }

  // The variant arrives from a device payload, so it is checked rather than
  // trusted: one belonging to another product (or another tenant) would credit
  // stock to an option this product does not sell, where no stock read would
  // ever find it again.
  let variant: { id: string; label: string; quantityOnHand: number } | null = null;
  if (variantId) {
    variant = await (tx as any).productVariant.findFirst({
      where: { id: variantId, tenantId, categoryId },
      select: { id: true, label: true, quantityOnHand: true },
    });
    if (!variant) {
      throw new Error('That variant does not belong to this product.');
    }
  }

  // Only one of the two counters moves. A variant's stock is its own; adding
  // to the parent as well would double-count the same delivery.
  const updated = await (tx as any).inventoryCategory.update({
    where: { id: categoryId },
    data: variant ? {} : { quantityOnHand: { increment: quantityAdded } },
    select: { id: true, name: true, quantityOnHand: true },
  });

  let stockAfter = updated.quantityOnHand;
  if (variant) {
    const updatedVariant = await (tx as any).productVariant.update({
      where: { id: variant.id },
      data: { quantityOnHand: { increment: quantityAdded } },
      select: { quantityOnHand: true },
    });
    stockAfter = updatedVariant.quantityOnHand;
  }

  const label = variant ? `${updated.name} (${variant.label})` : updated.name;

  await (tx as any).categoryStockLog.create({
    data: {
      tenantId,
      categoryId,
      // So the product's stock history shows which option each delivery was
      // for, rather than a run of identical-looking rows.
      variantId: variant?.id ?? null,
      eventType: isNewPurchase ? 'STOCK_PURCHASE' : 'OPENING_STOCK',
      stockBefore: stockAfter - quantityAdded,
      stockAfter,
      delta: quantityAdded,
      title: isNewPurchase
        ? `Stock purchased — ${quantityAdded} unit(s)${variant ? ` · ${variant.label}` : ''}`
        : `Opening stock recorded — ${quantityAdded} unit(s)${variant ? ` · ${variant.label}` : ''}`,
      notes: note ?? null,
      offlineId: offlineId ?? null,
    },
  });

  if (!isNewPurchase) return;

  await recordQuantityStockExpense(tx, {
    tenantId,
    categoryId,
    // The expense is against the product — money does not belong to an option
    // — but the name says which one was bought so the ledger line is readable.
    categoryName: categoryName ?? label,
    amount: costPrice * quantityAdded,
    quantity: quantityAdded,
    note,
  });
}

// ── Editing the quantity at hand ───────────────────────────────────────────────

/** Why a product's quantity can't be edited, or null when it can. */
export type QuantityEditBlock = 'HAS_SALES' | 'HAS_VARIANTS' | 'NOT_QUANTITY';
/** How the stock came in: bought (the expense follows the edit), already owned (no money), or no stock yet. */
export type QuantityEditMode = 'PURCHASED' | 'OWNED' | 'UNKNOWN';

/**
 * Whether the quantity at hand can be typed in on Edit product, and what an edit
 * does to Finance. Allowed only before the first sale: after that the count is
 * the result of sales and returns, and overwriting it would hide them. Products
 * with variants are edited per variant; serialized products by their units.
 */
export async function quantityEditStatus(
  client: PrismaWriteClient,
  tenantId: string,
  categoryId: string,
): Promise<{ block: QuantityEditBlock | null; mode: QuantityEditMode }> {
  const product = await (client as any).inventoryCategory.findFirst({
    where: { id: categoryId, tenantId },
    select: { stockTrackingMode: true, _count: { select: { variants: true } } },
  });
  const lastStockIn = await (client as any).categoryStockLog.findFirst({
    where: { tenantId, categoryId, eventType: { in: ['STOCK_PURCHASE', 'OPENING_STOCK'] } },
    orderBy: { createdAt: 'desc' },
    select: { eventType: true },
  });
  const mode: QuantityEditMode = !lastStockIn ? 'UNKNOWN' : lastStockIn.eventType === 'STOCK_PURCHASE' ? 'PURCHASED' : 'OWNED';

  if (!product || product.stockTrackingMode !== 'QUANTITY') return { block: 'NOT_QUANTITY', mode };
  if (product._count.variants > 0) return { block: 'HAS_VARIANTS', mode };
  const sold = await (client as any).saleItem.count({ where: { categoryId, sale: { tenantId } } });
  return { block: sold > 0 ? 'HAS_SALES' : null, mode };
}

export class QuantityEditError extends Error {
  constructor(public block: QuantityEditBlock) {
    super(
      block === 'HAS_SALES'
        ? 'This product has sales, so its quantity can no longer be edited. Use Receive stock or the Stock status tab instead.'
        : block === 'HAS_VARIANTS'
          ? "This product has variants: edit each variant's quantity in the Variants tab."
          : 'Only products counted by quantity have a quantity to edit; serialized products are counted by their units.',
    );
  }
}

/**
 * Sets a product's quantity at hand, before its first sale. Bought stock keeps
 * Finance in step: the latest purchase expense is corrected by the difference
 * at the cost price (raising books more, lowering gives it back). Stock already
 * owned moves no money. Either way the change is written to the stock history.
 * `isNewPurchase` is only read when the product has no stock history yet.
 */
export async function editQuantityOnHand(
  tx: PrismaWriteClient,
  params: { tenantId: string; categoryId: string; quantity: number; isNewPurchase?: boolean; userId?: string | null },
): Promise<{ delta: number; expenseChange: number }> {
  const { tenantId, categoryId, quantity, userId } = params;
  if (!Number.isInteger(quantity) || quantity < 0) throw new Error('The quantity must be a whole number, 0 or more.');

  const status = await quantityEditStatus(tx, tenantId, categoryId);
  if (status.block) throw new QuantityEditError(status.block);

  const product = await (tx as any).inventoryCategory.findUnique({
    where: { id: categoryId },
    select: { name: true, quantityOnHand: true, costPrice: true },
  });
  const delta = quantity - (product.quantityOnHand ?? 0);
  if (delta === 0) return { delta: 0, expenseChange: 0 };

  // Conditional on the count just read: an edit racing another stock change fails instead of overwriting it.
  const moved = await (tx as any).inventoryCategory.updateMany({
    where: { id: categoryId, tenantId, quantityOnHand: product.quantityOnHand },
    data: { quantityOnHand: quantity },
  });
  if (moved.count === 0) throw new Error('The stock changed while you were editing. Reload the product and try again.');

  const purchased = status.mode === 'PURCHASED' || (status.mode === 'UNKNOWN' && (params.isNewPurchase ?? true));
  await (tx as any).categoryStockLog.create({
    data: {
      tenantId,
      categoryId,
      eventType: 'QUANTITY_EDITED',
      stockBefore: product.quantityOnHand ?? 0,
      stockAfter: quantity,
      delta,
      title: `Quantity edited: ${product.quantityOnHand ?? 0} → ${quantity}${purchased ? '' : ' (stock already owned, no expense)'}`,
      performedBy: userId ?? null,
    },
  });
  if (!purchased) return { delta, expenseChange: 0 };

  const cost = Number(product.costPrice ?? 0);
  const change = Math.abs(delta) * cost;
  if (change === 0) return { delta, expenseChange: 0 };

  const purchase = await (tx as any).transaction.findFirst({
    where: { tenantId, entityId: categoryId, moduleRef: 'inventory', category: 'Stock Purchase', type: 'EXPENSE', status: 'ACCEPTED' },
    orderBy: { recordedAt: 'desc' },
    select: { id: true, amount: true, description: true },
  });
  // The purchase line says how many were bought; keep that number true.
  const relabel = (description: string) =>
    description.replace(/^Stock acquired: (\d+) x /, (_m, n) => `Stock acquired: ${Math.max(0, Number(n) + delta)} x `);

  if (delta > 0) {
    if (purchase) {
      await (tx as any).transaction.update({
        where: { id: purchase.id },
        data: { amount: Number(purchase.amount) + change, description: relabel(purchase.description) },
      });
      await applyExpense(tenantId, change, tx);
    } else {
      await recordQuantityStockExpense(tx, { tenantId, categoryId, categoryName: product.name, amount: change, quantity: delta });
    }
    return { delta, expenseChange: change };
  }

  // Lowering: give back at most what the purchase line holds.
  if (!purchase) return { delta, expenseChange: 0 };
  const refund = Math.min(change, Number(purchase.amount));
  const left = Number(purchase.amount) - refund;
  if (left > 0) {
    await (tx as any).transaction.update({
      where: { id: purchase.id },
      data: { amount: left, description: relabel(purchase.description) },
    });
  } else {
    await (tx as any).transaction.delete({ where: { id: purchase.id } });
  }
  await reverseExpense(tenantId, refund, tx);
  return { delta, expenseChange: -refund };
}
