import { prisma } from '../db.js';
import { logAudit, buildDiff, AuditActorType } from '../services/auditService.js';
import { broadcastToModule } from '../services/notificationService.js';
import { isUniqueViolationOn } from './inventory.items.controller.js';
import { checkProductVariantDependencies } from '../services/dependencyCheckService.js';
/**
 * Audit and notification writes go through the global prisma client and take
 * no transaction handle, so every call in this file sits AFTER its
 * transaction has committed. Logging inside the transaction would leave an
 * audit row describing a variant change that then rolled back.
 */
function actorTypeFromUser(user) {
    return user.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE;
}
/** Thrown by assertVariantQuantityWithinCeiling; caught to produce a 400. */
class VariantQuantityCeilingError extends Error {
}
/**
 * For a QUANTITY-tracked product, a variant's quantityOnHand is an allocation
 * carved out of the parent product's own quantityOnHand, not a separate count
 * invented for the variant — so the sum across every variant may never exceed
 * it. Restocking the parent (raising its quantityOnHand) is what frees more
 * room to allocate. SERIALIZED products are untouched: their variants carry
 * no meaningful quantityOnHand at all.
 *
 * `requestedQuantity` is the quantity this create/update is asking for;
 * `excludeVariantId` leaves the variant being edited out of the "already
 * allocated" sum so it isn't double-counted against itself.
 */
async function assertVariantQuantityWithinCeiling(tx, tenantId, category, requestedQuantity, excludeVariantId) {
    if (category.stockTrackingMode !== 'QUANTITY')
        return;
    const others = await tx.productVariant.aggregate({
        where: {
            tenantId,
            categoryId: category.id,
            ...(excludeVariantId ? { id: { not: excludeVariantId } } : {}),
        },
        _sum: { quantityOnHand: true },
    });
    const allocated = others._sum.quantityOnHand ?? 0;
    if (allocated + requestedQuantity > category.quantityOnHand) {
        const room = Math.max(category.quantityOnHand - allocated, 0);
        throw new VariantQuantityCeilingError(`Only ${room} unit(s) can be allocated to variants right now — ${allocated} of the ` +
            `${category.quantityOnHand} in stock ${allocated === 1 ? 'is' : 'are'} already assigned to other ` +
            `variants. Restock the product to free up more, or lower this quantity.`);
    }
}
/**
 * Flattens one combination into its display label, given an explicit axis
 * order. Shared by the single-create flow (which infers the order from the
 * product's first variant) and the matrix generator (which is told the order
 * outright) so there is one definition of what a label looks like.
 */
function labelFrom(attributes, axisOrder) {
    return axisOrder
        .map((k) => attributes[k])
        .filter((v) => v !== undefined && v !== null && v !== '')
        .join(' / ');
}
/**
 * A combination's identity, used to tell "Red / L" apart from every other
 * combination regardless of the order the keys happen to be stored in.
 * Key order is normalised because `attributes` is jsonb and does not preserve
 * insertion order — comparing the raw objects would report two identical
 * combinations as different.
 */
function combinationKey(attributes) {
    return Object.keys(attributes)
        .sort()
        .map((k) => `${k.trim().toLowerCase()}=${String(attributes[k]).trim().toLowerCase()}`)
        .join('|');
}
/**
 * Builds the flattened label for a SINGLE variant, inferring the axis order
 * from whichever variant of this product was created first. A brand-new
 * product takes its order from however the client submitted the attributes
 * object. An axis a later variant introduces is appended, never dropped.
 *
 * The matrix generator does NOT use this — it is told the axis order outright,
 * because "the product's first variant" has no meaning when a dozen are
 * created in the same call.
 *
 * There is no attribute-catalog table by design: different products have
 * completely different axes and there is no shared vocabulary worth enforcing.
 */
