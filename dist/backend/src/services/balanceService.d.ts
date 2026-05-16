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
export declare function recordExpense(tenantId: string, amount: number, tx?: PrismaWriteClient): Promise<void>;
export declare function reverseExpense(tenantId: string, amount: number, tx?: PrismaWriteClient): Promise<void>;
export declare function reverseIncome(tenantId: string, amount: number, tx?: PrismaWriteClient): Promise<void>;
export {};
