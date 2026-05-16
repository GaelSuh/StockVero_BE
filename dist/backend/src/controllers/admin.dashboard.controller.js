import { prisma } from '../db.js';
import { MODULE_KEYS } from '../config/modules.js';
import { addDays } from '../lib/dates.js';
export const getAdminDashboard = async (req, res) => {
    try {
        const [totalTenants, pendingApprovalCount, activeTenants, suspendedTenants, inactiveTenants, trialingTenants, totalOwners, totalEmployees, planGroups, recentSignups, recentlyApproved, trialsEndingSoon,] = await Promise.all([
            prisma.tenant.count(),
            prisma.tenant.count({ where: { status: 'PENDING_APPROVAL' } }),
            prisma.tenant.count({ where: { status: 'ACTIVE' } }),
            prisma.tenant.count({ where: { status: 'SUSPENDED' } }),
            prisma.tenant.count({ where: { status: 'INACTIVE' } }),
            prisma.tenant.count({ where: { isTrialActive: true, trialEndsAt: { not: null } } }),
            prisma.user.count({ where: { role: 'CLIENT_OWNER' } }),
            prisma.employee.count(),
            prisma.tenant.groupBy({
                by: ['subscriptionPlan'],
                _count: { _all: true },
            }),
            prisma.tenant.findMany({
                where: { status: 'PENDING_APPROVAL' },
                orderBy: { createdAt: 'desc' },
                take: 5,
                include: {
                    users: {
                        where: { role: 'CLIENT_OWNER' },
                        select: { email: true, firstName: true, lastName: true },
                    },
                    modules: { where: { isEnabled: true }, select: { moduleKey: true } },
                },
            }),
            prisma.tenant.findMany({
                where: { status: 'ACTIVE', approvedAt: { not: null } },
                orderBy: { approvedAt: 'desc' },
                take: 5,
                select: { id: true, name: true, approvedAt: true },
            }),
            prisma.tenant.findMany({
                where: {
                    isTrialActive: true,
                    trialEndsAt: {
                        gte: new Date(),
                        lte: addDays(new Date(), 3),
                    },
                },
                orderBy: { trialEndsAt: 'asc' },
                take: 5,
                include: {
                    paymentMethods: { where: { isDefault: true }, take: 1, orderBy: { createdAt: 'desc' } },
                },
            }),
        ]);
        const moduleKeys = Object.values(MODULE_KEYS).filter(key => key !== MODULE_KEYS.SETTINGS && key !== MODULE_KEYS.BILLING);
        // Single groupBy instead of N separate COUNT queries
        const grouped = await prisma.tenantModule.groupBy({
            by: ['moduleKey'],
            where: {
                moduleKey: { in: moduleKeys },
                isEnabled: true,
                tenant: { status: 'ACTIVE' },
            },
            _count: { _all: true },
        });
        const groupedMap = {};
        for (const g of grouped)
            groupedMap[g.moduleKey] = g._count._all;
        const moduleAdoptionRates = moduleKeys.map((moduleKey) => {
            const enabledCount = groupedMap[moduleKey] ?? 0;
            const percentage = activeTenants > 0
                ? Math.round((enabledCount / activeTenants) * 1000) / 10
                : 0;
            return { moduleKey, enabledCount, percentage };
        });
        const planBreakdown = planGroups.map(group => ({
            plan: group.subscriptionPlan,
            count: group._count._all,
        }));
        return res.status(200).json({
            success: true,
            data: {
                totalTenants,
                pendingApprovalCount,
                activeTenants,
                suspendedTenants,
                inactiveTenants,
                trialingTenants,
                totalOwners,
                totalEmployees,
                planBreakdown,
                moduleAdoptionRates,
                recentSignups: recentSignups.map(tenant => ({
                    id: tenant.id,
                    name: tenant.name,
                    slug: tenant.subdomain,
                    createdAt: tenant.createdAt,
                    ownerEmail: tenant.users[0]?.email || null,
                    ownerName: tenant.users[0]
                        ? `${tenant.users[0].firstName} ${tenant.users[0].lastName}`.trim()
                        : null,
                    requestedModules: tenant.modules
                        .map(m => m.moduleKey)
                        .filter(key => key !== MODULE_KEYS.SETTINGS && key !== MODULE_KEYS.BILLING),
                })),
                recentlyApproved,
                trialsEndingSoon: trialsEndingSoon.map((tenant) => ({
                    id: tenant.id,
                    name: tenant.name,
                    trialEndsAt: tenant.trialEndsAt,
                    paymentMethodType: tenant.paymentMethods[0]?.type || null,
                })),
            },
        });
    }
    catch (error) {
        console.error('Error fetching admin dashboard:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to load dashboard',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
