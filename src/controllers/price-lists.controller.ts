import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
import { prisma } from '../db.js';
import { logAudit, AuditActorType, auditRequest } from '../services/auditService.js';
import { broadcastToModule } from '../services/notificationService.js';
import { checkPriceListDependencies } from '../services/dependencyCheckService.js';
import { activeBranchId } from '../lib/branchScope.js';

/**
 * Price lists (and therefore price rules) live under the `wholesale_sales`
 * module — that is the moduleGuard/permissionGuard key these routes already
 * use. There is no `pricing` module: a key that matches no RolePermission row
 * would silently notify nobody but the owners.
 */
const PRICING_MODULE = 'wholesale_sales';

function actorTypeFromUser(user: { accountType: string }): AuditActorType {
  return user.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE;
}

/** Rules are replaced as a set, so the audit detail is the resulting tiers. */
function summariseRules(rules: any[]): Record<string, any> {
  return {
    count: rules.length,
    tiers: rules.map((r) => ({
      categoryId: r.categoryId,
      variantId: r.variantId ?? null,
      minQuantity: r.minQuantity,
      unitPrice: r.unitPrice == null ? null : String(r.unitPrice),
      discountPercent: r.discountPercent == null ? null : String(r.discountPercent),
    })),
  };
}

type RuleRow = {
  categoryId: string;
  variantId: string | null;
  minQuantity: number;
  unitPrice: number | null;
  discountPercent: number | null;
};

/**
 * Checks the rules a client sent and returns the rows to write, or an error
 * message. Each rule is a fixed price or a percentage off, never both; every
 * product and variant must belong to this business.
 */
