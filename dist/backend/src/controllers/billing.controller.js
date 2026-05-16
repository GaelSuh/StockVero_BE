import { z } from 'zod';
import { prisma } from '../db.js';
import { broadcastToModule } from '../services/notificationService.js';
import { sendEmail } from '../services/emailService.js';
import { subscriptionCancelled } from '../emails/templates.js';
import { PRICING_MODULES, PRICING_MODULE_KEYS, BILLING_CYCLES, calculatePricing, resolveOrganisationSizeKey, } from '../lib/pricing.js';
import { buildSubscriptionModulePayload, calculateProrationAmount, ensureTenantModuleEnabled, recalcSubscriptionAmounts, toDecimal, } from '../services/billing.service.js';
import { getSystemAdminId } from '../services/system-admin.service.js';
import { logAuditAction } from '../services/audit.service.js';
const AddModuleSchema = z.object({
    moduleKey: z.string().min(1),
});
const RemoveModuleSchema = z.object({
    moduleKey: z.string().min(1),
});
const PaymentMethodSchema = z.object({
    type: z.enum(['CARD', 'MTN_MOMO', 'ORANGE_MOMO']),
    cardNumber: z.string().optional(),
    expiryMonth: z.number().int().min(1).max(12).optional(),
    expiryYear: z.number().int().min(2024).optional(),
    holderName: z.string().optional(),
    momoPhone: z.string().optional(),
    country: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zipCode: z.string().optional(),
});
const CycleSchema = z.object({
    billingCycle: z.enum(['MONTHLY', 'ANNUAL']),
});
const CancelSchema = z.object({
    confirmation: z.string().min(1),
    reason: z.string().optional(),
});
function detectCardBrand(cardNumber) {
    if (!cardNumber)
        return null;
    if (cardNumber.startsWith('4'))
        return 'Visa';
    if (cardNumber.startsWith('5'))
        return 'Mastercard';
    return null;
}
function maskPaymentMethod(method) {
    if (!method)
        return null;
    if (method.type === 'CARD') {
        return {
            id: method.id,
            type: method.type,
            cardBrand: method.cardBrand,
            lastFour: method.lastFour,
            holderName: method.holderName,
            expiryMonth: method.expiryMonth,
            expiryYear: method.expiryYear,
            maskedNumber: method.lastFour ? `���� ���� ���� ${method.lastFour}` : null,
            isVerified: method.isVerified,
            createdAt: method.createdAt,
        };
    }
    const phone = method.momoPhone || '';
    const masked = phone ? `+237 ������${phone.slice(-4)}` : null;
    return {
        id: method.id,
        type: method.type,
        momoPhoneMasked: masked,
        holderName: method.holderName,
        isVerified: method.isVerified,
        createdAt: method.createdAt,
    };
}
export const getBillingOverview = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const tenant = await prisma.tenant.findUnique({
            where: { id: tenantId },
            include: {
                subscription: true,
                subscriptionModules: true,
            },
        });
        if (!tenant || !tenant.subscription) {
            return res.status(404).json({
                success: false,
                message: 'Subscription not found',
            });
        }
        const moduleMap = new Map(PRICING_MODULES.map((m) => [m.key, m]));
        const modules = tenant.subscriptionModules.map((mod) => ({
            id: mod.id,
            moduleKey: mod.moduleKey,
            status: mod.status,
            monthlyPrice: Number(mod.monthlyPrice),
            displayName: moduleMap.get(mod.moduleKey)?.displayName || mod.moduleKey,
            description: moduleMap.get(mod.moduleKey)?.description || null,
            addedAt: mod.addedAt,
            scheduledRemovalAt: mod.scheduledRemovalAt,
            removedAt: mod.removedAt,
        }));
        return res.status(200).json({
            success: true,
            data: {
                subscription: {
                    status: tenant.subscription.status,
                    billingCycle: tenant.subscription.billingCycle,
                    monthlyAmount: Number(tenant.subscription.monthlyAmount),
                    annualAmount: Number(tenant.subscription.annualAmount),
                    trialEndsAt: tenant.subscription.trialEndsAt,
                    currentPeriodStart: tenant.subscription.currentPeriodStart,
                    currentPeriodEnd: tenant.subscription.currentPeriodEnd,
                    cancelledAt: tenant.subscription.cancelledAt,
                    pendingCycleChange: tenant.subscription.pendingCycleChange,
                },
                tenant: {
                    nextBillingDate: tenant.nextBillingDate,
                    isTrialActive: tenant.isTrialActive,
                    trialEndsAt: tenant.trialEndsAt,
                    organisationSize: tenant.organisationSize,
                },
                modules,
            },
        });
    }
    catch (error) {
        console.error('Error fetching billing overview:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to load billing overview',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const getBillingModules = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const tenant = await prisma.tenant.findUnique({
            where: { id: tenantId },
            include: { subscriptionModules: true },
        });
        if (!tenant) {
            return res.status(404).json({
                success: false,
                message: 'Tenant not found',
            });
        }
        const activeModules = tenant.subscriptionModules.filter((m) => m.status !== 'REMOVED');
        const activeKeys = new Set(activeModules.map((m) => m.moduleKey));
        const availableModules = PRICING_MODULES.filter((m) => !activeKeys.has(m.key)).map((m) => ({
            moduleKey: m.key,
            displayName: m.displayName,
            description: m.description,
            monthlyPrice: m.monthlyPrice,
        }));
        const activeForPricing = tenant.subscriptionModules
            .filter((m) => m.status === 'ACTIVE')
            .map((m) => m.moduleKey);
        const breakdown = calculatePricing({
            modules: activeForPricing,
            organisationSize: resolveOrganisationSizeKey(tenant.organisationSize || 0),
            billingCycle: BILLING_CYCLES.MONTHLY,
        });
        return res.status(200).json({
            success: true,
            data: {
                activeModules: activeModules.map((m) => ({
                    moduleKey: m.moduleKey,
                    status: m.status,
                    monthlyPrice: Number(m.monthlyPrice),
                    addedAt: m.addedAt,
                    scheduledRemovalAt: m.scheduledRemovalAt,
                })),
                availableModules,
                pricing: breakdown,
            },
        });
    }
    catch (error) {
        console.error('Error fetching billing modules:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to load billing modules',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const addBillingModule = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const parsed = AddModuleSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const moduleKey = parsed.data.moduleKey.toLowerCase();
        if (!PRICING_MODULE_KEYS.includes(moduleKey)) {
            return res.status(422).json({
                success: false,
                message: 'Unknown module key',
            });
        }
        const subscription = await prisma.subscription.findUnique({
            where: { tenantId },
        });
        if (!subscription) {
            return res.status(404).json({
                success: false,
                message: 'Subscription not found',
            });
        }
        const existing = await prisma.subscriptionModule.findUnique({
            where: { tenantId_moduleKey: { tenantId, moduleKey } },
        });
        if (existing && existing.status !== 'REMOVED') {
            return res.status(409).json({
                success: false,
                message: 'Module already active on subscription',
            });
        }
        const modulePayload = buildSubscriptionModulePayload(moduleKey);
        const now = new Date();
        await prisma.$transaction(async (tx) => {
            if (!existing) {
                await tx.subscriptionModule.create({
                    data: {
                        tenantId,
                        moduleKey,
                        status: 'ACTIVE',
                        addedAt: now,
                        monthlyPrice: toDecimal(modulePayload.monthlyPrice),
                    },
                });
            }
            else {
                await tx.subscriptionModule.update({
                    where: { id: existing.id },
                    data: {
                        status: 'ACTIVE',
                        addedAt: now,
                        removedAt: null,
                        scheduledRemovalAt: null,
                        monthlyPrice: toDecimal(modulePayload.monthlyPrice),
                    },
                });
            }
            await ensureTenantModuleEnabled(tenantId, moduleKey, tx);
            const proratedAmount = calculateProrationAmount({
                modulePrice: modulePayload.monthlyPrice,
                periodStart: subscription.currentPeriodStart,
                periodEnd: subscription.currentPeriodEnd,
                chargedAt: now,
            });
            await tx.paymentTransaction.create({
                data: {
                    tenantId,
                    subscriptionId: subscription.id,
                    amount: toDecimal(proratedAmount),
                    currency: 'XAF',
                    status: 'COMPLETED',
                    type: 'MODULE_ADDED',
                    description: `Prorated charge - ${moduleKey}`,
                    paidAt: now,
                },
            });
            await recalcSubscriptionAmounts(tenantId, tx);
        });
        const systemAdminId = await getSystemAdminId();
        await logAuditAction(systemAdminId, tenantId, 'MODULE_ADDED', {
            moduleKey,
        });
        // Notify authorized users
        await broadcastToModule(tenantId, 'billing', {
            type: 'billing.module.added',
            title: 'Subscription Module Added',
            message: `The ${moduleKey} module has been added to your subscription.`,
            link: '/billing',
        });
        return res.status(200).json({
            success: true,
            message: 'Module added',
        });
    }
    catch (error) {
        console.error('Error adding billing module:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to add module',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const removeBillingModule = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const parsed = RemoveModuleSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const moduleKey = parsed.data.moduleKey.toLowerCase();
        if (!PRICING_MODULE_KEYS.includes(moduleKey) || moduleKey === 'dashboard') {
            return res.status(422).json({
                success: false,
                message: 'Module cannot be removed',
            });
        }
        const tenant = await prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { nextBillingDate: true },
        });
        if (!tenant) {
            return res.status(404).json({
                success: false,
                message: 'Tenant not found',
            });
        }
        const moduleRow = await prisma.subscriptionModule.findUnique({
            where: { tenantId_moduleKey: { tenantId, moduleKey } },
        });
        if (!moduleRow || moduleRow.status !== 'ACTIVE') {
            return res.status(404).json({
                success: false,
                message: 'Module not active',
            });
        }
        const scheduleDate = tenant.nextBillingDate || moduleRow.scheduledRemovalAt || new Date();
        const updated = await prisma.subscriptionModule.update({
            where: { id: moduleRow.id },
            data: {
                status: 'PENDING_REMOVAL',
                scheduledRemovalAt: scheduleDate,
            },
        });
        // Notify authorized users
        await broadcastToModule(tenantId, 'billing', {
            type: 'billing.module.removed',
            title: 'Module Removal Scheduled',
            message: `The ${moduleKey} module is scheduled for removal at the end of the billing period.`,
            link: '/billing',
        });
        return res.status(200).json({
            success: true,
            message: 'Module scheduled for removal',
            data: {
                moduleKey: updated.moduleKey,
                status: updated.status,
                scheduledRemovalAt: updated.scheduledRemovalAt,
            },
        });
    }
    catch (error) {
        console.error('Error scheduling module removal:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to remove module',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const cancelModuleRemoval = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const parsed = RemoveModuleSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const moduleKey = parsed.data.moduleKey.toLowerCase();
        const moduleRow = await prisma.subscriptionModule.findUnique({
            where: { tenantId_moduleKey: { tenantId, moduleKey } },
        });
        if (!moduleRow || moduleRow.status !== 'PENDING_REMOVAL') {
            return res.status(404).json({
                success: false,
                message: 'Module not pending removal',
            });
        }
        const updated = await prisma.subscriptionModule.update({
            where: { id: moduleRow.id },
            data: {
                status: 'ACTIVE',
                scheduledRemovalAt: null,
            },
        });
        return res.status(200).json({
            success: true,
            message: 'Removal cancelled',
            data: {
                moduleKey: updated.moduleKey,
                status: updated.status,
            },
        });
    }
    catch (error) {
        console.error('Error cancelling removal:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to cancel removal',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const getPaymentMethod = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const method = await prisma.paymentMethod.findFirst({
            where: { tenantId, isDefault: true },
            orderBy: { createdAt: 'desc' },
        });
        return res.status(200).json({
            success: true,
            data: maskPaymentMethod(method),
        });
    }
    catch (error) {
        console.error('Error fetching payment method:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to load payment method',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const updatePaymentMethod = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const parsed = PaymentMethodSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const data = parsed.data;
        if (data.type === 'CARD' && !data.cardNumber) {
            return res.status(400).json({
                success: false,
                message: 'Card number is required',
            });
        }
        if (data.type !== 'CARD' && !data.momoPhone) {
            return res.status(400).json({
                success: false,
                message: 'Mobile money phone is required',
            });
        }
        const cardBrand = data.type === 'CARD' ? detectCardBrand(data.cardNumber) : null;
        const lastFour = data.cardNumber ? data.cardNumber.slice(-4) : null;
        await prisma.paymentMethod.updateMany({
            where: { tenantId },
            data: { isDefault: false },
        });
        const method = await prisma.paymentMethod.create({
            data: {
                tenantId,
                type: data.type,
                isDefault: true,
                lastFour,
                cardBrand,
                holderName: data.holderName || null,
                expiryMonth: data.expiryMonth || null,
                expiryYear: data.expiryYear || null,
                momoPhone: data.momoPhone || null,
                country: data.country || null,
                city: data.city || null,
                state: data.state || null,
                zipCode: data.zipCode || null,
                isVerified: false,
            },
        });
        // Notify authorized users
        await broadcastToModule(tenantId, 'billing', {
            type: 'billing.payment_method.updated',
            title: 'Payment Method Updated',
            message: `A new ${data.type} payment method has been set as default.`,
            link: '/billing',
        });
        return res.status(200).json({
            success: true,
            message: 'Payment method updated',
            data: maskPaymentMethod(method),
        });
    }
    catch (error) {
        console.error('Error updating payment method:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update payment method',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const requestBillingCycleChange = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const parsed = CycleSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
        if (!subscription) {
            return res.status(404).json({
                success: false,
                message: 'Subscription not found',
            });
        }
        if (subscription.billingCycle === parsed.data.billingCycle) {
            return res.status(200).json({
                success: true,
                message: 'Billing cycle already active',
            });
        }
        await prisma.subscription.update({
            where: { tenantId },
            data: { pendingCycleChange: parsed.data.billingCycle },
        });
        return res.status(200).json({
            success: true,
            message: 'Billing cycle change scheduled',
        });
    }
    catch (error) {
        console.error('Error scheduling billing cycle change:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to schedule billing cycle change',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const getBillingTransactions = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const page = req.query.page ? Number(req.query.page) : 1;
        const limit = req.query.limit ? Number(req.query.limit) : 20;
        const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
        const skip = (page - 1) * limit;
        const where = { tenantId };
        if (status)
            where.status = status;
        const [rows, total] = await Promise.all([
            prisma.paymentTransaction.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                include: { paymentMethod: true },
            }),
            prisma.paymentTransaction.count({ where }),
        ]);
        return res.status(200).json({
            success: true,
            data: rows.map((row) => ({
                id: row.id,
                amount: Number(row.amount),
                currency: row.currency,
                status: row.status,
                type: row.type,
                description: row.description,
                reference: row.reference,
                failureReason: row.failureReason,
                paidAt: row.paidAt,
                createdAt: row.createdAt,
                paymentMethod: maskPaymentMethod(row.paymentMethod),
            })),
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit) || 1,
            },
        });
    }
    catch (error) {
        console.error('Error fetching billing transactions:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to load transactions',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const cancelSubscription = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const parsed = CancelSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        if (parsed.data.confirmation !== 'CANCEL') {
            return res.status(422).json({
                success: false,
                message: 'Confirmation text must be CANCEL',
            });
        }
        const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
        if (!subscription) {
            return res.status(404).json({
                success: false,
                message: 'Subscription not found',
            });
        }
        const updated = await prisma.subscription.update({
            where: { tenantId },
            data: {
                status: 'CANCELLED',
                cancelledAt: new Date(),
                cancellationReason: parsed.data.reason || 'Tenant requested cancellation',
            },
        });
        const systemAdminId = await getSystemAdminId();
        await logAuditAction(systemAdminId, tenantId, 'SUBSCRIPTION_CANCELLED', {
            reason: updated.cancellationReason,
        });
        const tenant = await prisma.tenant.findUnique({
            where: { id: tenantId },
            include: { users: true, subscription: true },
        });
        if (tenant?.users[0]) {
            void sendEmail({
                to: tenant.users[0].email,
                subject: 'Your StockVero subscription has been cancelled',
                html: subscriptionCancelled({
                    ownerName: `${tenant.users[0].firstName} ${tenant.users[0].lastName}`,
                    orgName: tenant.name,
                    accessEndsAt: updated.currentPeriodEnd.toLocaleDateString(),
                }),
            });
            // TODO: In production, verify EMAIL_FROM domain in Resend dashboard
        }
        return res.status(200).json({
            success: true,
            message: 'Subscription cancelled',
            data: {
                status: updated.status,
                currentPeriodEnd: updated.currentPeriodEnd,
            },
        });
    }
    catch (error) {
        console.error('Error cancelling subscription:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to cancel subscription',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
