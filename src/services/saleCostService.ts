import { prisma } from '../db.js';

/**
 * Cost of goods sold, per sale line.
 *
 * Every new sale line snapshots the product's costPrice (costSource SALE), so a
 * later price edit cannot rewrite past profit. Lines sold before that existed
 * are filled once by `backfillSaleItemCosts`, from the purchases actually
 * recorded before each sale, and only fall back to today's costPrice when the
 * product has no purchase history at all.
 */

export type CostSource = 'SALE' | 'PURCHASE_HISTORY' | 'CURRENT_PRICE';

type Client = typeof prisma | any;

/** costPrice for each product, read inside the caller's transaction. */
export async function currentUnitCosts(
  client: Client,
  tenantId: string,
  categoryIds: string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(categoryIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await client.inventoryCategory.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, costPrice: true },
  });
  return new Map(rows.map((r: any) => [r.id, Number(r.costPrice ?? 0)]));
}

/** The two SaleItem fields to spread into a create payload. */
export const costFields = (costs: Map<string, number>, categoryId: string) => ({
  unitCost: costs.get(categoryId) ?? 0,
  costSource: 'SALE' as CostSource,
});

// ── Backfill ──────────────────────────────────────────────────────────────────

interface Purchase { at: number; qty: number; amount: number }

const QTY_PURCHASE = /^Stock acquired: (\d+) x /;
const UNIT_PURCHASE = /^Unit received: (.+)$/;

/**
 * Every recorded stock purchase per product. Quantity stock books one expense
 * per purchase ("Stock acquired: 12 x Name", entityId = product); serialised
 * stock books one per unit ("Unit received: Name"), linked to the product
 * through its purchase invoice, or by name when it has none.
 */
async function purchaseHistory(tenantId: string): Promise<Map<string, Purchase[]>> {
  const [expenses, products] = await Promise.all([
    (prisma as any).transaction.findMany({
      where: { tenantId, type: 'EXPENSE', status: 'ACCEPTED', category: 'Stock Purchase' },
      select: { amount: true, recordedAt: true, entityId: true, invoiceId: true, description: true },
    }),
    (prisma as any).inventoryCategory.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ]);

  const invoiceIds = [...new Set(expenses.map((e: any) => e.invoiceId).filter(Boolean))] as string[];
  const invoices = invoiceIds.length
    ? await (prisma as any).invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, categoryId: true } })
    : [];
  const productOfInvoice = new Map<string, string>(invoices.map((i: any) => [i.id, i.categoryId]));

  // A name only identifies a product when no other product shares it.
  const byName = new Map<string, string | null>();
  for (const p of products) byName.set(p.name, byName.has(p.name) ? null : p.id);

  const history = new Map<string, Purchase[]>();
  for (const e of expenses) {
    const amount = Number(e.amount);
    if (!(amount > 0)) continue;

    let productId: string | null | undefined;
    let qty = 1;
    const qtyMatch = QTY_PURCHASE.exec(e.description ?? '');
    if (e.entityId && qtyMatch) {
      productId = e.entityId;
      qty = Number(qtyMatch[1]);
    } else if (e.invoiceId && productOfInvoice.has(e.invoiceId)) {
      productId = productOfInvoice.get(e.invoiceId);
    } else {
      const unitMatch = UNIT_PURCHASE.exec(e.description ?? '');
      productId = unitMatch ? byName.get(unitMatch[1]) : null;
    }
    if (!productId || !(qty > 0)) continue;

    const list = history.get(productId) ?? [];
    list.push({ at: new Date(e.recordedAt).getTime(), qty, amount });
    history.set(productId, list);
  }
  for (const list of history.values()) list.sort((a, b) => a.at - b.at);
  return history;
}

/**
 * Weighted average unit cost of everything bought up to `at`, or null if
 * nothing was bought before then.
 * ponytail: weighted average over all earlier purchases, not FIFO layers;
 * exact when a product's buy price is stable, close otherwise.
 */
export function averageCostAt(purchases: Purchase[] | undefined, at: number): number | null {
  if (!purchases) return null;
  let qty = 0;
  let amount = 0;
  for (const p of purchases) {
    if (p.at > at) break;
    qty += p.qty;
    amount += p.amount;
  }
  return qty > 0 ? Math.round((amount / qty) * 100) / 100 : null;
}

export interface BackfillResult {
  tenants: number;
  lines: number;
  fromHistory: number;
  fromCurrentPrice: number;
}

/** Fills unitCost on every sale line that has none. Safe to re-run. */
export async function backfillSaleItemCosts(opts: { tenantId?: string; dryRun?: boolean } = {}): Promise<BackfillResult> {
  const tenantRows = await (prisma as any).saleItem.findMany({
    where: { unitCost: null, ...(opts.tenantId ? { sale: { tenantId: opts.tenantId } } : {}) },
    select: { sale: { select: { tenantId: true } } },
    distinct: ['saleId'],
  });
  const tenantIds = [...new Set(tenantRows.map((r: any) => r.sale.tenantId))] as string[];
  const result: BackfillResult = { tenants: tenantIds.length, lines: 0, fromHistory: 0, fromCurrentPrice: 0 };

  for (const tenantId of tenantIds) {
    const [history, lines] = await Promise.all([
      purchaseHistory(tenantId),
      (prisma as any).saleItem.findMany({
        where: { unitCost: null, sale: { tenantId } },
        select: { id: true, categoryId: true, sale: { select: { createdAt: true } } },
      }),
    ]);
    const current = await currentUnitCosts(prisma, tenantId, lines.map((l: any) => l.categoryId));

    const updates = lines.map((line: any) => {
      const fromHistory = averageCostAt(history.get(line.categoryId), new Date(line.sale.createdAt).getTime());
      const source: CostSource = fromHistory === null ? 'CURRENT_PRICE' : 'PURCHASE_HISTORY';
      if (source === 'PURCHASE_HISTORY') result.fromHistory += 1;
      else result.fromCurrentPrice += 1;
      return { id: line.id, unitCost: fromHistory ?? current.get(line.categoryId) ?? 0, costSource: source };
    });
    result.lines += updates.length;

    if (opts.dryRun) continue;
    // One updateMany per distinct (cost, source): few round trips, and each is
    // atomic on its own, so an interrupted run just leaves rows for the next one.
    const groups = new Map<string, { unitCost: number; costSource: CostSource; ids: string[] }>();
    for (const u of updates) {
      const key = `${u.unitCost}|${u.costSource}`;
      const g = groups.get(key) ?? { unitCost: u.unitCost, costSource: u.costSource, ids: [] as string[] };
      g.ids.push(u.id);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      await (prisma as any).saleItem.updateMany({
        where: { id: { in: g.ids }, unitCost: null },
        data: { unitCost: g.unitCost, costSource: g.costSource },
      });
    }
  }
  return result;
}
