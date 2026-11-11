/**
 * Importing products between branches, against the real database, on a
 * throwaway TEST tenant that is removed afterwards.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prismaUnscoped as db } from '../db.js';
import { copyCatalog, findProductElsewhere, listSourceProducts } from './branchCopyService.js';

let tenantId = '';
let from = '';
let to = '';
const ids: Record<string, string> = {};

before(async () => {
  const tenant = await db.tenant.create({
    data: {
      name: 'Import test',
      subdomain: `import-test-${randomUUID().slice(0, 8)}`,
      tenantType: 'TEST',
      branches: { create: [{ name: 'Source', code: 'SRC', isMain: true }, { name: 'Target', code: 'TGT' }] },
    },
    select: { id: true, branches: { select: { id: true, code: true } } },
  });
  tenantId = tenant.id;
  from = tenant.branches.find((b) => b.code === 'SRC')!.id;
  to = tenant.branches.find((b) => b.code === 'TGT')!.id;

  const drinks = await db.productCategory.create({ data: { tenantId, branchId: from, name: 'Drinks', normalizedName: 'drinks' } });
  const phones = await db.productCategory.create({ data: { tenantId, branchId: from, name: 'Phones', normalizedName: 'phones' } });
  await db.productCategory.create({ data: { tenantId, branchId: to, name: 'drinks', normalizedName: 'drinks' } });

  // What the target already has: same name as one source product, same barcode as another.
  await db.inventoryCategory.create({ data: { tenantId, branchId: to, sku: 'T-1', abbreviation: 'TC', name: 'coca-cola  50cl', sellingPrice: 999 } });
  await db.inventoryCategory.create({ data: { tenantId, branchId: to, sku: 'T-2', abbreviation: 'TW', name: 'Spring water', barcode: '6001' } });
  await db.inventoryCategory.create({ data: { tenantId, branchId: to, sku: 'T-3', abbreviation: 'MLT', name: 'Malta Guinness' } });

  const make = async (key: string, data: any) => {
    const p = await db.inventoryCategory.create({ data: { tenantId, branchId: from, quantityOnHand: 40, ...data } });
    ids[key] = p.id;
    return p;
  };
  await make('coke', { sku: 'COKE', abbreviation: 'CK', name: 'Coca-Cola 50cl', productCategoryId: drinks.id, sellingPrice: 500 });
  await make('water', { sku: 'WATER', abbreviation: 'WT', name: 'Water 1.5L', barcode: '6001', productCategoryId: drinks.id });
  await make('malta', { sku: 'MALTA', abbreviation: 'MLT', name: 'Malta', productCategoryId: drinks.id });
  const fanta = await make('fanta', {
    sku: 'FANTA', abbreviation: 'FT', name: 'Fanta', productCategoryId: drinks.id, sellingPrice: 450, costPrice: 300,
    stockTrackingMode: 'QUANTITY', imageUrl: 'https://cdn.example.test/fanta.png', images: ['https://cdn.example.test/fanta.png'],
  });
  await db.productVariant.createMany({
    data: [
      { tenantId, branchId: from, categoryId: fanta.id, label: 'Orange', attributes: { flavour: 'Orange' }, quantityOnHand: 12, priceOverride: 460 },
      { tenantId, branchId: from, categoryId: fanta.id, label: 'Lemon', attributes: { flavour: 'Lemon' }, quantityOnHand: 5 },
    ],
  });
  await make('phone', { sku: 'TECNO', abbreviation: 'TCN', name: 'Tecno Spark', productCategoryId: phones.id, stockTrackingMode: 'SERIALIZED', identifierType: 'IMEI', sellingPrice: 65000 });
});

after(async () => {
  if (!tenantId) return;
  await db.productVariant.deleteMany({ where: { tenantId } });
  await db.inventoryCategory.deleteMany({ where: { tenantId } });
  await db.productCategory.deleteMany({ where: { tenantId } });
  await db.auditLog.deleteMany({ where: { tenantId } });
  await db.tenant.delete({ where: { id: tenantId } });
});

test('the review list marks what the target already has, and why', async () => {
  const list = await listSourceProducts(tenantId, from, to);
  const by = Object.fromEntries(list.map((p) => [p.sku, p.alreadyHere]));
  assert.equal(by.COKE, 'name', 'same name, different case and spacing');
  assert.equal(by.WATER, 'barcode');
  assert.equal(by.MALTA, 'abbreviation');
  assert.equal(by.FANTA, null);
  assert.equal(by.TECNO, null);
  assert.equal(list.find((p) => p.sku === 'FANTA')?.variantCount, 2);
});

test('a dry run writes nothing', async () => {
  const r = await copyCatalog({ tenantId, fromBranchId: from, toBranchId: to, productIds: [ids.fanta], dryRun: true });
  assert.equal(r.products.created.length, 1);
  assert.equal(await db.inventoryCategory.count({ where: { branchId: to } }), 3);
});

test('only the chosen products are imported; ones already here are skipped', async () => {
  const r = await copyCatalog({ tenantId, fromBranchId: from, toBranchId: to, productIds: [ids.fanta, ids.coke], dryRun: false });
  assert.deepEqual(r.products.created.map((p) => p.name), ['Fanta']);
  assert.deepEqual(r.products.skipped.map((p) => [p.sku, p.reason]), [['COKE', 'name']]);
  assert.ok(r.products.created[0].id);
  assert.equal(await db.inventoryCategory.count({ where: { branchId: to, sku: 'TECNO' } }), 0);
});

test('an imported product keeps details, prices, image and variants, with no stock', async () => {
  const fanta = await db.inventoryCategory.findFirst({
    where: { branchId: to, sku: 'FANTA' },
    include: { variants: { orderBy: { label: 'asc' } }, productCategory: true },
  });
  assert.ok(fanta);
  assert.equal(Number(fanta.sellingPrice), 450);
  assert.equal(Number(fanta.costPrice), 300);
  assert.equal(fanta.imageUrl, 'https://cdn.example.test/fanta.png');
  assert.equal(fanta.quantityOnHand, 0);
  assert.equal(fanta.productCategory?.branchId, to);
  assert.equal(fanta.productCategory?.normalizedName, 'drinks', 'reused the existing category');
  assert.deepEqual(fanta.variants.map((v) => [v.label, v.quantityOnHand, v.priceOverride ? Number(v.priceOverride) : null]), [
    ['Lemon', 0, null],
    ['Orange', 0, 460],
  ]);
});

test('a serialized product stays serialized, without its units', async () => {
  await copyCatalog({ tenantId, fromBranchId: from, toBranchId: to, productIds: [ids.phone], dryRun: false });
  const phone = await db.inventoryCategory.findFirst({ where: { branchId: to, sku: 'TECNO' }, include: { productCategory: true } });
  assert.equal(phone?.stockTrackingMode, 'SERIALIZED');
  assert.equal(phone?.identifierType, 'IMEI');
  assert.equal(await db.productItem.count({ where: { categoryId: phone!.id } }), 0);
  assert.equal(phone?.productCategory?.name, 'Phones', 'missing category created');
});

test('importing again adds nothing', async () => {
  const again = await copyCatalog({ tenantId, fromBranchId: from, toBranchId: to, productIds: null, dryRun: false });
  assert.equal(again.products.created.length, 0);
  assert.equal(again.categories.created.length, 0);
});

test('the source branch is untouched', async () => {
  const fanta = await db.inventoryCategory.findUnique({ where: { id: ids.fanta }, include: { variants: true } });
  assert.equal(fanta?.quantityOnHand, 40);
  assert.equal(fanta?.variants.length, 2);
});

test('creating a product: finds it here, or in another branch to import instead', async () => {
  const typedElsewhere = await findProductElsewhere(tenantId, to, { name: 'malta' });
  assert.equal(typedElsewhere.elsewhere[0]?.branch.code, 'SRC');
  assert.equal(typedElsewhere.elsewhere[0]?.matchedBy, 'name');
  const byBarcode = await findProductElsewhere(tenantId, from, { barcode: '6001' });
  assert.equal(byBarcode.here[0]?.name, 'Water 1.5L');
  assert.equal(byBarcode.elsewhere[0]?.name, 'Spring water');
  const nothing = await findProductElsewhere(tenantId, to, { name: 'zz' });
  assert.equal(nothing.here.length + nothing.elsewhere.length, 0);
});

test('importing a branch into itself is refused', async () => {
  await assert.rejects(copyCatalog({ tenantId, fromBranchId: from, toBranchId: from, dryRun: true }));
});