async function buildVariantLabel(tx, tenantId, categoryId, attributes, excludeVariantId) {
    const existing = await tx.productVariant.findFirst({
        where: { tenantId, categoryId, ...(excludeVariantId ? { id: { not: excludeVariantId } } : {}) },
        orderBy: { createdAt: 'asc' },
        select: { axisOrder: true },
    });
    // The reference order comes from the stored axisOrder column, NOT from
    // Object.keys(existing.attributes): `attributes` is jsonb, which sorts keys
    // and so reports an order nobody chose. Reading it there is what made the
    // second variant of a product label itself "M / Blue" while the first said
    // "Red / L".
    const referenceOrder = existing?.axisOrder?.length ? existing.axisOrder : Object.keys(attributes);
    // An axis a later variant introduces that the reference row didn't have is
    // appended, never dropped.
    const allKeys = [...referenceOrder, ...Object.keys(attributes).filter((k) => !referenceOrder.includes(k))];
    // Persisted alongside the label so the next variant of this product can
    // follow the same order without re-deriving it.
    const axisOrder = allKeys.filter((k) => k in attributes);
    return { label: labelFrom(attributes, allKeys), axisOrder };
}
/**
 * Both unique constraints on product_variants are per-tenant and BOTH are
 * partial (unique only where the column is set), so any number of variants may
 * have no sku and no barcode. The pre-checks give a good message for the
 * common case; this catch is what stops a race — or a duplicate barcode, which
 * has no pre-check — from surfacing as a 500.
 */
function uniqueViolationResponse(error, res) {
    if (isUniqueViolationOn(error, 'sku')) {
        res.status(409).json({ success: false, message: 'A variant with this SKU already exists.' });
        return true;
    }
    if (isUniqueViolationOn(error, 'barcode')) {
        res.status(409).json({
            success: false,
            message: 'That barcode already belongs to another variant. Use a different code.',
        });
        return true;
    }
    return false;
}
// POST /categories/:categoryId/variants
export const createVariant = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const user = req.user;
        const { categoryId } = req.params;
        const { attributes, sku, barcode, priceOverride, quantityOnHand, imageUrl, sortOrder } = req.body;
        if (!attributes ||
            typeof attributes !== 'object' ||
            Array.isArray(attributes) ||
            Object.keys(attributes).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'attributes must be a non-empty object, e.g. { "Color": "Red", "Size": "L" }',
            });
        }
        // Optional, matching generated variants: a one-off addition to a matrix
        // should not be forced to invent a code the generated ones do not have.
        const trimmedSku = typeof sku === 'string' ? sku.trim() : '';
        const category = await prisma.inventoryCategory.findFirst({ where: { id: categoryId, tenantId } });
        if (!category)
            return res.status(404).json({ success: false, message: 'Product not found' });
        if (trimmedSku) {
            const dupeSku = await prisma.productVariant.findFirst({ where: { tenantId, sku: trimmedSku } });
            if (dupeSku) {
                return res.status(409).json({ success: false, message: `A variant with sku "${trimmedSku}" already exists.` });
            }
        }
        // Only meaningful for QUANTITY products; a SERIALIZED variant's stock is
        // the count of its AVAILABLE ProductItem rows, so the column stays 0
        // rather than becoming a second, wrong answer.
        const requestedQty = category.stockTrackingMode === 'QUANTITY' ? Number(quantityOnHand ?? 0) : 0;
        const variant = await prisma.$transaction(async (tx) => {
            await assertVariantQuantityWithinCeiling(tx, tenantId, category, requestedQty);
            const { label, axisOrder } = await buildVariantLabel(tx, tenantId, categoryId, attributes);
            return tx.productVariant.create({
                data: {
                    tenantId,
                    categoryId,
                    attributes,
                    axisOrder,
                    label,
                    sku: trimmedSku || null,
                    barcode: barcode || null,
                    priceOverride: priceOverride ?? null,
                    quantityOnHand: requestedQty,
                    imageUrl: imageUrl || null,
                    sortOrder: Number(sortOrder ?? 0),
                },
            });
        });
        await logAudit({
            tenantId,
            actorType: actorTypeFromUser(user),
            actorId: user.id,
            action: 'variant.created',
            module: 'inventory',
            entityType: 'ProductVariant',
            entityId: variant.id,
            entityLabel: variant.label,
            details: { categoryId, categoryName: category.name, attributes, sku },
        });
        await broadcastToModule(tenantId, 'inventory', {
            type: 'variant.created',
            title: 'New product variant',
            message: `"${variant.label}" was added to ${category.name}`,
            link: `/inventory/categories/${categoryId}`,
        });
        return res.status(201).json({ success: true, data: variant });
    }
    catch (error) {
        if (error instanceof VariantQuantityCeilingError) {
            return res.status(400).json({ success: false, message: error.message });
        }
        if (uniqueViolationResponse(error, res))
            return;
        console.error('Error creating variant:', error);
        return res.status(500).json({ success: false, message: 'Failed to create variant' });
    }
};
/**
 * Above this, a comma-separated field has almost certainly been fed a stray
 * comma or a pasted paragraph rather than a real catalogue. Refused outright
 * instead of silently truncating, so the person sees the mistake.
 */
