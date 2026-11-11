/**
 * Stock transfers between branches, against the real database, on a throwaway
 * TEST tenant that is removed afterwards.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prismaUnscoped as db } from '../db.js';
import {
  approveTransfer, closeTransfer, getTransfer, receiveTransfer, requestTransfer, transferSources, type Actor,
} from './stockTransferService.js';

let tenantId = '';
const b: Record<string, string> = {}; // branch ids by code
const p: Record<string, string> = {}; // product ids
let atA: Actor;
let atB: Actor;

const qty = async (id: string) => (await db.inventoryCategory.findUniqueOrThrow({ where: { id } })).quantityOnHand;
const rejects = (fn: Promise<unknown>, code: string) => assert.rejects(fn, (e: any) => e.code === code);

before(async () => {
  const tenant = await db.tenant.create({
    data: {
      name: 'Transfer test',
      subdomain: `transfer-test-${randomUUID().slice(0, 8)}`,
      tenantType: 'TEST',
      branches: { create: [{ name: 'Yaounde', code: 'YDE', isMain: true }, { name: 'Douala', code: 'DLA' }, { name: 'Kribi', code: 'KRI' }] },
    },
    select: { id: true, branches: { select: { id: true, code: true } } },
  });
  tenantId = tenant.id;
  tenant.branches.forEach((x) => (b[x.code] = x.id));
  const user = { userId: randomUUID() };
  atA = { tenantId, branchId: b.YDE, name: 'Ama (Yaounde)', ...user };
  atB = { tenantId, branchId: b.DLA, name: 'Ben (Douala)', ...user };

  const make = async (key: string, branch: string, data: any) => {
    const row = await db.inventoryCategory.create({ data: { tenantId, branchId: b[branch], ...data } });
    p[key] = row.id;
    return row;
  };
  // Same product in both branches (different code, same name); Kribi does not have it.
  await make('cokeA', 'YDE', { sku: 'CK-1', abbreviation: 'CK', name: 'Coca-Cola 50cl', stockTrackingMode: 'QUANTITY', quantityOnHand: 30, costPrice: 300 });
  await make('cokeB', 'DLA', { sku: 'CK-9', abbreviation: 'COK', name: 'coca-cola 50cl', stockTrackingMode: 'QUANTITY', quantityOnHand: 2 });
  await make('kribiOnly', 'KRI', { sku: 'X', abbreviation: 'X', name: 'Something else', stockTrackingMode: 'QUANTITY' });

  const phoneA = await make('phoneA', 'YDE', { sku: 'TC', abbreviation: 'TCN', name: 'Tecno Spark', stockTrackingMode: 'SERIALIZED' });
  await make('phoneB', 'DLA', { sku: 'TC', abbreviation: 'TCN', name: 'Tecno Spark', stockTrackingMode: 'SERIALIZED' });
  for (let i = 1; i <= 4; i++) {
    await db.productItem.create({
      data: { tenantId, branchId: b.YDE, categoryId: phoneA.id, systemId: `TCN-${i}`, userIdentifier: `IMEI-${i}`, stockStatus: 'AVAILABLE' },
    });
  }
  // Douala already uses the system id TCN-1: the transferred unit must not collide.
  await db.productItem.create({ data: { tenantId, branchId: b.DLA, categoryId: p.phoneB, systemId: 'TCN-1', stockStatus: 'AVAILABLE' } });

  const shirtA = await make('shirtA', 'YDE', { sku: 'SH', abbreviation: 'SH', name: 'Shirt', stockTrackingMode: 'QUANTITY' });
  const shirtB = await make('shirtB', 'DLA', { sku: 'SH', abbreviation: 'SH', name: 'Shirt', stockTrackingMode: 'QUANTITY' });
  await db.productVariant.create({ data: { tenantId, branchId: b.YDE, categoryId: shirtA.id, label: 'Red / L', quantityOnHand: 8 } });
  const redB = await db.productVariant.create({ data: { tenantId, branchId: b.DLA, categoryId: shirtB.id, label: 'red / l' } });
  p.redB = redB.id;
});

after(async () => {
  if (!tenantId) return;
  await db.stockTransfer.deleteMany({ where: { tenantId } });
  await db.categoryStockLog.deleteMany({ where: { tenantId } });
  await db.productItem.deleteMany({ where: { tenantId } });
  await db.productVariant.deleteMany({ where: { tenantId } });
  await db.inventoryCategory.deleteMany({ where: { tenantId } });
  await db.notification.deleteMany({ where: { tenantId } });
  await db.tenant.delete({ where: { id: tenantId } });
});

test('the branch list says which branches have the product, and how much', async () => {
  const list = await transferSources(tenantId, b.DLA, p.cokeB);
  const by = Object.fromEntries(list.map((s) => [s.branch.code, s.product]));
  assert.equal(by.YDE?.id, p.cokeA);
  assert.equal(by.YDE?.available, 30);
  assert.equal(by.KRI, null);
});

test('a branch without the product cannot be asked', async () => {
  await rejects(requestTransfer(atB, { productId: p.cokeB, fromBranchId: b.KRI, quantity: 5 }), 'PRODUCT_NOT_IN_BRANCH');
});

test('by quantity: ask 50, approve 15, stock leaves on approval and arrives on receipt', async () => {
  const t = await requestTransfer(atB, { productId: p.cokeB, fromBranchId: b.YDE, quantity: 50 });
  assert.equal(t.status, 'PENDING');
  assert.equal(t.fromProductId, p.cokeA);

  await rejects(approveTransfer(atB, t.id, { quantity: 15 }), 'WRONG_BRANCH');
  await rejects(approveTransfer(atA, t.id, { quantity: 51 }), 'BAD_QUANTITY');

  const approved = await approveTransfer(atA, t.id, { quantity: 15 });
  assert.equal(approved.status, 'APPROVED');
  assert.equal(await qty(p.cokeA), 15);
  assert.equal(await qty(p.cokeB), 2, 'nothing added before it arrives');
  await rejects(closeTransfer(atB, t.id), 'TRANSFER_NOT_CANCELLABLE');

  const received = await receiveTransfer(atB, t.id);
  assert.equal(received.status, 'RECEIVED');
  assert.equal(await qty(p.cokeB), 17);
  assert.equal(await qty(p.cokeA), 15);
  await rejects(closeTransfer(atA, t.id), 'TRANSFER_NOT_CANCELLABLE');

  const logs = await db.categoryStockLog.findMany({ where: { tenantId }, select: { eventType: true, delta: true, branchId: true } });
  assert.deepEqual(
    logs.map((l) => [l.eventType, l.delta, l.branchId]).sort(),
    [['TRANSFER_IN', 15, b.DLA], ['TRANSFER_OUT', -15, b.YDE]].sort(),
  );
  assert.equal(await db.transaction.count({ where: { tenantId } }), 0, 'no income or expense');
});

test('more than the sender has cannot be approved', async () => {
  const t = await requestTransfer(atB, { productId: p.cokeB, fromBranchId: b.YDE, quantity: 40 });
  await rejects(approveTransfer(atA, t.id, { quantity: 16 }), 'NOT_ENOUGH_STOCK');
  const after = await getTransfer(atA, null, t.id);
  assert.equal(after.status, 'PENDING', 'a refused approval changes nothing');
  assert.equal(await qty(p.cokeA), 15);
  // The asking branch cancels while it is still waiting.
  assert.equal((await closeTransfer(atB, t.id, 'Found some')).status, 'CANCELLED');
});

test('the sender can decline, or cancel after approving (the stock comes back)', async () => {
  const declined = await requestTransfer(atB, { productId: p.cokeB, fromBranchId: b.YDE, quantity: 5 });
  assert.equal((await closeTransfer(atA, declined.id, 'Need them')).status, 'REJECTED');

  const t = await requestTransfer(atB, { productId: p.cokeB, fromBranchId: b.YDE, quantity: 5 });
  await approveTransfer(atA, t.id, { quantity: 5 });
  assert.equal(await qty(p.cokeA), 10);
  assert.equal((await closeTransfer(atA, t.id)).status, 'CANCELLED');
  assert.equal(await qty(p.cokeA), 15);
  await rejects(receiveTransfer(atB, t.id), 'TRANSFER_NOT_APPROVED');
});

test('serialized: the picked units travel and become the other branch\'s', async () => {
  const t = await requestTransfer(atB, { productId: p.phoneB, fromBranchId: b.YDE, quantity: 3 });
  const view = await getTransfer(atA, null, t.id);
  assert.equal(view.sender?.available, 4);
  const picked = view.sender!.units.filter((u) => ['TCN-1', 'TCN-2'].includes(u.systemId)).map((u) => u.id);

  await rejects(approveTransfer(atA, t.id, { quantity: 2, unitIds: picked.slice(0, 1) }), 'PICK_UNITS');
  await approveTransfer(atA, t.id, { quantity: 2, unitIds: picked });
  assert.equal(await db.productItem.count({ where: { id: { in: picked }, stockStatus: 'IN_TRANSIT', branchId: b.YDE } }), 2);

  await receiveTransfer(atB, t.id);
  const units = await db.productItem.findMany({ where: { id: { in: picked } }, orderBy: { userIdentifier: 'asc' } });
  assert.deepEqual(units.map((u) => [u.branchId, u.categoryId, u.stockStatus]), [
    [b.DLA, p.phoneB, 'AVAILABLE'],
    [b.DLA, p.phoneB, 'AVAILABLE'],
  ]);
  assert.deepEqual(units.map((u) => u.systemId), ['TCN-1-YDE', 'TCN-2'], 'a clashing system id gets the branch code');
  assert.equal(await db.productItem.count({ where: { categoryId: p.phoneA, stockStatus: 'AVAILABLE' } }), 2);
});

test('a product with options: the option is matched by name', async () => {
  await rejects(requestTransfer(atB, { productId: p.shirtB, fromBranchId: b.YDE, quantity: 3 }), 'VARIANT_REQUIRED');
  const t = await requestTransfer(atB, { productId: p.shirtB, fromBranchId: b.YDE, variantId: p.redB, quantity: 3 });
  await approveTransfer(atA, t.id, { quantity: 3 });
  await receiveTransfer(atB, t.id);
  const [redA, redB] = await Promise.all([
    db.productVariant.findFirstOrThrow({ where: { categoryId: p.shirtA } }),
    db.productVariant.findUniqueOrThrow({ where: { id: p.redB } }),
  ]);
  assert.equal(redA.quantityOnHand, 5);
  assert.equal(redB.quantityOnHand, 3);
});
