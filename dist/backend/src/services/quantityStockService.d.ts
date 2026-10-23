import { prisma } from '../db.js';
type PrismaWriteClient = typeof prisma | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'> | any;
/**
 * Books the cost of acquiring quantity-tracked stock.
 *
 * Serialised stock already does this per unit through `deductUnitCost`; quantity
 * stock had no equivalent, which is why bulk-imported inventory had no cost basis
 * in Finance at all. There is no setting that turns this off — if stock was
 * bought, the money left.
 */
export declare function recordQuantityStockExpense(tx: PrismaWriteClient, params: {
    tenantId: string;
    categoryId: string;
    categoryName: string;
    amount: number;
    quantity: number;
    note?: string;
}): Promise<void>;
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
export declare function addQuantityStock({ tx, tenantId, categoryId, quantityAdded, costPrice, isNewPurchase, categoryName, note, offlineId, variantId, }: AddQuantityStockParams): Promise<void>;
export {};
