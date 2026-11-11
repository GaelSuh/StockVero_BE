import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deductStockForSale, restoreStockForReturn } from './saleInventoryService.js';

const game = { id: 'game', name: 'Game session 1h', stockTrackingMode: 'SERVICE', quantityOnHand: 0, reorderThreshold: 0 };

/**
 * A database that only knows how to look a product up. Any stock read or write
 * (units, variants, stock logs, quantity updates) throws, so a passing test
 * proves a service never touches stock.
 */
function lookupOnlyTx() {
  const refuse = (what: string) => () => {
    throw new Error(`a service must not touch stock (${what})`);
  };
  return {
    inventoryCategory: {
      findMany: async () => [game],
      findUnique: async () => game,
      update: refuse('inventoryCategory.update'),
      updateMany: refuse('inventoryCategory.updateMany'),
    },
    productVariant: { findMany: refuse('productVariant.findMany'), update: refuse('productVariant.update') },
    productItem: { groupBy: refuse('productItem.groupBy'), findMany: refuse('productItem.findMany'), count: refuse('productItem.count') },
    categoryStockLog: { create: refuse('categoryStockLog.create'), createMany: refuse('categoryStockLog.createMany') },
  } as any;
}

test('selling a service needs no stock and touches none, whatever the quantity', async () => {
  const result = await deductStockForSale(
    lookupOnlyTx(),
    [{ categoryId: 'game', quantity: 25, productName: game.name }],
    'R-0001',
    't',
    'u',
  );
  assert.deepEqual(result, { soldUnitIds: [null], lowStock: [] });
});

test('returning a service puts nothing back on the shelf', async () => {
  const result = await restoreStockForReturn(
    lookupOnlyTx(),
    [{ categoryId: 'game', quantity: 2, productName: game.name }],
    'RT-0001',
    't',
    'u',
  );
  assert.deepEqual(result, { skipped: [] });
});
