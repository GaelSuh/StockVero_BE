import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiff } from './auditService.js';

const decimal = (n: number) => ({ toNumber: () => n });

test('only real changes, with ids, timestamps and counters left out', () => {
  const before = { id: 'x', tenantId: 't', name: 'Charger', sellingPrice: decimal(500), productCategoryId: 'c1', updatedAt: new Date(1), _count: { variants: 0 } };
  const after = { id: 'x', tenantId: 't', name: 'Charger 20W', sellingPrice: decimal(500), productCategoryId: 'c1', updatedAt: new Date(2) };
  assert.deepEqual(buildDiff(before, after), { before: { name: 'Charger' }, after: { name: 'Charger 20W' } });
});

test('a related record shows by its name, and is ignored when loaded on one side only', () => {
  const diff = buildDiff({ productCategory: { id: 'a', name: 'Phones' } }, { productCategory: { id: 'b', name: 'Accessories' } });
  assert.deepEqual(diff, { before: { productCategory: 'Phones' }, after: { productCategory: 'Accessories' } });
  assert.deepEqual(buildDiff({ productCategory: { id: 'a', name: 'Phones' } }, {}), { before: {}, after: {} });
});

test('decimals compare by value and secrets never appear', () => {
  assert.deepEqual(buildDiff({ costPrice: decimal(10), password: 'a' }, { costPrice: decimal(12), password: 'b' }), {
    before: { costPrice: 10 },
    after: { costPrice: 12 },
  });
});
