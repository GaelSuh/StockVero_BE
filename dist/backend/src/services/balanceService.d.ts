import { prisma } from '../db.js';
type PrismaWriteClient = typeof prisma | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'> | any;
export declare class InsufficientFundsError extends Error {
    readonly netBalance: number;
    readonly required: number;
    readonly shortfall: number;
    constructor(netBalance: number, required: number, shortfall?: number);
}
export declare function getNetBalance(tenantId: string): Promise<number>;
export declare function checkSufficientFunds(tenantId: string, amount: number): Promise<void>;
export declare function recordIncome(tenantId: string, amount: number, tx?: PrismaWriteClient): Promise<void>;
/**
 * Books an expense that has already happened, without asking whether the tenant
 * could afford it.
 *
 * Use this for recording facts — stock bought and received, for instance. The
 * money left the business before StockVero was told about it, so refusing to
 * write it down would just mean the ledger can never catch up with reality, and
 * a shop that stocks up before its first sale could never record anything.
 *
 * For money the system is *authorising* to be spent (project materials, purchase
 * invoices), use `recordExpense`, which refuses to overdraw.
 */
export declare function applyExpense(tenantId: string, amount: number, tx?: PrismaWriteClient): Promise<void>;
export declare function recordExpense(tenantId: string, amount: number, tx?: PrismaWriteClient): Promise<void>;
export declare function reverseExpense(tenantId: string, amount: number, tx?: PrismaWriteClient): Promise<void>;
export declare function reverseIncome(tenantId: string, amount: number, tx?: PrismaWriteClient): Promise<void>;
export {};
