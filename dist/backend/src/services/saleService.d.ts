import { prisma } from '../db.js';
type PrismaWriteClient = typeof prisma | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'> | any;
export declare function getNextSaleNumber(tenantId: string, tx?: PrismaWriteClient): Promise<string>;
export declare function getNextReturnNumber(tenantId: string, tx?: PrismaWriteClient): Promise<string>;
export declare function getNextDeliveryNoteNumber(tenantId: string, tx?: PrismaWriteClient): Promise<string>;
export {};
