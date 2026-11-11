/**
 * Branch isolation against the real database: data recorded in branch A must
 * be invisible to, and untouchable from, branch B. Uses a throwaway TEST
 * tenant with two branches and removes it afterwards.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma, prismaUnscoped } from '../db.js';
import { runInBranchScope, BranchRequiredError, BranchMismatchError } from './branchScope.js';

let tenantId = '';
let branchA = '';
let branchB = '';
let customerA = '';

// Prisma queries are lazy: they run when awaited. Awaiting inside the scope is
// what a request handler does, and what these helpers mirror.
const scoped = <T>(branchId: string | null, fn: () => Promise<T>) =>
  runInBranchScope({ tenantId, branchId }, async () => await fn());
const inA = <T>(fn: () => Promise<T>) => scoped(branchA, fn);
const inB = <T>(fn: () => Promise<T>) => scoped(branchB, fn);
const inAll = <T>(fn: () => Promise<T>) => scoped(null, fn);

before(async () => {
  const tenant = await prismaUnscoped.tenant.create({
    data: {
      name: 'Branch isolation test',
      subdomain: `branch-test-${randomUUID().slice(0, 8)}`,
      tenantType: 'TEST',
      branches: {
        create: [
          { name: 'Branch A', code: 'A', isMain: true },
          { name: 'Branch B', code: 'B' },
        ],
      },
    },
    select: { id: true, branches: { select: { id: true, code: true } } },
  });
  tenantId = tenant.id;
  branchA = tenant.branches.find((b) => b.code === 'A')!.id;
  branchB = tenant.branches.find((b) => b.code === 'B')!.id;

  // Written without a branchId: the extension stamps the active branch.
  const c = await inA(() => prisma.customer.create({ data: { tenantId, name: 'Only in A' } as any }));
  customerA = c.id;
});

after(async () => {
  if (!tenantId) return;
  await prismaUnscoped.transaction.deleteMany({ where: { tenantId } });
  await prismaUnscoped.customer.deleteMany({ where: { tenantId } });
  await prismaUnscoped.tenant.delete({ where: { id: tenantId } });
});

test('a create without branchId is stamped with the active branch', async () => {
  const row = await prismaUnscoped.customer.findUnique({ where: { id: customerA }, select: { branchId: true } });
  assert.equal(row?.branchId, branchA);
});

test('branch B cannot see branch A rows', async () => {
  assert.equal(await inB(() => prisma.customer.count({ where: { tenantId } })), 0);
  assert.equal(await inB(() => prisma.customer.findFirst({ where: { id: customerA } })), null);
  assert.equal(await inB(() => prisma.customer.findUnique({ where: { id: customerA } })), null);
  assert.deepEqual(await inB(() => prisma.customer.findMany({ where: { tenantId } })), []);
});

test('branch B cannot change or delete branch A rows', async () => {
  await assert.rejects(inB(() => prisma.customer.update({ where: { id: customerA }, data: { name: 'hijacked' } })));
  assert.equal((await inB(() => prisma.customer.updateMany({ where: { tenantId }, data: { name: 'hijacked' } }))).count, 0);
  await assert.rejects(inB(() => prisma.customer.delete({ where: { id: customerA } })));
  assert.equal((await inB(() => prisma.customer.deleteMany({ where: { tenantId } }))).count, 0);
  const still = await prismaUnscoped.customer.findUnique({ where: { id: customerA } });
  assert.equal(still?.name, 'Only in A');
});

test('branch A still sees and edits its own rows', async () => {
  assert.equal(await inA(() => prisma.customer.count({ where: { tenantId } })), 1);
  const updated = await inA(() => prisma.customer.update({ where: { id: customerA }, data: { notes: 'ok' } }));
  assert.equal(updated.notes, 'ok');
});

test('a filter naming another branch cannot widen the scope', async () => {
  assert.equal(await inB(() => prisma.customer.count({ where: { tenantId, branchId: branchA } })), 0);
});

test('creating a row for another branch is refused', async () => {
  await assert.rejects(
    inB(() => prisma.customer.create({ data: { tenantId, branchId: branchA, name: 'smuggled' } })),
    BranchMismatchError,
  );
});

test('All branches reads span every branch but refuses writes', async () => {
  await inB(() => prisma.customer.create({ data: { tenantId, name: 'Only in B' } as any }));
  assert.equal(await inAll(() => prisma.customer.count({ where: { tenantId } })), 2);
  await assert.rejects(inAll(() => prisma.customer.create({ data: { tenantId, name: 'x' } as any })), BranchRequiredError);
  await assert.rejects(inAll(() => prisma.customer.updateMany({ where: { tenantId }, data: { notes: 'x' } })), BranchRequiredError);
});

test('aggregates and interactive transactions are scoped too', async () => {
  await inA(() => prisma.transaction.create({
    data: { tenantId, type: 'INCOME', status: 'ACCEPTED', amount: 100, description: 'A' } as any,
  }));
  await inB(() => prisma.transaction.create({
    data: { tenantId, type: 'INCOME', status: 'ACCEPTED', amount: 7, description: 'B' } as any,
  }));
  const sumB = await inB(() => prisma.transaction.aggregate({ where: { tenantId }, _sum: { amount: true } }));
  assert.equal(Number(sumB._sum.amount), 7);
  const countInTx = await inB(() => prisma.$transaction((tx) => tx.transaction.count({ where: { tenantId } })));
  assert.equal(countInTx, 1);
  const sumAll = await inAll(() => prisma.transaction.aggregate({ where: { tenantId }, _sum: { amount: true } }));
  assert.equal(Number(sumAll._sum.amount), 107);
});

test('company tables are not branch-filtered', async () => {
  const seen = await inB(() => prisma.branch.count({ where: { tenantId } }));
  assert.equal(seen, 2);
});
