import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareOutStock, VariantQuantityCeilingError } from './variantPool.js';

/** One product row; updateMany honours a `{ gte }` filter like Postgres does. */
function fakeTx(quantityOnHand: number) {
  const row = { id: 'drinks', quantityOnHand };
  return {
    row,
    inventoryCategory: {
      update: async ({ data }: any) => {
        row.quantityOnHand += data.quantityOnHand.increment;
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        if (row.quantityOnHand < where.quantityOnHand.gte) return { count: 0 };
        row.quantityOnHand -= data.quantityOnHand.decrement;
        return { count: 1 };
      },
      findUnique: async () => row,
    },
  };
}

const drinks = { id: 'drinks', stockTrackingMode: 'QUANTITY' };

test('giving a variant stock takes it out of the stock not yet shared out', async () => {
  const tx = fakeTx(96);
  await shareOutStock(tx, 't', drinks, 24);
  assert.equal(tx.row.quantityOnHand, 72);
});

test('lowering or deleting a variant gives its stock back', async () => {
  const tx = fakeTx(10);
  await shareOutStock(tx, 't', drinks, -6);
  assert.equal(tx.row.quantityOnHand, 16);
});

test('cannot give out more than is waiting, and nothing changes when refused', async () => {
  const tx = fakeTx(5);
  await assert.rejects(shareOutStock(tx, 't', drinks, 6), VariantQuantityCeilingError);
  assert.equal(tx.row.quantityOnHand, 5);
});

test('serialized products and zero changes are left alone', async () => {
  const tx = fakeTx(5);
  await shareOutStock(tx, 't', { id: 'phone', stockTrackingMode: 'SERIALIZED' }, 3);
  await shareOutStock(tx, 't', drinks, 0);
  assert.equal(tx.row.quantityOnHand, 5);
});