const MAX_GENERATED_COMBINATIONS = 200;
/** Cartesian product of the axis values, in the axis order given. */
function buildCombinations(axes) {
    return axes.reduce((acc, axis) => acc.flatMap((row) => axis.values.map((v) => ({ ...row, [axis.name]: v }))), [{}]);
}
/**
 * POST /categories/:categoryId/variants/generate
 *
 * Creates every combination of a multi-value attribute set in ONE transaction,
 * with ONE audit entry and ONE notification — the same shape updatePriceList
 * uses for a set of price rules. Looping the single-create endpoint from the
 * client would fire a dozen of each for one bulk action.
 *
 * Additive only. Combinations that already exist are skipped, and variants
 * that no longer match the submitted attribute set are LEFT ALONE — removing
 * them here would bypass the delete guard that stops a variant referenced by a
 * sale, a price rule or stock history from being destroyed. Regeneration is
 * not an exception to that rule; removal stays a deliberate deactivate.
 */
export const generateVariants = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const user = req.user;
        const { categoryId } = req.params;
        const { attributes, quantityOnHand } = req.body;
        if (!Array.isArray(attributes) || attributes.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Provide at least one attribute, e.g. { name: "Color", values: ["Red", "Blue"] }.',
            });
        }
        // Normalise: trim, drop blanks, de-duplicate case-insensitively while
        // keeping the first spelling the user typed. The axis order is exactly the
        // order submitted — it becomes axisOrder for the whole batch.
        const axes = [];
        for (const raw of attributes) {
            const name = String(raw?.name ?? '').trim();
            if (!name)
                continue;
            const seen = new Set();
            const values = [];
            for (const v of raw?.values ?? []) {
                const value = String(v ?? '').trim();
                if (!value)
                    continue;
                const key = value.toLowerCase();
                if (seen.has(key))
                    continue;
                seen.add(key);
                values.push(value);
            }
            if (values.length === 0)
                continue;
            if (axes.some((a) => a.name.toLowerCase() === name.toLowerCase()))
                continue;
            axes.push({ name, values });
        }
        if (axes.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Every attribute needs a name and at least one value.',
            });
        }
        const total = axes.reduce((n, a) => n * a.values.length, 1);
        if (total > MAX_GENERATED_COMBINATIONS) {
            return res.status(400).json({
                success: false,
                message: `That would create ${total} variants, past the limit of ${MAX_GENERATED_COMBINATIONS}. ` +
                    'Check for a stray comma or pasted text in one of the value lists.',
            });
        }
        const category = await prisma.inventoryCategory.findFirst({ where: { id: categoryId, tenantId } });
        if (!category)
            return res.status(404).json({ success: false, message: 'Product not found' });
        const axisOrder = axes.map((a) => a.name);
        const combinations = buildCombinations(axes);
        // Only meaningful for QUANTITY products — see assertVariantQuantityWithinCeiling.
        const startingQty = category.stockTrackingMode === 'QUANTITY' ? Number(quantityOnHand ?? 0) : 0;
        const result = await prisma.$transaction(async (tx) => {
            // Read inside the transaction so a concurrent generate cannot slip a
            // duplicate combination in between the check and the write.
            const existing = await tx.productVariant.findMany({
                where: { tenantId, categoryId },
                select: { attributes: true, sortOrder: true },
            });
            const taken = new Set(existing.map((v) => combinationKey((v.attributes ?? {}))));
            // Continue the existing numbering rather than restarting at 0, so a
            // second batch sorts after the first instead of interleaving.
            const startOrder = existing.reduce((max, v) => Math.max(max, v.sortOrder ?? 0), 0);
            const toCreate = combinations.filter((c) => !taken.has(combinationKey(c)));
            // The whole batch's stock request, checked against the ceiling in one
            // call rather than per row — a batch either all fits or none of it does.
            if (toCreate.length > 0 && startingQty > 0) {
                await assertVariantQuantityWithinCeiling(tx, tenantId, category, startingQty * toCreate.length);
            }
            if (toCreate.length > 0) {
                await tx.productVariant.createMany({
                    data: toCreate.map((attrs, i) => ({
                        tenantId,
                        categoryId,
                        attributes: attrs,
                        // Explicit for the whole batch: the single-create flow infers this
                        // from "the product's first variant", which has no meaning when a
                        // dozen are created in the same call.
                        axisOrder,
                        label: labelFrom(attrs, axisOrder),
                        // Left blank deliberately — a dozen auto-generated codes would be
                        // meaningless and would collide. Filled in per variant afterwards.
                        sku: null,
                        barcode: null,
                        priceOverride: null,
                        quantityOnHand: startingQty,
                        isActive: true,
                        sortOrder: startOrder + i + 1,
                    })),
                });
            }
            return { created: toCreate.length, skipped: combinations.length - toCreate.length, toCreate };
        });
        // After the commit, never inside it: logAudit and broadcastToModule use the
        // global client, so a row written inside a transaction that later rolled
        // back would describe variants that do not exist.
        await logAudit({
            tenantId,
            actorType: actorTypeFromUser(user),
            actorId: user.id,
            action: 'variant.generated',
            module: 'inventory',
            entityType: 'InventoryCategory',
            entityId: categoryId,
            entityLabel: category.name,
            // One summary of the resulting set, the same shape updatePriceList logs
            // for a set of price rules — not one entry per variant.
            details: {
                axes: axes.map((a) => ({ name: a.name, values: a.values })),
                requested: combinations.length,
                created: result.created,
                skippedExisting: result.skipped,
                labels: result.toCreate.map((c) => labelFrom(c, axisOrder)),
            },
        });
        if (result.created > 0) {
            await broadcastToModule(tenantId, 'inventory', {
                type: 'variant.created',
                title: 'Product variants added',
                message: `${result.created} variant${result.created === 1 ? '' : 's'} added to ${category.name}`,
                link: `/inventory/categories/${categoryId}`,
            });
        }
        return res.status(201).json({
            success: true,
            message: result.skipped > 0
                ? `${result.created} variant(s) created, ${result.skipped} already existed.`
                : `${result.created} variant(s) created.`,
            data: { created: result.created, skipped: result.skipped, total: combinations.length },
        });
    }
    catch (error) {
        if (error instanceof VariantQuantityCeilingError) {
            return res.status(400).json({ success: false, message: error.message });
        }
        if (uniqueViolationResponse(error, res))
            return;
        console.error('Error generating variants:', error);
        return res.status(500).json({ success: false, message: 'Failed to generate variants' });
    }
};
/**
 * POST /variants/:id/assign-units
 *
 * Attaches a set of existing units to one variant in a single transaction with
 * ONE audit entry. Looping the single-unit update endpoint would write one
 * audit row per unit for a single thing the person did once — the same reason
 * the matrix generator is a batch endpoint.
 *
 * Deliberately no notification: this feature's notification scope is variant
 * create/delete and price-rule changes, and backfilling attribution onto
 * existing stock is not a change anyone else needs pinged about.
 */
