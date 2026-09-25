import { prisma } from '../db.js';
type PrismaWriteClient = typeof prisma | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'> | any;
export declare function recordSaleAsIncome(tx: PrismaWriteClient, sale: {
    id: string;
    saleNumber: string;
    totalAmount: any;
    mode: string;
    createdAt: Date;
    customerId?: string | null;
}, tenantId: string): Promise<string>;
/**
 * Records a tip (money tendered beyond the sale total, per the shop's
 * "overpayment becomes a tip for the seller" policy) as its own income
 * transaction, so it shows up in reporting instead of being silently absorbed
 * into the sale total.
 */
export declare function recordSaleTipAsIncome(tx: PrismaWriteClient, sale: {
    id: string;
    saleNumber: string;
    soldByName: string;
}, tipAmount: number, tenantId: string): Promise<void>;
export declare function recordReturnAsExpense(tx: PrismaWriteClient, saleReturn: {
    id: string;
    refundAmount: any;
    saleId: string;
}, saleNumber: string, tenantId: string): Promise<void>;
export {};
