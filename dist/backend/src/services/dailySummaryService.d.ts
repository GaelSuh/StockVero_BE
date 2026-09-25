/**
 * What the daily summary endpoint returns.
 *
 * The persisted `daily_summaries` row is deliberately not this shape: it is keyed
 * on (tenantId, date) alone, so it can only ever hold one figure per day for the
 * whole tenant. Retail and wholesale are reported separately, which is why a
 * mode-filtered request is computed and never written back — see getDailySummary.
 */
export interface DailySummaryResult {
    date: string;
    mode: string | null;
    totalSales: number;
    itemsSold: number;
    totalRevenue: number;
    averageTransaction: number;
    /** Money actually taken, split by how it arrived. */
    cashTotal: number;
    mobileMoneyTotal: number;
    cardTotal: number;
    bankTransferTotal: number;
    otherTotal: number;
    totalCollected: number;
    /** Billed but not yet paid — owed to the business, not collected. */
    creditTotal: number;
    returnsTotal: number;
    /** Revenue less refunds: what the day was actually worth. */
    netRevenue: number;
}
/**
 * Computes the summary for a day, optionally for one sales mode.
 *
 * Every payment method is accounted for. The previous switch handled only CASH,
 * the two mobile-money methods and CARD, so bank transfers and anything filed as
 * OTHER silently vanished from the breakdown while still counting toward revenue.
 */
export declare function computeDailySummary(tenantId: string, date: Date, mode?: string): Promise<DailySummaryResult>;
/**
 * Computes the day and writes it to `daily_summaries`.
 *
 * Only meaningful tenant-wide: the table is unique on (tenantId, date), so
 * storing a mode-filtered figure would overwrite the other mode's.
 */
export declare function generateDailySummary(tenantId: string, date: Date, mode?: string): Promise<DailySummaryResult>;
/**
 * Reads the summary for a day.
 *
 * Always computed rather than read back from the stored row: the row cannot
 * represent a single mode, and a cached figure for "today" goes stale the moment
 * the next sale lands.
 */
export declare function getDailySummary(tenantId: string, date: Date, mode?: string): Promise<DailySummaryResult>;
