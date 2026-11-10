import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { branchScopeExtension } from './lib/branchScope.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required. Add it to your .env file.');
}

const pool = new Pool({ 
  connectionString,
  connectionTimeoutMillis: 20000, // 20 seconds to allow for Neon cold start
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,
  // Keeps idle connections alive through NAT and proxies, so they are not cut
  // silently and handed to the next query dead.
  keepAlive: true,
});
// Neon closes connections when it suspends after a few idle minutes. pg then
// emits 'error' on the idle client; without a listener that is an unhandled
// error. The pool drops the dead client by itself, and the next query opens a
// fresh connection (waking Neon), so logging is all that is needed.
pool.on('error', (err) => {
  console.warn('[db] idle connection closed by the server:', err.message);
});
const adapter = new PrismaPg(pool);

/**
 * The raw client: no branch filtering. Only for code that is cross-branch on
 * purpose — company-wide number sequences, branch management, copying and
 * transfers between branches, the super-admin console. Everything else uses
 * `prisma` below.
 */
export const prismaUnscoped = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
});

/** The client every request uses: limited to the request's branch (see lib/branchScope.ts). */
export const prisma = prismaUnscoped.$extends(branchScopeExtension);

export { pool };
