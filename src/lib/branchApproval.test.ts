/**
 * A branch nobody at StockVero has approved yet can be set up, but not entered:
 * not by the owner, not by its own staff, not through access to it.
 * Real database, throwaway TEST tenant removed afterwards.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prismaUnscoped as db } from '../db.js';
import { branchesForEmployee, resolveEmployeeBranch, resolveOwnerBranch } from './branchAccess.js';

let tenantId = '';
let main = '';
let fresh = '';
let homeInFresh = { id: '', branchId: '' };
let visitor = { id: '', branchId: '' };

before(async () => {
  const tenant = await db.tenant.create({
    data: {
      name: 'Approval test',
      subdomain: `approval-test-${randomUUID().slice(0, 8)}`,
      tenantType: 'TEST',
      branches: { create: [{ name: 'Main', code: 'MAIN', isMain: true, approvalStatus: 'APPROVED' }, { name: 'New shop', code: 'NEW' }] },
    },
    select: { id: true, branches: { select: { id: true, code: true, approvalStatus: true } } },
  });
  tenantId = tenant.id;
  main = tenant.branches.find((b) => b.code === 'MAIN')!.id;
  const created = tenant.branches.find((b) => b.code === 'NEW')!;
  fresh = created.id;
  assert.equal(created.approvalStatus, 'PENDING', 'a new branch waits for approval');

  const role = await db.role.create({ data: { tenantId, name: 'Staff', abbreviation: 'STF' } });
  const person = (branchId: string, n: string) =>
    db.employee.create({
      data: { tenantId, roleId: role.id, branchId, firstName: n, lastName: 'T', email: `${n}-${randomUUID().slice(0, 6)}@example.test`, passwordHash: 'x' },
      select: { id: true, branchId: true },
    });
  homeInFresh = await person(fresh, 'newstaff');
  visitor = await person(main, 'visitor');
  await db.branchAccess.create({ data: { tenantId, employeeId: visitor.id, branchId: fresh, roleId: role.id } });
});

after(async () => {
  if (!tenantId) return;
  await db.branchAccess.deleteMany({ where: { tenantId } });
  await db.employee.deleteMany({ where: { tenantId } });
  await db.role.deleteMany({ where: { tenantId } });
  await db.tenant.delete({ where: { id: tenantId } });
});

test('waiting for approval: nobody enters', async () => {
  assert.equal(await resolveOwnerBranch(tenantId, fresh), undefined, 'the owner cannot switch to it');
  assert.equal(await resolveOwnerBranch(tenantId, main), main, 'the main branch still works');
  assert.equal(await resolveEmployeeBranch(homeInFresh, null), null, 'its own staff cannot sign in');
  assert.equal(await resolveEmployeeBranch(visitor, fresh), null, 'access to it does not open it');
  assert.deepEqual((await branchesForEmployee(visitor)).map((b) => b.id), [main]);
});

test('rejected: still closed', async () => {
  await db.branch.update({ where: { id: fresh }, data: { approvalStatus: 'REJECTED' } });
  assert.equal(await resolveOwnerBranch(tenantId, fresh), undefined);
  assert.equal(await resolveEmployeeBranch(homeInFresh, null), null);
});

test('approved: everyone with a right to it enters', async () => {
  await db.branch.update({ where: { id: fresh }, data: { approvalStatus: 'APPROVED' } });
  assert.equal(await resolveOwnerBranch(tenantId, fresh), fresh);
  assert.deepEqual(await resolveEmployeeBranch(homeInFresh, null), { branchId: fresh });
  assert.equal((await resolveEmployeeBranch(visitor, fresh))?.branchId, fresh);
  assert.deepEqual((await branchesForEmployee(visitor)).map((b) => b.id).sort(), [main, fresh].sort());
});
