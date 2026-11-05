import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOrCreateCreditCustomer } from './creditCustomerService.js';

/** Just enough of a Prisma transaction: one existing customer, records creates. */
function fakeTx(existing: Array<{ id: string; name: string; phone: string }>) {
  const created: any[] = [];
  return {
    created,
    customer: {
      findMany: async () => existing,
      create: async ({ data }: any) => {
        created.push(data);
        return { id: `new-${created.length}`, name: data.name };
      },
    },
  };
}
const gael = { id: 'gael', name: 'Gaël', phone: '+237 692 521 565' };

test('same phone and same name (accents/case ignored) links the existing customer', async () => {
  const tx = fakeTx([gael]);
  const r = await findOrCreateCreditCustomer(tx, 't', { phone: '237692521565', name: ' gael ' });
  assert.deepEqual(r, { id: 'gael', name: 'Gaël', created: false });
});

test('same phone, no name typed, links the existing customer', async () => {
  const r = await findOrCreateCreditCustomer(fakeTx([gael]), 't', { phone: '237692521565' });
  assert.equal(r.id, 'gael');
});

test('same phone but a different name never re-links: a new customer, noted as sharing the phone', async () => {
  const tx = fakeTx([gael]);
  const r = await findOrCreateCreditCustomer(tx, 't', { phone: '237692521565', name: 'junior' });
  assert.equal(r.created, true);
  assert.equal(tx.created[0].name, 'junior');
  assert.match(tx.created[0].notes, /Same phone as Gaël/);
});

test("the cashier's 'new customer' answer always creates one, even when the name matches", async () => {
  const tx = fakeTx([gael]);
  const r = await findOrCreateCreditCustomer(tx, 't', { phone: '237692521565', name: 'Gael', decision: 'new' });
  assert.equal(r.created, true);
});