export const assignUnitsToVariant = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const user = req.user;
        const variantId = req.params.id;
        const { unitIds } = req.body;
        if (!Array.isArray(unitIds) || unitIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Select at least one unit.' });
        }
        const variant = await prisma.productVariant.findFirst({
            where: { id: variantId, tenantId },
            select: { id: true, label: true, isActive: true, categoryId: true },
        });
        if (!variant)
            return res.status(404).json({ success: false, message: 'Variant not found' });
        // Same guard as the single-unit path, not a looser one.
        if (!variant.isActive) {
            return res.status(422).json({
                success: false,
                message: 'That variant is deactivated. Reactivate it before assigning stock to it.',
            });
        }
        const category = await prisma.inventoryCategory.findFirst({
            where: { id: variant.categoryId, tenantId },
            select: { id: true, name: true, stockTrackingMode: true },
        });
        if (!category)
            return res.status(404).json({ success: false, message: 'Product not found' });
        if (category.stockTrackingMode !== 'SERIALIZED') {
            return res.status(422).json({
                success: false,
                message: 'This product is counted by quantity, so it has no individual units to assign.',
            });
        }
        const result = await prisma.$transaction(async (tx) => {
            // Scoped to this tenant, this product, and AVAILABLE only — all inside
            // the transaction, so a unit sold between the check and the write cannot
            // slip through. Reassigning a unit that has already left the shop
            // achieves nothing (it cannot change what a past sale recorded) and
            // would leave its current variant disagreeing with what was sold.
            const eligible = await tx.productItem.findMany({
                where: {
                    id: { in: unitIds },
                    tenantId,
                    categoryId: variant.categoryId,
                    stockStatus: 'AVAILABLE',
                },
                select: { id: true },
            });
            const eligibleIds = eligible.map((u) => u.id);
            if (eligibleIds.length > 0) {
                await tx.productItem.updateMany({
                    where: { id: { in: eligibleIds } },
                    data: { variantId: variant.id },
                });
            }
            return { assigned: eligibleIds.length, rejected: unitIds.length - eligibleIds.length };
        });
        if (result.assigned === 0) {
            return res.status(422).json({
                success: false,
                message: 'None of those units could be assigned. They must belong to this product and still be in stock.',
            });
        }
        // After the commit — logAudit uses the global client, so a row written
        // inside a rolled-back transaction would describe something that never was.
        await logAudit({
            tenantId,
            actorType: actorTypeFromUser(user),
            actorId: user.id,
            action: 'variant.unitsAssigned',
            module: 'inventory',
            entityType: 'ProductVariant',
            entityId: variant.id,
            entityLabel: variant.label,
            // One summary of the batch, not one entry per unit.
            details: {
                categoryId: category.id,
                categoryName: category.name,
                assigned: result.assigned,
                rejected: result.rejected,
                unitIds,
            },
        });
        return res.json({
            success: true,
            message: result.rejected > 0
                ? `${result.assigned} unit(s) assigned to "${variant.label}". ${result.rejected} skipped — already sold or not part of this product.`
                : `${result.assigned} unit(s) assigned to "${variant.label}".`,
            data: result,
        });
    }
    catch (error) {
        console.error('Error assigning units to variant:', error);
        return res.status(500).json({ success: false, message: 'Failed to assign units' });
    }
};
// GET /categories/:categoryId/variants
export const listVariants = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const { categoryId } = req.params;
        const includeInactive = req.query.includeInactive === 'true';
        const variants = await prisma.productVariant.findMany({
            where: { tenantId, categoryId, ...(includeInactive ? {} : { isActive: true }) },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        return res.json({ success: true, data: variants });
    }
    catch (error) {
        console.error('Error listing variants:', error);
        return res.status(500).json({ success: false, message: 'Failed to list variants' });
    }
};
/**
 * GET /variants — every variant for the tenant, in one call.
 *
 * The per-category `listVariants` above backs the management UI; this backs
 * the offline catalogue sync, which needs the whole set in a single request
 * rather than one per product. Capped at the same 5000 ceiling the items
 * endpoint uses — a tenant past that is far outside what a device should be
 * mirroring anyway, and silently truncating is better than timing out the
 * whole sync.
 */
