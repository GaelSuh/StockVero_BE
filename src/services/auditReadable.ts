import { prisma } from '../db.js';

/**
 * Audit details store some related records by id (customerId, projectId…).
 * When the log is read, those ids are swapped for the record's name, so
 * nobody has to read a UUID. Applied at read time, it fixes old entries too.
 * A record deleted since shows as "(deleted)".
 */

type Resolver = { as: string; load: (tenantId: string, ids: string[]) => Promise<Array<[string, string]>> };

const byName = (model: string, field = 'name') => async (tenantId: string, ids: string[]) => {
  const rows = await (prisma as any)[model].findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, [field]: true } });
  return rows.map((r: any) => [r.id, String(r[field])] as [string, string]);
};

const RESOLVERS: Record<string, Resolver> = {
  customerId: { as: 'customer', load: byName('customer') },
  projectId: { as: 'project', load: byName('project') },
  categoryId: { as: 'product', load: byName('inventoryCategory') },
  inventoryCategoryId: { as: 'product', load: byName('inventoryCategory') },
  productCategoryId: { as: 'category', load: byName('productCategory') },
  variantId: { as: 'variant', load: byName('productVariant', 'label') },
  priceListId: { as: 'priceList', load: byName('priceList') },
  saleId: { as: 'sale', load: byName('sale', 'saleNumber') },
  roleId: { as: 'role', load: byName('role') },
  materialId: { as: 'material', load: byName('projectMaterial') },
  employeeId: {
    as: 'employee',
    load: async (tenantId, ids) => {
      const rows = await (prisma as any).employee.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
      return rows.map((r: any) => [r.id, [r.firstName, r.lastName].filter(Boolean).join(' ')] as [string, string]);
    },
  },
};
RESOLVERS.assigneeId = { ...RESOLVERS.employeeId, as: 'assignee' };

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The objects whose keys may hold ids: the details, and old-style before/after diffs. */
const containers = (details: Record<string, unknown>) =>
  [details, details.before, details.after].filter(isPlainObject) as Array<Record<string, unknown>>;

export async function humanizeAuditDetails<T extends { details?: unknown }>(tenantId: string, logs: T[]): Promise<T[]> {
  const wanted = new Map<string, Set<string>>();
  for (const log of logs) {
    if (!isPlainObject(log.details)) continue;
    for (const c of containers(log.details)) {
      for (const [key, value] of Object.entries(c)) {
        if (RESOLVERS[key] && typeof value === 'string' && value) {
          (wanted.get(key) ?? wanted.set(key, new Set()).get(key)!).add(value);
        }
      }
    }
  }
  if (wanted.size === 0) return logs;

  const names = new Map<string, string>(); // `${key}:${id}` -> name
  await Promise.all(
    [...wanted.entries()].map(async ([key, ids]) => {
      try {
        for (const [id, name] of await RESOLVERS[key].load(tenantId, [...ids])) names.set(`${key}:${id}`, name);
      } catch (err) {
        console.error(`[audit] could not resolve ${key}:`, err);
      }
    }),
  );

  return logs.map((log) => {
    if (!isPlainObject(log.details)) return log;
    const rewrite = (c: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(c)) {
        const r = RESOLVERS[key];
        if (r && typeof value === 'string' && value) {
          // Keep a name the entry already carries (e.g. `product`) over a lookup.
          if (!(r.as in c)) out[r.as] = names.get(`${key}:${value}`) ?? '(deleted)';
        } else {
          out[key] = value;
        }
      }
      return out;
    };
    const d = rewrite(log.details);
    if (isPlainObject(d.before)) d.before = rewrite(d.before);
    if (isPlainObject(d.after)) d.after = rewrite(d.after);
    return { ...log, details: d };
  });
}