async function parseRules(tenantId: string, input: unknown): Promise<RuleRow[] | string> {
  if (!Array.isArray(input)) return 'rules must be a list';
  const rows: RuleRow[] = [];
  for (const r of input as any[]) {
    const price = r?.unitPrice == null || r.unitPrice === '' ? null : Number(r.unitPrice);
    const pct = r?.discountPercent == null || r.discountPercent === '' ? null : Number(r.discountPercent);
    const minQuantity = r?.minQuantity == null ? 1 : Number(r.minQuantity);
    if (!r?.categoryId || typeof r.categoryId !== 'string') return 'Each rule needs a product';
    if (!Number.isInteger(minQuantity) || minQuantity < 1) return 'Minimum quantity must be a whole number of at least 1';
    if ((price == null) === (pct == null)) return 'Each rule needs either a price or a discount, not both';
    if (price != null && !(Number.isFinite(price) && price > 0)) return 'Price must be greater than 0';
    if (pct != null && !(Number.isFinite(pct) && pct > 0 && pct < 100)) return 'Discount must be between 0 and 100%';
    rows.push({
      categoryId: r.categoryId,
      variantId: r.variantId || null,
      minQuantity,
      unitPrice: price,
      discountPercent: pct == null ? null : Math.round(pct * 100) / 100,
    });
  }
  const categoryIds = [...new Set(rows.map((r) => r.categoryId))];
  const variantIds = [...new Set(rows.map((r) => r.variantId).filter(Boolean))] as string[];
  const [cats, vars] = await Promise.all([
    prisma.inventoryCategory.count({ where: { tenantId, id: { in: categoryIds } } }),
    variantIds.length
      ? prisma.productVariant.findMany({ where: { id: { in: variantIds }, category: { tenantId } }, select: { id: true, categoryId: true } })
      : Promise.resolve([] as { id: string; categoryId: string }[]),
  ]);
  if (cats !== categoryIds.length) return 'A product in this list was not found';
  const variantProduct = new Map(vars.map((v) => [v.id, v.categoryId]));
  if (rows.some((r) => r.variantId && variantProduct.get(r.variantId) !== r.categoryId)) {
    return 'A variant in this list was not found';
  }
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.categoryId}|${r.variantId ?? ''}|${r.minQuantity}`;
    if (seen.has(key)) return 'The same product appears twice at the same quantity';
    seen.add(key);
  }
  return rows;
}

export async function createPriceList(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const { name, description, isDefault, rules } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });
    const rows = await parseRules(tenantId, rules ?? []);
    if (typeof rows === 'string') return res.status(400).json({ success: false, message: rows });

    const priceList = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.priceList.updateMany({ where: { tenantId, isDefault: true }, data: { isDefault: false } });
      }
      const list = await tx.priceList.create({
        data: {
          tenantId,
          branchId: activeBranchId(),
          name,
          description: description || null,
          isDefault: isDefault || false,
        },
      });
      // createMany: a list can hold hundreds of products.
      if (rows.length) await tx.priceRule.createMany({ data: rows.map((r) => ({ ...r, priceListId: list.id })) });
      return tx.priceList.findUniqueOrThrow({ where: { id: list.id }, include: { rules: true } });
    });

    // After the write, never inside it: logAudit and broadcastToModule use the
    // global prisma client, so a row written from inside a transaction that
    // later rolled back would describe something that never happened.
    await logAudit({
      tenantId,
      actorType: actorTypeFromUser(req.user!),
      actorId: req.user!.id,
      action: 'PRICE_LIST_CREATED',
      module: PRICING_MODULE,
      entityType: 'PriceList',
      entityId: priceList.id,
      entityLabel: priceList.name,
      details: { isDefault: priceList.isDefault, ...summariseRules(priceList.rules) },
    });
    await broadcastToModule(tenantId, PRICING_MODULE, {
      type: 'priceRule.changed',
      title: 'Price list created',
      message: `"${priceList.name}" was created with ${priceList.rules.length} pricing tier${priceList.rules.length === 1 ? '' : 's'}`,
      link: `/sales/price-lists/${priceList.id}`,
    });

    return res.status(201).json({ success: true, message: 'Price list created', data: priceList });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to create price list' });
  }
}

export async function listPriceLists(req: AuthRequest, res: Response) {
  try {
    const priceLists = await prisma.priceList.findMany({
      where: { tenantId: req.tenantId! },
      include: { _count: { select: { rules: true, customers: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, data: priceLists });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to list price lists' });
  }
}

export async function getPriceList(req: AuthRequest, res: Response) {
  try {
    const priceList = await prisma.priceList.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: {
        rules: {
          include: {
            category: { select: { id: true, name: true, sku: true, sellingPrice: true } },
            // So the details table can say which option a tier applies to —
            // a product-level tier and a variant tier otherwise look identical.
            variant: { select: { id: true, label: true } },
          },
        },
        customers: { include: { customer: { select: { id: true, name: true } } } },
      },
    });
    if (!priceList) return res.status(404).json({ success: false, message: 'Price list not found' });
    return res.json({ success: true, data: priceList });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get price list' });
  }
}

export async function updatePriceList(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const { name, description, isDefault, rules } = req.body;

    const existing = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) return res.status(404).json({ success: false, message: 'Price list not found' });
    const rows = rules === undefined ? undefined : await parseRules(tenantId, rules);
    if (typeof rows === 'string') return res.status(400).json({ success: false, message: rows });

    // One transaction: the old rules go and the new ones arrive together, so a
    // failed write never leaves the customer with an empty list.
    const updated = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.priceList.updateMany({
          where: { tenantId, isDefault: true, id: { not: req.params.id } },
          data: { isDefault: false },
        });
      }
      if (rows) {
        await tx.priceRule.deleteMany({ where: { priceListId: req.params.id } });
        if (rows.length) await tx.priceRule.createMany({ data: rows.map((r) => ({ ...r, priceListId: req.params.id })) });
      }
      return tx.priceList.update({
        where: { id: req.params.id },
        data: {
          name: name ?? undefined,
          // "" clears it (stored as null); undefined leaves it alone.
          description: description === undefined ? undefined : String(description ?? "").trim() || null,
          isDefault: isDefault ?? undefined,
        },
        include: { rules: true },
      });
    });

    await logAudit({
      tenantId,
      actorType: actorTypeFromUser(req.user!),
      actorId: req.user!.id,
      action: 'PRICE_LIST_UPDATED',
      module: PRICING_MODULE,
      entityType: 'PriceList',
      entityId: updated.id,
      entityLabel: updated.name,
      // Rules are deleted and recreated as a set rather than edited in place,
      // so a field-level diff would be noise — the resulting tiers are the
      // meaningful record.
      details: {
        rulesReplaced: Boolean(rows),
        isDefault: updated.isDefault,
        ...summariseRules(updated.rules),
      },
    });
    await broadcastToModule(tenantId, PRICING_MODULE, {
      type: 'priceRule.changed',
      title: 'Price rule updated',
      message: `A pricing tier changed on ${updated.name}`,
      link: `/sales/price-lists/${updated.id}`,
    });

    return res.json({ success: true, message: 'Price list updated', data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update price list' });
  }
}

/**
 * GET /:id/can-delete — the DependencyReport the shared DeleteDialog renders.
 * Always allows the delete; the dependencies are warnings about what the
 * customer on this list loses, not blockers.
 */
export async function canDeletePriceList(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const existing = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) return res.status(404).json({ success: false, message: 'Price list not found' });

    const report = await checkPriceListDependencies(tenantId, req.params.id);
    return res.json({ success: true, data: report });
  } catch (error) {
    console.error('Error checking price list dependencies:', error);
    return res.status(500).json({ success: false, message: 'Failed to check price list dependencies' });
  }
}

export async function deletePriceList(req: AuthRequest, res: Response) {
  try {
    const existing = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!existing) return res.status(404).json({ success: false, message: 'Price list not found' });

    await prisma.priceList.delete({ where: { id: req.params.id } });

    await logAudit({
      tenantId: req.tenantId!,
      actorType: actorTypeFromUser(req.user!),
      actorId: req.user!.id,
      action: 'PRICE_LIST_DELETED',
      module: PRICING_MODULE,
      entityType: 'PriceList',
      entityId: existing.id,
      entityLabel: existing.name,
      details: { isDefault: existing.isDefault },
    });
    await broadcastToModule(req.tenantId!, PRICING_MODULE, {
      type: 'priceRule.changed',
      title: 'Price list deleted',
      message: `"${existing.name}" was deleted, along with its pricing tiers`,
      link: `/sales/price-lists`,
    });

    return res.json({ success: true, message: 'Price list deleted' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to delete price list' });
  }
}

export async function assignCustomerToPriceList(req: AuthRequest, res: Response) {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ success: false, message: 'customerId is required' });

    const existing = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!existing) return res.status(404).json({ success: false, message: 'Price list not found' });

    const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: req.tenantId! }, select: { name: true } });
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    // One list per customer: the till prices from a single list, and with two
    // it picked one at random. Assigning a new list takes the customer off the old one.
    const assignment = await prisma.$transaction(async (tx) => {
      await tx.customerPriceList.deleteMany({ where: { customerId, priceListId: { not: req.params.id } } });
      return tx.customerPriceList.upsert({
        where: { customerId_priceListId: { customerId, priceListId: req.params.id } },
        update: {},
        create: { customerId, priceListId: req.params.id },
      });
    });

    auditRequest(req, {
      action: 'PRICE_LIST_CUSTOMER_ASSIGNED',
      module: 'wholesale_sales',
      entityType: 'PriceList',
      entityId: existing.id,
      entityLabel: existing.name,
      details: { customerId, customer: customer.name },
    });

    return res.status(201).json({ success: true, message: 'Customer assigned', data: assignment });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to assign customer' });
  }
}

/**
 * POST /:id/duplicate — a copy of the list and all its prices under a new
 * name, with no customers. For setting up a similar customer.
 */
export async function duplicatePriceList(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const source = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId }, include: { rules: true } });
    if (!source) return res.status(404).json({ success: false, message: 'Price list not found' });
    const name = String(req.body?.name ?? '').trim() || `${source.name} (copy)`;

    const copy = await prisma.$transaction(async (tx) => {
      const list = await tx.priceList.create({
        data: { tenantId, branchId: activeBranchId(), name, description: source.description, isDefault: false },
      });
      if (source.rules.length) {
        await tx.priceRule.createMany({
          data: source.rules.map((r) => ({
            priceListId: list.id,
            categoryId: r.categoryId,
            variantId: r.variantId,
            minQuantity: r.minQuantity,
            unitPrice: r.unitPrice,
            discountPercent: r.discountPercent,
          })),
        });
      }
      return list;
    });

    auditRequest(req, {
      action: 'PRICE_LIST_CREATED',
      module: PRICING_MODULE,
      entityType: 'PriceList',
      entityId: copy.id,
      entityLabel: copy.name,
      details: { duplicatedFrom: source.id, count: source.rules.length },
    });
    return res.status(201).json({ success: true, message: 'Price list duplicated', data: copy });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to duplicate price list' });
  }
}

/**
 * GET /for-customer/:customerId — the customer's own list with its products,
 * for loading it into a wholesale cart. data is null when they have none.
 */
export async function getCustomerPriceList(req: AuthRequest, res: Response) {
  try {
    const assignment = await prisma.customerPriceList.findFirst({
      where: {
        customerId: req.params.customerId,
        customer: { tenantId: req.tenantId! },
        priceList: { tenantId: req.tenantId! },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        priceList: {
          include: {
            rules: {
              orderBy: { minQuantity: 'asc' },
              include: {
                category: { select: { id: true, name: true, sku: true } },
                variant: { select: { id: true, label: true } },
              },
            },
          },
        },
      },
    });
    return res.json({ success: true, data: assignment?.priceList ?? null });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load the customer price list' });
  }
}

export async function removeCustomerFromPriceList(req: AuthRequest, res: Response) {
  try {
    // The price list must be this tenant's; without this check any known ids could be unlinked.
    const list = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!list) return res.status(404).json({ success: false, message: 'Price list not found' });

    await prisma.customerPriceList.deleteMany({
      where: { customerId: req.params.customerId, priceListId: req.params.id },
    });
    const customer = await prisma.customer.findFirst({ where: { id: req.params.customerId, tenantId: req.tenantId! }, select: { name: true } });
    auditRequest(req, {
      action: 'PRICE_LIST_CUSTOMER_REMOVED',
      module: 'wholesale_sales',
      entityType: 'PriceList',
      entityId: list.id,
      entityLabel: list.name,
      details: { customerId: req.params.customerId, customer: customer?.name ?? null },
    });
    return res.json({ success: true, message: 'Customer removed from price list' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to remove customer' });
  }
}
