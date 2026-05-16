import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
declare const pool: Pool;
export declare const prisma: PrismaClient<{
    adapter: PrismaPg;
    log: ("query" | "warn" | "error")[];
}, "query" | "warn" | "error", import("@prisma/client/runtime/client").DefaultArgs>;
export { pool };
