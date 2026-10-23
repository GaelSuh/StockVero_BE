import { prisma } from '../db.js';
import { logAudit, AuditActorType } from '../services/auditService.js';
import { broadcastToModule } from '../services/notificationService.js';
import { checkPriceListDependencies } from '../services/dependencyCheckService.js';
/**
 * Price lists (and therefore price rules) live under the `wholesale_sales`
 * module — that is the moduleGuard/permissionGuard key these routes already
 * use. There is no `pricing` module: a key that matches no RolePermission row
 * would silently notify nobody but the owners.
 */
const PRICING_MODULE = 'wholesale_sales';
function actorTypeFromUser(user) {
    return user.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE;
}
/** Rules are replaced as a set, so the audit detail is the resulting tiers. */
function summariseRules(rules) {
    return {
        count: rules.length,
        tiers: rules.map((r) => ({
            categoryId: r.categoryId,
            variantId: r.variantId ?? null,
            minQuantity: r.minQuantity,
            unitPrice: String(r.unitPrice),
        })),
    };
}
export async function createPriceList(req, res) {
    try {
        const tenantId = req.tenantId;
        const { name, description, isDefault, rules } = req.body;
        if (!name)
            return res.status(400).json({ success: false, message: 'Name is required' });
        if (isDefault) {
            await prisma.priceList.updateMany({
                where: { tenantId, isDefault: true },
                data: { isDefault: false },
            });
        }
        const priceList = await prisma.priceList.create({
            data: {
                tenantId,
                name,
                description: description || null,
                isDefault: isDefault || false,
                rules: rules?.length ? {
                    create: rules.map((r) => ({
                        categoryId: r.categoryId,
                        // Without this the variant tiers of the 6-tier cascade in
                        // priceResolutionService could never be reached — the column
                        // would exist but nothing could ever set it.
                        variantId: r.variantId ?? null,
                        minQuantity: r.minQuantity || 1,
                        unitPrice: r.unitPrice,
                    })),
                } : undefined,
            },
            include: { rules: true },
        });
        // After the write, never inside it: logAudit and broadcastToModule use the
        // global prisma client, so a row written from inside a transaction that
        // later rolled back would describe something that never happened.
        await logAudit({
            tenantId,
            actorType: actorTypeFromUser(req.user),
            actorId: req.user.id,
            action: 'priceList.created',
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
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to create price list' });
    }
}
export async function listPriceLists(req, res) {
    try {
        const priceLists = await prisma.priceList.findMany({
            where: { tenantId: req.tenantId },
            include: { _count: { select: { rules: true, customers: true } } },
            orderBy: { createdAt: 'desc' },
        });
        return res.json({ success: true, data: priceLists });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to list price lists' });
    }
}
export async function getPriceList(req, res) {
    try {
        const priceList = await prisma.priceList.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
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
        if (!priceList)
            return res.status(404).json({ success: false, message: 'Price list not found' });
        return res.json({ success: true, data: priceList });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to get price list' });
    }
}
export async function updatePriceList(req, res) {
    try {
        const tenantId = req.tenantId;
        const { name, description, isDefault, rules } = req.body;
        const existing = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ success: false, message: 'Price list not found' });
        if (isDefault) {
            await prisma.priceList.updateMany({
                where: { tenantId, isDefault: true, id: { not: req.params.id } },
                data: { isDefault: false },
            });
        }
        if (rules) {
            await prisma.priceRule.deleteMany({ where: { priceListId: req.params.id } });
        }
        const updated = await prisma.priceList.update({
            where: { id: req.params.id },
            data: {
                name: name ?? undefined,
                description: description ?? undefined,
                isDefault: isDefault ?? undefined,
                rules: rules?.length ? {
                    create: rules.map((r) => ({
                        categoryId: r.categoryId,
                        variantId: r.variantId ?? null,
                        minQuantity: r.minQuantity || 1,
                        unitPrice: r.unitPrice,
                    })),
                } : undefined,
            },
            include: { rules: true },
        });
        await logAudit({
            tenantId,
            actorType: actorTypeFromUser(req.user),
            actorId: req.user.id,
            action: 'priceList.updated',
            module: PRICING_MODULE,
            entityType: 'PriceList',
            entityId: updated.id,
            entityLabel: updated.name,
            // Rules are deleted and recreated as a set rather than edited in place,
            // so a field-level diff would be noise — the resulting tiers are the
            // meaningful record.
            details: {
                rulesReplaced: Boolean(rules),
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
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to update price list' });
    }
}
/**
 * GET /:id/can-delete — the DependencyReport the shared DeleteDialog renders.
 * Always allows the delete; the dependencies are warnings about what the
 * customer on this list loses, not blockers.
 */
export async function canDeletePriceList(req, res) {
    try {
        const tenantId = req.tenantId;
        const existing = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ success: false, message: 'Price list not found' });
        const report = await checkPriceListDependencies(tenantId, req.params.id);
        return res.json({ success: true, data: report });
    }
    catch (error) {
        console.error('Error checking price list dependencies:', error);
        return res.status(500).json({ success: false, message: 'Failed to check price list dependencies' });
    }
}
export async function deletePriceList(req, res) {
    try {
        const existing = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
        if (!existing)
            return res.status(404).json({ success: false, message: 'Price list not found' });
        await prisma.priceList.delete({ where: { id: req.params.id } });
        await logAudit({
            tenantId: req.tenantId,
            actorType: actorTypeFromUser(req.user),
            actorId: req.user.id,
            action: 'priceList.deleted',
            module: PRICING_MODULE,
            entityType: 'PriceList',
            entityId: existing.id,
            entityLabel: existing.name,
            details: { isDefault: existing.isDefault },
        });
        await broadcastToModule(req.tenantId, PRICING_MODULE, {
            type: 'priceRule.changed',
            title: 'Price list deleted',
            message: `"${existing.name}" was deleted, along with its pricing tiers`,
            link: `/sales/price-lists`,
        });
        return res.json({ success: true, message: 'Price list deleted' });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to delete price list' });
    }
}
export async function assignCustomerToPriceList(req, res) {
    try {
        const { customerId } = req.body;
        if (!customerId)
            return res.status(400).json({ success: false, message: 'customerId is required' });
        const existing = await prisma.priceList.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
        if (!existing)
            return res.status(404).json({ success: false, message: 'Price list not found' });
        const assignment = await prisma.customerPriceList.upsert({
            where: { customerId_priceListId: { customerId, priceListId: req.params.id } },
            update: {},
            create: { customerId, priceListId: req.params.id },
        });
        return res.status(201).json({ success: true, message: 'Customer assigned', data: assignment });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to assign customer' });
    }
}
export async function removeCustomerFromPriceList(req, res) {
    try {
        await prisma.customerPriceList.deleteMany({
            where: { customerId: req.params.customerId, priceListId: req.params.id },
        });
        return res.json({ success: true, message: 'Customer removed from price list' });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to remove customer' });
    }
}
