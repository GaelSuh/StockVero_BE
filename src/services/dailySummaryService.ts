import { prisma } from '../db.js';

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

const toNumber = (value: unknown): number => Number(value ?? 0);

/**
 * Formats a local calendar date as YYYY-MM-DD.
 *
 * Not toISOString(): the day boundaries are local midnights, and converting one
 * back through UTC lands on the previous day for any timezone ahead of it — so
 * a summary for the 16th reported itself as the 15th.
 */
const toLocalDateString = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Computes the summary for a day, optionally for one sales mode.
 *
 * Every payment method is accounted for. The previous switch handled only CASH,
 * the two mobile-money methods and CARD, so bank transfers and anything filed as
 * OTHER silently vanished from the breakdown while still counting toward revenue.
 */
export async function computeDailySummary(
  tenantId: string,
  date: Date,
  mode?: string,
): Promise<DailySummaryResult> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const whereClause: any = {
    tenantId,
    status: { in: ['COMPLETED', 'PARTIAL'] },
    createdAt: { gte: startOfDay, lte: endOfDay },
  };
  if (mode) whereClause.mode = mode;

  const [sales, returns] = await Promise.all([
    prisma.sale.findMany({
      where: whereClause,
      include: { payments: true, items: { select: { quantity: true } } },
    }),
    prisma.saleReturn.findMany({
      where: {
        tenantId,
        createdAt: { gte: startOfDay, lte: endOfDay },
        // A return belongs to the mode of the sale it came from; without this a
        // wholesale refund was subtracted from the retail day and vice versa.
        ...(mode ? { sale: { mode: mode as any } } : {}),
      },
      select: { refundAmount: true },
    }),
  ]);

  let cashTotal = 0;
  let mobileMoneyTotal = 0;
  let cardTotal = 0;
  let bankTransferTotal = 0;
  let otherTotal = 0;
  let creditTotal = 0;
  let itemsSold = 0;

  for (const sale of sales) {
    creditTotal += toNumber(sale.amountOwed);
    for (const item of sale.items) itemsSold += item.quantity ?? 0;

    for (const payment of sale.payments) {
      const amount = toNumber(payment.amount);
      switch (payment.method) {
        case 'CASH':
          cashTotal += amount;
          break;
        case 'MTN_MOMO':
        case 'ORANGE_MONEY':
          mobileMoneyTotal += amount;
          break;
        case 'CARD':
          cardTotal += amount;
          break;
        case 'BANK_TRANSFER':
          bankTransferTotal += amount;
          break;
        default:
          // OTHER, plus anything added to the enum later — counted rather than
          // dropped, so the breakdown always reconciles with totalCollected.
          otherTotal += amount;
          break;
      }
    }
  }

  const totalRevenue = sales.reduce((sum, s) => sum + toNumber(s.totalAmount), 0);
  const returnsTotal = returns.reduce((sum, r) => sum + toNumber(r.refundAmount), 0);
  const totalCollected =
    cashTotal + mobileMoneyTotal + cardTotal + bankTransferTotal + otherTotal;

  return {
    date: toLocalDateString(startOfDay),
    mode: mode ?? null,
    totalSales: sales.length,
    itemsSold,
    totalRevenue,
    averageTransaction: sales.length ? totalRevenue / sales.length : 0,
    cashTotal,
    mobileMoneyTotal,
    cardTotal,
    bankTransferTotal,
    otherTotal,
    totalCollected,
    creditTotal,
    returnsTotal,
    netRevenue: totalRevenue - returnsTotal,
  };
}

/**
 * Computes the day and writes it to `daily_summaries`.
 *
 * Only meaningful tenant-wide: the table is unique on (tenantId, date), so
 * storing a mode-filtered figure would overwrite the other mode's.
 */
export async function generateDailySummary(tenantId: string, date: Date, mode?: string) {
  const result = await computeDailySummary(tenantId, date, mode);
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  if (mode) return result;

  const row = {
    totalSales: result.totalSales,
    totalRevenue: result.totalRevenue,
    cashCollected: result.cashTotal,
    mobileMoneyCollected: result.mobileMoneyTotal,
    // Bank transfers used to be dropped entirely; the stored column has no home
    // for them, so they ride with card as non-cash electronic settlement.
    cardCollected: result.cardTotal + result.bankTransferTotal + result.otherTotal,
    creditGiven: result.creditTotal,
    returnsTotal: result.returnsTotal,
  };

  await prisma.dailySummary.upsert({
    where: { tenantId_date: { tenantId, date: startOfDay } },
    update: row,
    create: { tenantId, date: startOfDay, ...row },
  });

  return result;
}

/**
 * Reads the summary for a day.
 *
 * Always computed rather than read back from the stored row: the row cannot
 * represent a single mode, and a cached figure for "today" goes stale the moment
 * the next sale lands.
 */
export async function getDailySummary(
  tenantId: string,
  date: Date,
  mode?: string,
): Promise<DailySummaryResult> {
  return generateDailySummary(tenantId, date, mode);
}
