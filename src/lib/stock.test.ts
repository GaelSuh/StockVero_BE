import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantityLots, stockValueAtPrice } from './stock.js';

const drinks = {
  stockTrackingMode: 'QUANTITY' as const,
  quantityOnHand: 96,
  sellingPrice: 400,
  variants: [
    { id: 'coke', priceOverride: 500, quantityOnHand: 24 },
    { id: 'water', priceOverride: null, quantityOnHand: 48 },
  ],
};

test('variants are valued at their own price, falling back to the product price', () => {
  // 24 × 500 (own price) + 48 × 400 (product price); the product's own 96 is not added.
  assert.equal(stockValueAtPrice(drinks, quantityLots(drinks)), 24 * 500 + 48 * 400);
});

test('a product without variants is valued at its own count and price', () => {
  const rice = { stockTrackingMode: 'QUANTITY' as const, quantityOnHand: 60, sellingPrice: 1000, variants: [] };
  assert.equal(stockValueAtPrice(rice, quantityLots(rice)), 60_000);
});

test('serialized lots use the variant price, units without a variant the product price', () => {
  const phone = { sellingPrice: 100_000, variants: [{ id: '256gb', priceOverride: 150_000 }] };
  const lots = [{ variantId: '256gb', quantity: 2 }, { variantId: null, quantity: 3 }];
  assert.equal(stockValueAtPrice(phone, lots), 2 * 150_000 + 3 * 100_000);
});

test('negative counts never reduce the value', () => {
  assert.equal(stockValueAtPrice({ sellingPrice: 500 }, [{ variantId: null, quantity: -4 }]), 0);
});
