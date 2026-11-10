/**
 * When two products — in different branches of one company — are "the same
 * product". Any one of these identifies it: the name (ignoring case and
 * spacing), the abbreviation, the barcode, or the code (SKU). Used to stop a
 * branch importing or re-creating a product it already has, and to point a
 * branch creating a product at the one another branch already set up.
 */

export type MatchReason = 'name' | 'abbreviation' | 'barcode' | 'sku';

export type ProductKeys = { name: string; abbreviation?: string | null; barcode?: string | null; sku?: string | null };

const norm = {
  name: (v?: string | null) => (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase(),
  code: (v?: string | null) => (v ?? '').trim().toUpperCase(),
  barcode: (v?: string | null) => (v ?? '').trim(),
};

/** The products of one branch, indexed by every identifying field. */
export class ProductIndex {
  private names = new Set<string>();
  private abbreviations = new Set<string>();
  private barcodes = new Set<string>();
  private skus = new Set<string>();

  constructor(products: ProductKeys[] = []) {
    products.forEach((p) => this.add(p));
  }

  add(p: ProductKeys) {
    if (norm.name(p.name)) this.names.add(norm.name(p.name));
    if (norm.code(p.abbreviation)) this.abbreviations.add(norm.code(p.abbreviation));
    if (norm.barcode(p.barcode)) this.barcodes.add(norm.barcode(p.barcode));
    if (norm.code(p.sku)) this.skus.add(norm.code(p.sku));
  }

  /** Why `p` counts as already present, or null when it is new. */
  match(p: ProductKeys): MatchReason | null {
    if (norm.barcode(p.barcode) && this.barcodes.has(norm.barcode(p.barcode))) return 'barcode';
    if (norm.code(p.sku) && this.skus.has(norm.code(p.sku))) return 'sku';
    if (norm.name(p.name) && this.names.has(norm.name(p.name))) return 'name';
    if (norm.code(p.abbreviation) && this.abbreviations.has(norm.code(p.abbreviation))) return 'abbreviation';
    return null;
  }
}

/** Why candidate `p` matches what was typed (a single product), or null. */
export function matchesTyped(p: ProductKeys, typed: { name?: string; abbreviation?: string; barcode?: string }): MatchReason | null {
  return new ProductIndex([{ name: typed.name ?? '', abbreviation: typed.abbreviation, barcode: typed.barcode }]).match({
    name: p.name,
    abbreviation: p.abbreviation,
    barcode: p.barcode,
  });
}