const MAX_SYNC_VARIANTS = 5000;
export const listAllVariantsForTenant = async (req, res) => {
    try {
        const variants = await prisma.productVariant.findMany({
            where: { tenantId: req.tenantId },
            orderBy: { createdAt: 'asc' },
            take: MAX_SYNC_VARIANTS,
        });
        return res.json({ success: true, data: variants });
    }
    catch (error) {
        console.error('Error listing variants for tenant:', error);
        return res.status(500).json({ success: false, message: 'Failed to list variants' });
    }
};
// GET /variants/:id
export const getVariant = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const variant = await prisma.productVariant.findFirst({ where: { id: req.params.id, tenantId } });
        if (!variant)
            return res.status(404).json({ success: false, message: 'Variant not found' });
        return res.json({ success: true, data: variant });
    }
    catch (error) {
        console.error('Error getting variant:', error);
        return res.status(500).json({ success: false, message: 'Failed to get variant' });
    }
};
// PATCH /variants/:id
export const updateVariant = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const user = req.user;
        const existing = await prisma.productVariant.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ success: false, message: 'Variant not found' });
        const { attributes, sku, barcode, priceOverride, quantityOnHand, imageUrl, sortOrder } = req.body;
        if (sku && sku.trim() && sku.trim() !== existing.sku) {
            const dupeSku = await prisma.productVariant.findFirst({
                where: { tenantId, sku: sku.trim(), id: { not: existing.id } },
            });
            if (dupeSku) {
                return res.status(409).json({ success: false, message: `A variant with sku "${sku.trim()}" already exists.` });
            }
        }
        // Needed only to validate a quantityOnHand change against the ceiling —
        // fetched once, outside the transaction, since it never changes here.
        const category = quantityOnHand !== undefined
            ? await prisma.inventoryCategory.findFirst({ where: { id: existing.categoryId, tenantId } })
            : null;
        if (quantityOnHand !== undefined && !category) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }
        const updated = await prisma.$transaction(async (tx) => {
            const nextAttributes = attributes && typeof attributes === 'object' ? attributes : existing.attributes;
            const rebuilt = attributes
                ? await buildVariantLabel(tx, tenantId, existing.categoryId, nextAttributes, existing.id)
                : { label: existing.label, axisOrder: existing.axisOrder };
            // Restocking a variant (or correcting a mis-typed opening quantity) —
            // only ever meaningful for QUANTITY products, same rule as creation.
            let nextQuantity = existing.quantityOnHand;
            if (quantityOnHand !== undefined && category?.stockTrackingMode === 'QUANTITY') {
                nextQuantity = Number(quantityOnHand) || 0;
                await assertVariantQuantityWithinCeiling(tx, tenantId, category, nextQuantity, existing.id);
            }
            return tx.productVariant.update({
                where: { id: existing.id },
                data: {
                    attributes: nextAttributes,
                    axisOrder: rebuilt.axisOrder,
                    label: rebuilt.label,
                    // Empty string clears it back to "no sku", which the partial unique
                    // index allows for any number of variants.
                    sku: sku !== undefined ? (String(sku).trim() || null) : existing.sku,
                    barcode: barcode !== undefined ? barcode || null : existing.barcode,
                    priceOverride: priceOverride !== undefined ? priceOverride : existing.priceOverride,
                    quantityOnHand: nextQuantity,
                    imageUrl: imageUrl !== undefined ? imageUrl || null : existing.imageUrl,
                    sortOrder: sortOrder !== undefined ? Number(sortOrder) : existing.sortOrder,
                },
            });
        });
        await logAudit({
            tenantId,
            actorType: actorTypeFromUser(user),
            actorId: user.id,
            action: 'variant.updated',
            module: 'inventory',
            entityType: 'ProductVariant',
            entityId: updated.id,
            entityLabel: updated.label,
            details: buildDiff(existing, updated),
        });
        return res.json({ success: true, data: updated });
    }
    catch (error) {
        if (error instanceof VariantQuantityCeilingError) {
            return res.status(400).json({ success: false, message: error.message });
        }
        if (uniqueViolationResponse(error, res))
            return;
        console.error('Error updating variant:', error);
        return res.status(500).json({ success: false, message: 'Failed to update variant' });
    }
};
// PATCH /variants/:id/deactivate and /variants/:id/reactivate
export const setVariantActive = (isActive) => async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const user = req.user;
        const existing = await prisma.productVariant.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ success: false, message: 'Variant not found' });
        const updated = await prisma.productVariant.update({ where: { id: existing.id }, data: { isActive } });
        await logAudit({
            tenantId,
            actorType: actorTypeFromUser(user),
            actorId: user.id,
            action: isActive ? 'variant.reactivated' : 'variant.deactivated',
            module: 'inventory',
            entityType: 'ProductVariant',
            entityId: updated.id,
            entityLabel: updated.label,
        });
        return res.json({ success: true, data: updated });
    }
    catch (error) {
        console.error('Error setting variant active state:', error);
        return res.status(500).json({ success: false, message: 'Failed to update variant' });
    }
};
/**
 * GET /variants/:id/can-delete
 *
 * Returns the DependencyReport shape the shared DeleteDialog component
 * expects, so a user sees exactly what is blocking a delete before they
 * confirm it. The DELETE below still re-checks — this endpoint is the
 * explanation, not the enforcement.
 */
