/**
 * Customers across branches, against the real database, on a throwaway TEST
 * tenant that is removed afterwards.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prismaUnscoped as db } from '../db.js';
import { addCustomerToBranch, lookupCustomer, phoneKey } from './customerBranchService.js';

let tenantId = '';
let a = '';
let b = '';
let gaelInA = '';

before(async () => {
  const tenant = await db.tenant.create({
    data: {
      name: 'Customer test',
      subdomain: `cust-test-${randomUUID().slice(0, 8)}`,
      tenantType: 'TEST',
      branches: { create: [{ name: 'Akwa', code: 'A', isMain: true }, { name: 'Bonamoussadi', code: 'B' }] },
    },
    select: { id: true, branches: { select: { id: true, code: true } } },
  });
  tenantId = tenant.id;
  a = tenant.branches.find((x) => x.code === 'A')!.id;
  b = tenant.branches.find((x) => x.code === 'B')!.id;
  const gael = await db.customer.create({
    data: { tenantId, branchId: a, name: 'Gaël Nkodo', phone: '+237 692 52 15 65', email: 'gael@example.test', address: 'Akwa', notes: 'Pays late' },
  });
  gaelInA = gael.id;
  await db.customer.create({ data: { tenantId, branchId: a, name: 'Other person', phone: '677 00 00 00' } });
});

after(async () => {
  if (!tenantId) return;
  await db.customer.deleteMany({ where: { tenantId } });
  await db.tenant.delete({ where: { id: tenantId } });
});

test('phone key ignores spaces, signs and the country code', () => {
  assert.equal(phoneKey('+237 692 52 15 65'), phoneKey('692521565'));
  assert.notEqual(phoneKey('692521565'), phoneKey('692521566'));
});

test('a person known in another branch is found by phone, with contact details only', async () => {
  const r = await lookupCustomer(tenantId, b, { phone: '692-521-565' });
  assert.equal(r.here.length, 0);
  assert.equal(r.elsewhere.length, 1);
  assert.equal(r.elsewhere[0].name, 'Gaël Nkodo');
  assert.equal(r.elsewhere[0].branch.code, 'A');
  assert.equal((r.elsewhere[0] as any).notes, undefined, 'no notes, balances or history leak');
});

test('email matches too, case-insensitively', async () => {
  const r = await lookupCustomer(tenantId, b, { email: 'GAEL@example.test' });
  assert.equal(r.elsewhere.length, 1);
});

test('too short a phone matches nobody', async () => {
  const r = await lookupCustomer(tenantId, b, { phone: '65' });
  assert.equal(r.here.length + r.elsewhere.length, 0);
});

test('adding to a branch copies who they are, not their account, and only once', async () => {
  const first = await addCustomerToBranch(tenantId, gaelInA, b);
  assert.equal(first.alreadyHere, false);
  const copy = await db.customer.findUnique({ where: { id: first.customer.id } });
  assert.equal(copy?.branchId, b);
  assert.equal(copy?.phone, '+237 692 52 15 65');
  assert.equal(copy?.address, 'Akwa');
  assert.equal(copy?.notes, null);

  const second = await addCustomerToBranch(tenantId, gaelInA, b);
  assert.equal(second.alreadyHere, true);
  assert.equal(second.customer.id, first.customer.id);
  assert.equal(await db.customer.count({ where: { tenantId, branchId: b } }), 1);
});

test('once added, the lookup in that branch says they are already a customer here', async () => {
  const r = await lookupCustomer(tenantId, b, { phone: '692521565' });
  assert.equal(r.here.length, 1);
  assert.equal(r.elsewhere.length, 1);
});

test('an unknown customer id is refused', async () => {
  await assert.rejects(addCustomerToBranch(tenantId, randomUUID(), b));
});
