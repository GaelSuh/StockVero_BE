import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveStockCondition, parseCondition, StockConditionError } from './stockConditionService.js';

/**
 * One product row, applying Prisma-style increment/decrement on update. A
 * `{ gte }` filter in `where` is checked against the live row, like Postgres
 * does, and a miss throws P2025. `staleRead` makes findFirst return an old copy.
 */
function fakeTx(product: Record<string, any>, staleRead?: Record<string, any>) {
  const logs: any[] = [];
  const apply = (row: any, where: any, data: any) => {
    for (const [k, v] of Object.entries<any>(where)) {
      if (v?.gte !== undefined && !(row[k] >= v.gte)) throw Object.assign(new Error('not found'), { code: 'P2025' });
    }
    for (const [k, v] of Object.entries<any>(data)) row[k] += v.increment ?? -v.decrement;
    return { quantityOnHand: row.quantityOnHand, quantityFaulty: row.quantityFaulty, quantityDamaged: row.quantityDamaged };
  };
  return {
    logs,
    product,
    inventoryCategory: {
      findFirst: async () => ({ ...(staleRead ?? product) }),
      update: async ({ where, data }: any) => apply(product, where, data),
    },
    productVariant: { findFirst: async () => null, update: async () => { throw new Error('no variant'); } },
    categoryStockLog: { create: async ({ data }: any) => logs.push(data) },
  };
}
const shelf = () => ({ id: 'p', name: 'Charger', stockTrackingMode: 'QUANTITY', quantityOnHand: 10, quantityFaulty: 0, quantityDamaged: 0 });
const base = { tenantId: 't', categoryId: 'p' };

test('marking shelf stock faulty takes it out of the sellable count', async () => {
  const tx = fakeTx(shelf());
  const r = await moveStockCondition(tx, { ...base, from: 'GOOD', to: 'FAULTY', quantity: 3 });
  assert.deepEqual(r.counts, { quantityOnHand: 7, quantityFaulty: 3, quantityDamaged: 0 });
  assert.equal(tx.logs[0].eventType, 'MARKED_FAULTY');
  assert.equal(tx.logs[0].delta, -3);
});

test('a repair puts faulty stock back on sale', async () => {
  const tx = fakeTx({ ...shelf(), quantityOnHand: 7, quantityFaulty: 3 });
  const r = await moveStockCondition(tx, { ...base, from: 'FAULTY', to: 'GOOD', quantity: 2 });
  assert.deepEqual(r.counts, { quantityOnHand: 9, quantityFaulty: 1, quantityDamaged: 0 });
});

test('cannot move more than the condition holds, or a serialized product', async () => {
  await assert.rejects(moveStockCondition(fakeTx(shelf()), { ...base, from: 'FAULTY', to: 'DAMAGED', quantity: 1 }), StockConditionError);
  await assert.rejects(moveStockCondition(fakeTx({ ...shelf(), stockTrackingMode: 'SERIALIZED' }), { ...base, from: 'GOOD', to: 'FAULTY', quantity: 1 }), StockConditionError);
});

test('a move based on a stale count is refused and never drives stock negative', async () => {
  // Read saw 10 on the shelf, but another move already took 9 of them.
  const live = { ...shelf(), quantityOnHand: 1, quantityFaulty: 9 };
  const tx = fakeTx(live, shelf());
  await assert.rejects(moveStockCondition(tx, { ...base, from: 'GOOD', to: 'FAULTY', quantity: 3 }), StockConditionError);
  assert.deepEqual([live.quantityOnHand, live.quantityFaulty], [1, 9]);
  assert.equal(tx.logs.length, 0);
});

test('a missing or unknown return condition means GOOD', () => {
  assert.equal(parseCondition(undefined), 'GOOD');
  assert.equal(parseCondition('broken'), 'GOOD');
  assert.equal(parseCondition('DAMAGED'), 'DAMAGED');
});
