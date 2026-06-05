import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required. Add it to your .env file.');
}

const pool = new Pool({ 
  connectionString,
  connectionTimeoutMillis: 20000, // 20 seconds to allow for Neon cold start
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,
});
const adapter = new PrismaPg(pool);

const SOFT_DELETE_MODELS = new Set([
  'InventoryCategory', 'ProductItem', 'InventoryItem', 'Project',
  'ProjectMilestone', 'ProjectMaterial', 'Customer', 'Transaction',
  'Invoice', 'Employee', 'Role', 'Document',
]);

const baseClient = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
});

// ── Soft-delete extension (Prisma 5+) ─────────────────────────────────────
// Automatically excludes soft-deleted records from every findUnique,
// findFirst, findMany, and count query — no changes needed in controllers.
export const prisma = baseClient.$extends({
  query: {
    $allModels: {
      async findUnique({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) {
          (args as any).where = { ...(args as any).where, isDeleted: false };
        }
        return query(args);
      },
      async findFirst({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) {
          (args as any).where = { ...(args as any).where, isDeleted: false };
        }
        return query(args);
      },
      async findMany({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) {
          (args as any).where = { ...(args as any).where, isDeleted: false };
        }
        return query(args);
      },
      async count({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) {
          (args as any).where = { ...(args as any).where, isDeleted: false };
        }
        return query(args);
      },
    },
  },
});

// Unextended client — use only when you need to query soft-deleted records
export const prismaBase = baseClient;

export { pool };
