import { prisma } from '../db.js';
/** Where a resolved price came from — useful when a price needs explaining. */
export type PriceSource = 'CUSTOMER_LIST' | 'DEFAULT_LIST' | 'PRODUCT' | 'VARIANT';
export interface ResolvedPrice {
    unitPrice: number;
    source: PriceSource;
    priceListId?: string;
    priceListName?: string;
    /**
     * Set whenever a variantId was given, regardless of which tier the price
     * itself came from — callers snapshot SaleItem.variantLabel from this
     * without a second DB round trip.
     */
    variantLabel?: string;
}
/** Either the global Prisma client or a `tx` handed in from `prisma.$transaction`. */
type PrismaLike = typeof prisma;
/**
 * Works out what one unit of a product (optionally, one specific variant of
 * it) costs this customer at this quantity. Six tiers, most specific first —
 * see priceResolutionService's earlier revisions for the full cascade
 * rationale; unchanged here except for accepting a caller-supplied client so
 * this can run inside a `prisma.$transaction` instead of always hitting the
 * pool directly.
 */
export declare function resolvePriceDetailed(tenantId: string, categoryId: string, customerId: string | null, quantity: number, variantId?: string | null, client?: PrismaLike): Promise<ResolvedPrice>;
/** Price only, for callers that do not care where it came from. */
export declare function resolvePrice(tenantId: string, categoryId: string, customerId: string | null, quantity: number, variantId?: string | null, client?: PrismaLike): Promise<number>;
export interface PriceLineRequest {
    categoryId: string;
    quantity: number;
    variantId?: string | null;
}
/**
 * Same 6-tier cascade as resolvePriceDetailed, batched for a whole sale
 * instead of called once per line. A cart with N lines used to run up to 3
 * queries per line inside the sale's transaction (customer list, default
 * list, variant) — on a 20-line cart against a pooled Neon connection,
 * ~60 round trips inside one transaction with a 30s timeout. This issues a
 * fixed number of queries regardless of line count: the customer's price
 * list (all its rules for the categories on this sale), the tenant's
 * default list (same), every distinct variant in one batch, and every
 * distinct category in one batch — then resolves each line in memory.
 *
 * Measured 6 queries, not the 4 statements below might suggest: Prisma
 * splits a nested `include` into one query per relation level, so each
 * price-list read costs 2-3. The number that matters is that it does not
 * grow with the cart — measured 6 queries at 2, 10 and 40 lines, against
 * 12 / 60 / 240 for the per-line version this replaced.
 *
 * Pass `tx` here when calling from inside `prisma.$transaction` — resolving
 * prices on the global client while the surrounding writes go through `tx`
 * meant the price read wasn't part of the same transaction/snapshot as the
 * sale it was priced for.
 */
export declare function resolvePricesForSale(tenantId: string, customerId: string | null, lines: PriceLineRequest[], client?: PrismaLike): Promise<ResolvedPrice[]>;
export {};
