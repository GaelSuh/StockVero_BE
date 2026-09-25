import { prisma } from '../db.js';
type PrismaWriteClient = typeof prisma | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'> | any;
interface SaleItemForDeduction {
    categoryId: string;
    quantity: number;
    productName: string;
    /** The specific serialized unit the cashier picked, if any. */
    unitId?: string | null;
    /**
     * Which variant this line is for. Null/undefined = the product has no
     * variants, or this line predates variants — unchanged category-level
     * behaviour either way.
     */
    variantId?: string | null;
}
interface ReturnItemForRestoration {
    categoryId: string;
    quantity: number;
    productName: string;
    /**
     * Exactly which units this return is giving back — resolved by the caller
     * from the original sale's own SaleItem.productItemId, never guessed here.
     * Empty/absent for a serialized category means "no unit reference on
     * record for this line" (a sale from before units were tracked per line) —
     * stock is intentionally left untouched rather than restoring whichever
     * unit happens to be oldest.
     */
    unitIds?: string[];
    /**
     * The same variant this line was originally sold under — resolved by the
     * caller from the original SaleItem.variantId, never guessed here.
     */
    variantId?: string | null;
}
/** Thrown to abort the sale transaction outright — nothing gets sold on credit
 * against stock that isn't there. Caught in the controller and reported as a
 * plain 400, not a server error. */
export declare class InsufficientStockError extends Error {
    readonly items: Array<{
        productName: string;
        requested: number;
        available: number;
    }>;
    constructor(items: Array<{
        productName: string;
        requested: number;
        available: number;
    }>);
}
export interface DeductStockResult {
    /**
     * Which ProductItem (if any) actually got marked DEPLOYED for each input item,
     * same order as `items` — so the caller can stamp it onto the SaleItem row
     * that was created for that line.
     */
    soldUnitIds: (string | null)[];
}
/**
 * Deducts sold stock. Rejects (throws InsufficientStockError, rolling back the
 * whole sale) rather than letting a count go negative — a shop only ever has
 * one till per account, so there is no legitimate race to make room for.
 */
export declare function deductStockForSale(tx: PrismaWriteClient, items: SaleItemForDeduction[], saleNumber: string, tenantId: string, performedBy: string): Promise<DeductStockResult>;
export interface RestoreStockResult {
    /** Serialized lines that had no unit reference to restore against — stock
     * was left untouched for these rather than guessed. */
    skipped: Array<{
        categoryId: string;
        productName: string;
    }>;
}
export declare function restoreStockForReturn(tx: PrismaWriteClient, items: ReturnItemForRestoration[], returnNumber: string, tenantId: string, performedBy: string): Promise<RestoreStockResult>;
/**
 * Live stock for one product, or for one variant of it — the same rule
 * deductStockForSale enforces.
 *
 * Note the deliberate difference from the deduction path: omitting variantId
 * here counts every unit of the product across all its variants, because the
 * question being asked is "does this product have N available". The deduction
 * path instead matches variantId exactly, because there it must consume from
 * the same bucket its pre-check counted.
 */
export declare function validateStockAvailability(categoryId: string, quantity: number, variantId?: string | null): Promise<{
    available: boolean;
    currentStock: number;
}>;
export {};
