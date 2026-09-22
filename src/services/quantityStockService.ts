import { prisma } from '../db.js';
import { applyExpense } from './balanceService.js';

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
