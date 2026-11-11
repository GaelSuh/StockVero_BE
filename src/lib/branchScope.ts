import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import { ApiError } from './errors.js';

/**
 * The branch a request works in. Set once per request by tenantGuard and read
 * by the Prisma extension in db.ts, so every query on a branch table is
 * limited to that branch without each controller having to remember it.
 *
 * `branchId: null` is the owner's "All branches" view: reads span every branch
 * of the tenant (controllers still filter by tenantId) and writes to branch
 * tables are refused, because a sale or a stock change must belong to one
 * branch.
 *
 * No context at all (super-admin console, cron jobs, signup and login) means
 * no automatic filtering: that code is cross-branch by nature and handles
 * branchId explicitly.
 */
export interface BranchScope {
  tenantId: string;
  branchId: string | null;
}

const storage = new AsyncLocalStorage<BranchScope>();

/**
 * Runs `fn` inside a branch scope. Prisma queries are lazy (they start when
 * awaited), so a query must be awaited inside `fn`, not returned unawaited
 * and awaited by the caller — the scope would be gone by then.
 */
export function runInBranchScope<T>(scope: BranchScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentBranchScope(): BranchScope | undefined {
  return storage.getStore();
}

/**
 * The branch new rows are recorded in. Throws in the All branches view (a
 * write needs one branch) and outside a request (cron jobs and the admin
 * console must name the branch themselves).
 */
export function activeBranchId(): string {
  const scope = storage.getStore();
  if (!scope) throw new Error('activeBranchId() called outside a branch-scoped request');
  if (scope.branchId === null) throw new BranchRequiredError();
  return scope.branchId;
}

/** Models whose rows belong to exactly one branch (required branch_id column). */
export const BRANCH_MODELS: ReadonlySet<string> = new Set([
  'InventoryItem', 'ProductCategory', 'InventoryCategory', 'ProductVariant', 'ProductItem',
  'ProductItemMaintenanceLog', 'CategoryStockLog', 'InventoryMovement', 'StockMovement',
  'Customer', 'CustomerContact', 'CustomerPurchase',
  'Project', 'ProjectMilestone', 'ProjectMaterial', 'ProjectAssignment',
  'Transaction', 'Invoice', 'InvoicePayment', 'TenantFinanceBalance', 'Document',
  'Sale', 'SaleReturn', 'PriceList', 'DeliveryNote', 'DailySummary',
]);

/** Thrown when something tries to write branch data in the All branches view. */
export class BranchRequiredError extends ApiError {
  constructor() {
    super(409, 'Choose a branch first: this action records data in one branch.', 'BRANCH_REQUIRED');
  }
}

/** Thrown when code tries to create a row for a branch other than the active one. */
export class BranchMismatchError extends ApiError {
  constructor(model: string) {
    super(409, `Refused to write ${model} for a branch other than the active one.`, 'BRANCH_MISMATCH');
  }
}

const READS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
const FILTERED_WRITES = new Set(['update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany', 'upsert']);
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);

function stampBranch(model: string, data: any, branchId: string): any {
  if (!data || typeof data !== 'object') return data;
  if (data.branch !== undefined) {
    if (data.branch?.connect?.id !== branchId) throw new BranchMismatchError(model);
    return data;
  }
  if (data.branchId !== undefined) {
    if (data.branchId !== branchId) throw new BranchMismatchError(model);
    return data;
  }
  // A create written with relation objects (`tenant: { connect }`) cannot also
  // take a raw foreign key, and vice versa; match the style the caller used.
  return data.tenant !== undefined
    ? { ...data, branch: { connect: { id: branchId } } }
    : { ...data, branchId };
}

/**
 * Prisma client extension that applies the request's branch scope. Reads and
 * filtered writes get `branchId` added to their `where`; creates get it
 * stamped on (or are refused if they name another branch).
 *
 * Nested writes inside a create/update (`items: { create: [...] }`) are not
 * seen by query extensions. Every nested branch-model write must therefore
 * pass branchId itself; the NOT NULL column makes a forgotten one fail loudly.
 */
export const branchScopeExtension = Prisma.defineExtension({
  name: 'branch-scope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const scope = storage.getStore();
        if (!scope || !model || !BRANCH_MODELS.has(model)) return query(args);

        const a = (args ?? {}) as any;
        if (scope.branchId === null) {
          if (READS.has(operation)) return query(args);
          throw new BranchRequiredError();
        }

        const branchId = scope.branchId;
        if (READS.has(operation) || FILTERED_WRITES.has(operation)) {
          a.where = { ...(a.where ?? {}), branchId };
        }
        if (operation === 'upsert') a.create = stampBranch(model, a.create, branchId);
        if (CREATES.has(operation)) {
          a.data = Array.isArray(a.data)
            ? a.data.map((d: any) => stampBranch(model, d, branchId))
            : stampBranch(model, a.data, branchId);
        }
        return query(a);
      },
    },
  },
});