export const canDeleteVariant = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const variant = await prisma.productVariant.findFirst({ where: { id: req.params.id, tenantId } });
        if (!variant)
            return res.status(404).json({ success: false, message: 'Variant not found' });
        const report = await checkProductVariantDependencies(variant.id, tenantId);
        return res.json({ success: true, data: report });
    }
    catch (error) {
        console.error('Error checking variant delete dependencies:', error);
        return res.status(500).json({ success: false, message: 'Failed to check variant dependencies' });
    }
};
// DELETE /variants/:id
export const deleteVariant = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const user = req.user;
        const variant = await prisma.productVariant.findFirst({ where: { id: req.params.id, tenantId } });
        if (!variant)
            return res.status(404).json({ success: false, message: 'Variant not found' });
        // All five tables that can reference a variant, checked explicitly —
        // three of them (SaleItem/SaleReturnItem/CategoryStockLog) would NOT be
        // stopped by the database's own onDelete rules (SetNull/SetNull/Cascade),
        // so this check is the only thing standing between a delete and quietly
        // corrupted sale history. Only ProductItem (Restrict) and PriceRule would
        // be caught by Postgres on their own.
        const [itemCount, priceRuleCount, saleItemCount, returnItemCount, stockLogCount] = await Promise.all([
            prisma.productItem.count({ where: { variantId: variant.id } }),
            prisma.priceRule.count({ where: { variantId: variant.id } }),
            prisma.saleItem.count({ where: { variantId: variant.id } }),
            prisma.saleReturnItem.count({ where: { variantId: variant.id } }),
            prisma.categoryStockLog.count({ where: { variantId: variant.id } }),
        ]);
        const blockers = [];
        if (itemCount > 0)
            blockers.push(`${itemCount} stock unit${itemCount === 1 ? '' : 's'}`);
        if (priceRuleCount > 0)
            blockers.push(`${priceRuleCount} price rule${priceRuleCount === 1 ? '' : 's'}`);
        if (saleItemCount > 0)
            blockers.push(`${saleItemCount} sale record${saleItemCount === 1 ? '' : 's'}`);
        if (returnItemCount > 0)
            blockers.push(`${returnItemCount} return record${returnItemCount === 1 ? '' : 's'}`);
        if (stockLogCount > 0)
            blockers.push(`${stockLogCount} stock log entr${stockLogCount === 1 ? 'y' : 'ies'}`);
        if (blockers.length > 0) {
            return res.status(409).json({
                success: false,
                message: `Cannot delete "${variant.label}" — it is still referenced by ${blockers.join(', ')}. Deactivate it instead so it stays out of new sales while its history stays intact.`,
            });
        }
        await prisma.productVariant.delete({ where: { id: variant.id } });
        await logAudit({
            tenantId,
            actorType: actorTypeFromUser(user),
            actorId: user.id,
            action: 'variant.deleted',
            module: 'inventory',
            entityType: 'ProductVariant',
            entityId: variant.id,
            entityLabel: variant.label,
            details: { categoryId: variant.categoryId, sku: variant.sku },
        });
        await broadcastToModule(tenantId, 'inventory', {
            type: 'variant.deleted',
            title: 'Product variant deleted',
            message: `"${variant.label}" was deleted`,
            link: `/inventory/categories/${variant.categoryId}`,
        });
        return res.json({ success: true, message: 'Variant deleted' });
    }
    catch (error) {
        console.error('Error deleting variant:', error);
        return res.status(500).json({ success: false, message: 'Failed to delete variant' });
    }
};
