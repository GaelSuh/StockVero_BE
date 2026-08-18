import { prisma } from '../db.js';
import { isQuantityTracked } from '../lib/stock.js';

type PrismaWriteClient =
  | typeof prisma
  | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>
  | any;

interface SaleItemForDeduction {
  categoryId: string;
  quantity: number;
  productName: string;
}

export interface StockConflict {
  categoryId: string;
  productName: string;
  requested: number;
  available: number;
}

/**
 * Deducts sold stock and reports anything that went further than the books said
 * was there.
 *
 * Two phones selling offline can each sell the last unit — neither knew about
 * the other. Both sales are real and both stand; the count floors at zero and
 * the discrepancy is handed back so the owner can be told. Refusing the second
 * sale at sync time would be rewriting something that already happened in the shop.
 */
export async function deductStockForSale(
  tx: PrismaWriteClient,
  items: SaleItemForDeduction[],
  saleNumber: string,
  tenantId: string,
  performedBy: string,
): Promise<StockConflict[]> {
  const conflicts: StockConflict[] = [];
  const lowStock: Array<{ name: string; remaining: number }> = [];
  const logs: any[] = [];

  // One read for the whole cart rather than one per line. Each round trip to a
  // managed database in another region costs real time, and this runs inside a
  // transaction that must not outlive its timeout.
  const categories = await (tx as any).inventoryCategory.findMany({
    where: { id: { in: [...new Set(items.map((i) => i.categoryId))] } },
    select: {
      id: true,
      name: true,
      plannedQty: true,
      quantityOnHand: true,
      stockTrackingMode: true,
      reorderThreshold: true,
    },
  });
  const byId = new Map<string, any>(categories.map((c: any) => [c.id, c]));

  for (const item of items) {
    const category = byId.get(item.categoryId);
    if (!category) continue;

    // Quantity-tracked products hold live stock in quantityOnHand. Serialised ones
    // keep decrementing plannedQty exactly as before.
    const quantityTracked = isQuantityTracked(category);
    const currentStock = quantityTracked ? category.quantityOnHand : category.plannedQty;
    const newStock = currentStock - item.quantity;

    // Sold more than the books held — record it, do not reject it.
    if (newStock < 0) {
      conflicts.push({
        categoryId: category.id,
        productName: item.productName,
        requested: item.quantity,
        available: currentStock,
      });
    }

    const settled = Math.max(0, newStock);

    await (tx as any).inventoryCategory.update({
      where: { id: item.categoryId },
      data: quantityTracked ? { quantityOnHand: settled } : { plannedQty: settled },
    });

    // Two lines can name the same product — two serialised units of one model are
    // two lines. Without this the second line would deduct from the stock the
    // first one already spent.
    if (quantityTracked) category.quantityOnHand = settled;
    else category.plannedQty = settled;

    logs.push({
      tenantId,
      categoryId: item.categoryId,
      eventType: 'SALE_DEDUCTION',
      stockBefore: currentStock,
      stockAfter: settled,
      delta: -item.quantity,
      title: `Sale #${saleNumber} - ${item.productName}`,
      performedBy,
    });

    if (category.reorderThreshold > 0 && newStock <= category.reorderThreshold) {
      lowStock.push({ name: category.name, remaining: settled });
    }
  }

  // Written in one statement instead of one per line.
  if (logs.length > 0) {
    await (tx as any).categoryStockLog.createMany({ data: logs });
  }

  if (lowStock.length > 0) {
    await (tx as any).notification.createMany({
      data: lowStock.map((entry) => ({
        tenantId,
        userId: performedBy,
        userType: 'OWNER',
        type: 'LOW_STOCK_ALERT',
        title: `Low Stock: ${entry.name}`,
        message: `Only ${entry.remaining} units remaining after sale #${saleNumber}`,
      })),
    });
  }

  // One notification for the batch — the owner needs to know a count is wrong,
  // not to be told once per line.
  if (conflicts.length > 0) {
    const detail = conflicts
      .map((c) => `${c.productName} (sold ${c.requested}, ${c.available} on record)`)
      .join('; ');
    await (tx as any).notification.create({
      data: {
        tenantId,
        userId: performedBy,
        userType: 'OWNER',
        type: 'STOCK_CONFLICT',
        title: 'Stock count needs checking',
        message: `Sale #${saleNumber} sold more than the recorded stock: ${detail}. The sale stands — please recount these products.`,
      },
    });
  }

  return conflicts;
}

export async function restoreStockForReturn(
  tx: PrismaWriteClient,
  items: SaleItemForDeduction[],
  returnNumber: string,
  tenantId: string,
  performedBy: string,
): Promise<void> {
  for (const item of items) {
    const category = await (tx as any).inventoryCategory.findUnique({
      where: { id: item.categoryId },
      select: { id: true, plannedQty: true, quantityOnHand: true, stockTrackingMode: true },
    });
    if (!category) continue;

    const quantityTracked = isQuantityTracked(category);
    const currentStock = quantityTracked ? category.quantityOnHand : category.plannedQty;
    const newStock = currentStock + item.quantity;

    await (tx as any).inventoryCategory.update({
      where: { id: item.categoryId },
      data: quantityTracked ? { quantityOnHand: newStock } : { plannedQty: newStock },
    });

    await (tx as any).categoryStockLog.create({
      data: {
        tenantId,
        categoryId: item.categoryId,
        eventType: 'RETURN_RESTORATION',
        stockBefore: currentStock,
        stockAfter: newStock,
        delta: item.quantity,
        title: `Return #${returnNumber} - ${item.productName}`,
        performedBy,
      },
    });
  }
}

export async function validateStockAvailability(
  categoryId: string,
  quantity: number,
): Promise<{ available: boolean; currentStock: number }> {
  const category = await prisma.inventoryCategory.findUnique({
    where: { id: categoryId },
    select: { plannedQty: true, quantityOnHand: true, stockTrackingMode: true },
  });
  if (!category) return { available: false, currentStock: 0 };

  const currentStock = isQuantityTracked(category) ? category.quantityOnHand : category.plannedQty;
  return { available: currentStock >= quantity, currentStock };
}
