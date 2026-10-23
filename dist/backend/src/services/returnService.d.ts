interface ReturnItemInput {
    categoryId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    /**
     * Which option is coming back. Supplied by the caller from the original
     * sale line — never guessed here. Null means the product has no variants.
     */
    variantId?: string | null;
}
/** Goods handed over in place of what came back. */
interface ExchangeItemInput extends ReturnItemInput {
    sku?: string | null;
}
export declare class ReturnValidationError extends Error {
    constructor(message: string);
}
/**
 * Records a return against a sale.
 *
 * REFUND  — goods come back, stock is restored, money goes out (or the debt
 *           shrinks, if the customer never paid).
 * EXCHANGE — goods come back and replacement goods go out. The replacement is
 *           raised as a normal linked sale so it deducts stock, prices, and
 *           reports exactly like any other sale, rather than being a second
 *           half-implemented path through this file. Only the difference in
 *           value is settled.
 */
export declare function processReturn(tenantId: string, saleId: string, input: {
    reason: string;
    returnType: 'REFUND' | 'EXCHANGE';
    items: ReturnItemInput[];
    exchangeItems?: ExchangeItemInput[];
    refundMethod?: string;
    processedById: string;
    processedByName: string;
}): Promise<any>;
export {};
