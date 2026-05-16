import { Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '../db.js';
import { AdminRequest } from '../types/index.js';
import { MODULE_KEYS, MODULES_CONFIG } from '../config/modules.js';
import { parsePagination, buildPaginationMeta } from '../lib/pagination.js';
import { isValidSlug } from '../lib/slug.js';
import { generateTemporaryPassword } from '../lib/passwords.js';
import { getDefaultTheme } from '../lib/theme.js';
import { logAuditAction } from '../services/audit.service.js';
import {
  PRICING_MODULES,
  PRICING_MODULE_KEYS,
  calculatePricing,
  resolveOrganisationSizeKey,
  TRIAL_DAYS,
} from '../lib/pricing.js';
import { getPeriodEnd, toDecimal } from '../services/billing.service.js';
import { addDays } from '../lib/dates.js';
import { sendEmail } from '../services/emailService.js';
import { tenantApproved as tenantApprovedEmail, tenantDenied as tenantDeniedEmail, tenantSuspended as tenantSuspendedEmail } from '../emails/templates.js';

const CreateTenantSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  industry: z.string().optional(),
  website: z.string().optional(),
  phone: z.string().optional(),
  country: z.string().optional(),
  city: z.string().optional(),
  organisationSize: z.number().int().positive().optional(),
  billingCycle: z.enum(['MONTHLY', 'ANNUAL']).optional(),
  ownerFirstName: z.string().min(1),
  ownerLastName: z.string().min(1),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8).optional(),
  subscriptionPlan: z.enum(['STARTER', 'GROWTH', 'ENTERPRISE']).optional(),
  modules: z.array(z.string()).min(1),
});

const UpdateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  industry: z.string().optional(),
  website: z.string().optional(),
  phone: z.string().optional(),
  country: z.string().optional(),
  city: z.string().optional(),
  notes: z.string().optional(),
  subscriptionPlan: z.enum(['STARTER', 'GROWTH', 'ENTERPRISE']).optional(),
});

const DenyTenantSchema = z.object({
  reason: z.string().min(1),
});

const StatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE']),
  reason: z.string().optional(),
});

const UpdateModulesSchema = z.object({
  modules: z.array(
    z.object({
      moduleKey: z.string(),
      isEnabled: z.boolean(),
    }),
  ),
});

const UpdateOwnerSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
});

const allowedModuleKeys = new Set<string>(PRICING_MODULE_KEYS);

export const listTenants = async (req: AdminRequest, res: Response) => {
  try {
    const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 20);
    const search = req.query.search ? String(req.query.search) : undefined;
    const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    const plan = req.query.plan ? String(req.query.plan).toUpperCase() : undefined;

    const where: any = {};
    if (status) where.status = status;
    if (plan) where.subscriptionPlan = plan;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { subdomain: { contains: search, mode: 'insensitive' } },
        {
          users: {
            some: {
              role: 'CLIENT_OWNER',
              email: { contains: search, mode: 'insensitive' },
            },
          },
        },
      ];
    }

    const [tenants, total] = await Promise.all([
      prisma.tenant.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          users: {
            where: { role: 'CLIENT_OWNER' },
            select: { email: true, firstName: true, lastName: true },
          },
          _count: { select: { employees: true } },
          modules: { where: { isEnabled: true }, select: { moduleKey: true } },
          subscription: true,
        },
      }),
      prisma.tenant.count({ where }),
    ]);

    const data = tenants.map(tenant => ({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.subdomain,
      status: tenant.status,
      subscriptionPlan: tenant.subscriptionPlan,
      industry: tenant.industry,
      country: tenant.country,
      createdAt: tenant.createdAt,
      approvedAt: tenant.approvedAt,
      billingCycle: tenant.billingCycle,
      subscriptionStatus: tenant.subscription?.status || null,
      isTrialActive: tenant.isTrialActive,
      trialEndsAt: tenant.trialEndsAt,
      nextBillingDate: tenant.nextBillingDate,
      currentMonthlyAmount: tenant.currentMonthlyAmount,
      currentAnnualAmount: tenant.currentAnnualAmount,
      ownerEmail: tenant.users[0]?.email || null,
      ownerName: tenant.users[0]
        ? `${tenant.users[0].firstName} ${tenant.users[0].lastName}`.trim()
        : null,
      employeeCount: tenant._count.employees,
      enabledModuleCount: tenant.modules.filter(
        m => m.moduleKey !== MODULE_KEYS.SETTINGS && m.moduleKey !== MODULE_KEYS.BILLING,
      ).length,
    }));

    return res.status(200).json({
      success: true,
      data,
      meta: buildPaginationMeta(total, page, limit),
    });
  } catch (error) {
    console.error('Error listing tenants:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to list tenants',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const createTenant = async (req: AdminRequest, res: Response) => {
  try {
    const parsed = CreateTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const data = parsed.data;
    const billingCycle = data.billingCycle || 'MONTHLY';
    const slug = data.slug.trim().toLowerCase();
    if (!isValidSlug(slug)) {
      return res.status(400).json({
        success: false,
        message: 'Slug must contain only lowercase letters, numbers, and hyphens',
      });
    }

    const normalizedModules = data.modules.map(key => String(key).toLowerCase());
    const invalidModules = normalizedModules.filter(key => !allowedModuleKeys.has(key));
    if (invalidModules.length > 0) {
      return res.status(422).json({
        success: false,
        message: `Unknown module keys: ${invalidModules.join(', ')}`,
      });
    }

    const uniqueModules = Array.from(new Set([MODULE_KEYS.DASHBOARD, ...normalizedModules]));
    const nonDashboardModules = uniqueModules.filter(key => key !== MODULE_KEYS.DASHBOARD);
    if (nonDashboardModules.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one module must be selected',
      });
    }

    const pricing = calculatePricing({
      modules: uniqueModules,
      organisationSize: resolveOrganisationSizeKey(data.organisationSize || 0),
      billingCycle,
    });

    const existingTenant = await prisma.tenant.findUnique({ where: { subdomain: slug } });
    if (existingTenant) {
      return res.status(409).json({
        success: false,
        message: 'Slug already in use',
      });
    }

    const existingEmail = await prisma.user.findUnique({
      where: { email: data.ownerEmail },
    });
    if (existingEmail) {
      return res.status(409).json({
        success: false,
        message: 'Owner email already registered',
      });
    }

    const adminId = req.admin!.id;
    const generatedPassword = data.ownerPassword
      ? null
      : generateTemporaryPassword(data.ownerFirstName, slug);
    const passwordToUse = data.ownerPassword || generatedPassword!;
    const passwordHash = await bcrypt.hash(passwordToUse, 10);
    const now = new Date();
    const periodEnd = getPeriodEnd(now, billingCycle);

    const tenant = await prisma.$transaction(async (tx) => {
      const createdTenant = await tx.tenant.create({
        data: {
          name: data.name.trim(),
          subdomain: slug,
          industry: data.industry?.trim() || null,
          website: data.website?.trim() || null,
          phone: data.phone?.trim() || null,
          country: data.country?.trim() || null,
          city: data.city?.trim() || null,
          subscriptionPlan: data.subscriptionPlan || 'STARTER',
          status: 'ACTIVE',
          approvedAt: new Date(),
          approvedBy: adminId,
          organisationSize: data.organisationSize || null,
          billingCycle,
          isTrialActive: false,
          nextBillingDate: periodEnd,
          currentMonthlyAmount: toDecimal(pricing.monthlyTotal),
          currentAnnualAmount: toDecimal(pricing.annualTotal),
          themeConfig: getDefaultTheme(),
          users: {
            create: {
              email: data.ownerEmail.toLowerCase().trim(),
              passwordHash,
              firstName: data.ownerFirstName.trim(),
              lastName: data.ownerLastName.trim(),
              role: 'CLIENT_OWNER',
            },
          },
        },
        select: {
          id: true,
          name: true,
          subdomain: true,
          industry: true,
          website: true,
          logoUrl: true,
          phone: true,
          country: true,
          city: true,
          subscriptionPlan: true,
          status: true,
          suspendedReason: true,
          notes: true,
          approvedAt: true,
          approvedBy: true,
          organisationSize: true,
          billingCycle: true,
          trialEndsAt: true,
          isTrialActive: true,
          nextBillingDate: true,
          currentMonthlyAmount: true,
          currentAnnualAmount: true,
          themeConfig: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await tx.subscription.create({
        data: {
          tenantId: createdTenant.id,
          billingCycle,
          status: 'ACTIVE',
          monthlyAmount: toDecimal(pricing.monthlyTotal),
          annualAmount: toDecimal(pricing.annualTotal),
          trialEndsAt: null,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
      });

      const priceMap = new Map(PRICING_MODULES.map((m) => [m.key, m.monthlyPrice]));
      await tx.subscriptionModule.createMany({
        data: uniqueModules.map((key) => ({
          tenantId: createdTenant.id,
          moduleKey: key,
          status: 'ACTIVE',
          monthlyPrice: toDecimal(priceMap.get(key) || 0),
        })),
      });

      if (uniqueModules.length > 0) {
        await tx.tenantModule.createMany({
          data: Array.from(new Set([...uniqueModules, MODULE_KEYS.BILLING])).map(key => ({
            tenantId: createdTenant.id,
            moduleKey: key,
            isEnabled: true,
          })),
        });
      }

      return createdTenant;
    });

    await logAuditAction(adminId, tenant.id, 'TENANT_CREATED', {
      name: tenant.name,
      slug: tenant.subdomain,
      subscriptionPlan: tenant.subscriptionPlan,
      modules: uniqueModules,
    });

    return res.status(201).json({
      success: true,
      message: 'Tenant created',
      data: {
        tenant,
        temporaryPassword: generatedPassword || undefined,
      },
    });
  } catch (error) {
    console.error('Error creating tenant:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create tenant',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getTenant = async (req: AdminRequest, res: Response) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: {
        users: {
          where: { role: 'CLIENT_OWNER' },
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        },
        modules: { select: { moduleKey: true, isEnabled: true } },
        approvedByAdmin: { select: { id: true, firstName: true, lastName: true, email: true } },
        subscription: true,
        paymentMethods: { where: { isDefault: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
      });
    }

    const [employeeCount, totalProjects, totalCustomers, totalInventoryItems, totalTransactions, totalIncome, auditLogs, paymentHistory] =
      await Promise.all([
        prisma.employee.count({ where: { tenantId: tenant.id } }),
        prisma.project.count({ where: { tenantId: tenant.id } }),
        prisma.customer.count({ where: { tenantId: tenant.id } }),
        prisma.inventoryItem.count({ where: { tenantId: tenant.id } }),
        prisma.transaction.count({ where: { tenantId: tenant.id } }),
        prisma.transaction.aggregate({
          where: { tenantId: tenant.id, type: 'INCOME' },
          _sum: { amount: true },
        }),
        prisma.tenantAuditLog.findMany({
          where: { tenantId: tenant.id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { admin: { select: { id: true, firstName: true, lastName: true, email: true } } },
        }),
        prisma.paymentTransaction.findMany({
          where: { tenantId: tenant.id },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);

    const paymentMethod = tenant.paymentMethods[0] || null;
    const maskedPaymentMethod = paymentMethod
      ? paymentMethod.type === 'CARD'
        ? {
            id: paymentMethod.id,
            type: paymentMethod.type,
            cardBrand: paymentMethod.cardBrand,
            lastFour: paymentMethod.lastFour,
            holderName: paymentMethod.holderName,
            expiryMonth: paymentMethod.expiryMonth,
            expiryYear: paymentMethod.expiryYear,
            maskedNumber: paymentMethod.lastFour
              ? `•••• •••• •••• ${paymentMethod.lastFour}`
              : null,
            isVerified: paymentMethod.isVerified,
          }
        : {
            id: paymentMethod.id,
            type: paymentMethod.type,
            holderName: paymentMethod.holderName,
            momoPhoneMasked: paymentMethod.momoPhone
              ? `+237 ••••••${paymentMethod.momoPhone.slice(-4)}`
              : null,
            isVerified: paymentMethod.isVerified,
          }
      : null;

    return res.status(200).json({
      success: true,
      data: {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.subdomain,
          status: tenant.status,
          industry: tenant.industry,
          website: tenant.website,
          logoUrl: tenant.logoUrl,
          phone: tenant.phone,
          country: tenant.country,
          city: tenant.city,
          subscriptionPlan: tenant.subscriptionPlan,
          suspendedReason: tenant.suspendedReason,
          notes: tenant.notes,
          approvedAt: tenant.approvedAt,
          approvedBy: tenant.approvedBy,
          approvedByAdmin: tenant.approvedByAdmin,
          organisationSize: tenant.organisationSize,
          billingCycle: tenant.billingCycle,
          isTrialActive: tenant.isTrialActive,
          trialEndsAt: tenant.trialEndsAt,
          nextBillingDate: tenant.nextBillingDate,
          currentMonthlyAmount: tenant.currentMonthlyAmount,
          currentAnnualAmount: tenant.currentAnnualAmount,
          createdAt: tenant.createdAt,
          themeConfig: tenant.themeConfig,
        },
        owner: tenant.users[0] || null,
        enabledModules: tenant.modules.filter(m => m.isEnabled).map(m => m.moduleKey),
        employeeCount,
        auditLogs,
        billing: {
          subscription: tenant.subscription,
          paymentMethod: maskedPaymentMethod,
          paymentHistory: paymentHistory.map((tx) => ({
            id: tx.id,
            amount: tx.amount,
            currency: tx.currency,
            status: tx.status,
            type: tx.type,
            description: tx.description,
            paidAt: tx.paidAt,
            createdAt: tx.createdAt,
          })),
        },
        stats: {
          totalProjects,
          totalCustomers,
          totalInventoryItems,
          totalTransactions,
          totalIncome: totalIncome._sum.amount || 0,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching tenant:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve tenant',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateTenant = async (req: AdminRequest, res: Response) => {
  try {
    const parsed = UpdateTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
      });
    }

    const updates = parsed.data;
    const data: any = {};
    const changes: Array<{ field: string; before: any; after: any }> = [];

    for (const field of [
      'name',
      'industry',
      'website',
      'phone',
      'country',
      'city',
      'notes',
      'subscriptionPlan',
    ] as const) {
      if (updates[field] !== undefined && (tenant as any)[field] !== updates[field]) {
        const nextValue =
          typeof updates[field] === 'string' ? updates[field]?.trim() : updates[field];
        data[field] = nextValue;
        changes.push({ field, before: (tenant as any)[field], after: nextValue });
      }
    }

    if (changes.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No changes detected',
        data: tenant,
      });
    }

    const updated = await prisma.tenant.update({
      where: { id: tenant.id },
      data,
    });

    await logAuditAction(req.admin!.id, tenant.id, 'TENANT_UPDATED', { changes });

    return res.status(200).json({
      success: true,
      message: 'Tenant updated',
      data: updated,
    });
  } catch (error) {
    console.error('Error updating tenant:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update tenant',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const approveTenant = async (req: AdminRequest, res: Response) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: { subscription: true, users: true },
    });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
      });
    }

    const now = new Date();
    const subscription = tenant.subscription;
    // [PAYMENT_DISABLED] - Restore when payment integration is ready
    // if (!subscription) {
    //   return res.status(404).json({
    //     success: false,
    //     message: 'Subscription not found',
    //   });
    // }

    // [PAYMENT_DISABLED] - Falls back to tenant.billingCycle when no subscription exists; restore subscription.billingCycle when payment is ready
    const billingCycleForApproval = (subscription?.billingCycle ?? tenant.billingCycle ?? 'MONTHLY') as 'MONTHLY' | 'ANNUAL';
    const periodEnd = getPeriodEnd(now, billingCycleForApproval);
    const trialEndsAt = tenant.isTrialActive ? addDays(now, TRIAL_DAYS) : null;

    const updated = await prisma.$transaction(async (tx) => {
      const updatedTenant = await tx.tenant.update({
        where: { id: tenant.id },
        data: {
          status: 'ACTIVE',
          approvedAt: now,
          approvedBy: req.admin!.id,
          suspendedReason: null,
          trialEndsAt,
          nextBillingDate: tenant.isTrialActive ? trialEndsAt : periodEnd,
        },
      });

      // [PAYMENT_DISABLED] - Uses upsert to create subscription if signup skipped it; restore to update() when payment is ready
      await tx.subscription.upsert({
        where: { tenantId: tenant.id },
        update: {
          status: tenant.isTrialActive ? 'TRIALING' : 'ACTIVE',
          trialEndsAt,
          currentPeriodStart: now,
          currentPeriodEnd: tenant.isTrialActive ? trialEndsAt || now : periodEnd,
        },
        create: {
          tenantId: tenant.id,
          billingCycle: billingCycleForApproval,
          status: 'ACTIVE',
          monthlyAmount: toDecimal(0),
          annualAmount: toDecimal(0),
          trialEndsAt: null,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
      });

      // [PAYMENT_DISABLED] - Restore when payment integration is ready
      // if (tenant.isTrialActive) {
      //   await tx.paymentTransaction.create({
      //     data: {
      //       tenantId: tenant.id,
      //       subscriptionId: subscription.id,
      //       amount: toDecimal(0),
      //       currency: 'XAF',
      //       status: 'COMPLETED',
      //       type: 'TRIAL_START',
      //       description: 'Trial started',
      //       paidAt: now,
      //     },
      //   });
      // }

      return updatedTenant;
    });

    await logAuditAction(req.admin!.id, tenant.id, 'TENANT_APPROVED', {});

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const owner = tenant.users[0];
    if (owner) {
      void sendEmail({
        to: owner.email,
        subject: 'Your StockVero account has been approved',
        html: tenantApprovedEmail({
          ownerName: `${owner.firstName} ${owner.lastName}`,
          orgName: tenant.name,
          loginUrl: frontendUrl,
        }),
      });
      // TODO: In production, verify EMAIL_FROM domain in Resend dashboard
    }

    return res.status(200).json({
      success: true,
      message: 'Tenant approved',
      data: updated,
    });
  } catch (error) {
    console.error('Error approving tenant:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to approve tenant',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const denyTenant = async (req: AdminRequest, res: Response) => {
  try {
    const parsed = DenyTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: { subscription: true, users: true },
    });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
      });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedTenant = await tx.tenant.update({
        where: { id: tenant.id },
        data: {
          status: 'INACTIVE',
          suspendedReason: parsed.data.reason,
          approvedAt: null,
          approvedBy: null,
        },
      });

      if (tenant.subscription) {
        await tx.subscription.update({
          where: { tenantId: tenant.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancellationReason: parsed.data.reason,
          },
        });
      }

      return updatedTenant;
    });

    await logAuditAction(req.admin!.id, tenant.id, 'TENANT_DENIED', {
      reason: parsed.data.reason,
    });

    const owner = tenant.users[0];
    if (owner) {
      void sendEmail({
        to: owner.email,
        subject: 'Update on your StockVero registration',
        html: tenantDeniedEmail({
          ownerName: `${owner.firstName} ${owner.lastName}`,
          orgName: tenant.name,
          reason: parsed.data.reason,
        }),
      });
      // TODO: In production, verify EMAIL_FROM domain in Resend dashboard
    }

    return res.status(200).json({
      success: true,
      message: 'Tenant denied',
      data: updated,
    });
  } catch (error) {
    console.error('Error denying tenant:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to deny tenant',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateTenantStatus = async (req: AdminRequest, res: Response) => {
  try {
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: { users: true },
    });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
      });
    }

    if (parsed.data.status === 'SUSPENDED' && !parsed.data.reason) {
      return res.status(400).json({
        success: false,
        message: 'Suspension reason is required',
      });
    }

    const updates: any = {
      status: parsed.data.status,
    };

    if (parsed.data.status === 'SUSPENDED') {
      updates.suspendedReason = parsed.data.reason || tenant.suspendedReason;
    }

    if (parsed.data.status === 'ACTIVE' && tenant.status === 'SUSPENDED') {
      updates.suspendedReason = null;
    }

    if (parsed.data.status === 'INACTIVE') {
      updates.suspendedReason = parsed.data.reason || null;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedTenant = await tx.tenant.update({
        where: { id: tenant.id },
        data: updates,
      });

      if (parsed.data.status === 'SUSPENDED') {
        await tx.employee.updateMany({
          where: { tenantId: tenant.id },
          data: { tokenVersion: { increment: 1 } },
        });
        await tx.user.updateMany({
          where: { tenantId: tenant.id, role: 'CLIENT_OWNER' },
          data: { tokenVersion: { increment: 1 } },
        });
      }

      return updatedTenant;
    });

    if (parsed.data.status === 'SUSPENDED') {
      await logAuditAction(req.admin!.id, tenant.id, 'TENANT_SUSPENDED', {
        reason: parsed.data.reason || null,
      });

      const owner = tenant.users[0];
      if (owner) {
        void sendEmail({
          to: owner.email,
          subject: 'Your StockVero account has been suspended',
          html: tenantSuspendedEmail({
            ownerName: `${owner.firstName} ${owner.lastName}`,
            orgName: tenant.name,
            reason: parsed.data.reason || 'Reason not specified',
          }),
        });
        // TODO: In production, verify EMAIL_FROM domain in Resend dashboard
      }
    } else if (parsed.data.status === 'ACTIVE' && tenant.status === 'SUSPENDED') {
      await logAuditAction(req.admin!.id, tenant.id, 'TENANT_REACTIVATED', {});
    } else if (parsed.data.status === 'INACTIVE') {
      await logAuditAction(req.admin!.id, tenant.id, 'TENANT_DEACTIVATED', {
        reason: parsed.data.reason || null,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Tenant status updated',
      data: updated,
    });
  } catch (error) {
    console.error('Error updating tenant status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update tenant status',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const deleteTenant = async (req: AdminRequest, res: Response) => {
  try {
    if (req.headers['x-confirm-delete'] !== 'yes') {
      return res.status(400).json({
        success: false,
        message: 'Delete confirmation header missing',
      });
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: {
        users: true,
        employees: true,
        modules: true,
      },
    });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
      });
    }

    await logAuditAction(req.admin!.id, tenant.id, 'TENANT_DELETED', {
      snapshot: {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.subdomain,
          status: tenant.status,
          subscriptionPlan: tenant.subscriptionPlan,
          createdAt: tenant.createdAt,
        },
        users: tenant.users.map(user => ({
          id: user.id,
          email: user.email,
          role: user.role,
        })),
        employees: tenant.employees.map(emp => ({
          id: emp.id,
          email: emp.email,
          roleId: emp.roleId,
        })),
        modules: tenant.modules.map(mod => ({
          moduleKey: mod.moduleKey,
          isEnabled: mod.isEnabled,
        })),
      },
    });

    await prisma.tenant.delete({ where: { id: tenant.id } });

    return res.status(200).json({
      success: true,
      message: 'Tenant deleted',
    });
  } catch (error) {
    console.error('Error deleting tenant:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete tenant',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getTenantModules = async (req: AdminRequest, res: Response) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
      });
    }

    const tenantModules = await prisma.tenantModule.findMany({
      where: { tenantId: tenant.id },
      select: { moduleKey: true, isEnabled: true },
    });
    const moduleMap = new Map(tenantModules.map(m => [m.moduleKey, m.isEnabled]));

    const modules = MODULES_CONFIG.filter(
      m => m.key !== MODULE_KEYS.SETTINGS && m.key !== MODULE_KEYS.BILLING,
    ).map(m => ({
      moduleKey: m.key,
      displayName: m.displayName,
      description: m.description,
      isEnabled: moduleMap.get(m.key) ?? false,
    }));

    return res.status(200).json({
      success: true,
      data: modules,
    });
  } catch (error) {
    console.error('Error fetching tenant modules:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve tenant modules',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateTenantModules = async (req: AdminRequest, res: Response) => {
  try {
    const parsed = UpdateModulesSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
      });
    }

    const normalizedUpdates = parsed.data.modules.map(m => ({
      moduleKey: String(m.moduleKey).toLowerCase(),
      isEnabled: m.isEnabled,
    }));

    const unknownKeys = normalizedUpdates
      .map(m => m.moduleKey)
      .filter(key => !allowedModuleKeys.has(key));
    if (unknownKeys.length > 0) {
      return res.status(422).json({
        success: false,
        message: `Unknown module keys: ${Array.from(new Set(unknownKeys)).join(', ')}`,
      });
    }

    const changes: Array<{ moduleKey: string; action: 'MODULE_ENABLED' | 'MODULE_DISABLED' }> = [];

    await prisma.$transaction(async (tx) => {
      for (const update of normalizedUpdates) {
        const existing = await tx.tenantModule.findUnique({
          where: {
            tenantId_moduleKey: {
              tenantId: tenant.id,
              moduleKey: update.moduleKey,
            },
          },
        });

        if (!existing) {
          await tx.tenantModule.create({
            data: {
              tenantId: tenant.id,
              moduleKey: update.moduleKey,
              isEnabled: update.isEnabled,
              enabledAt: update.isEnabled ? new Date() : new Date(),
              disabledAt: update.isEnabled ? null : new Date(),
            },
          });
          changes.push({
            moduleKey: update.moduleKey,
            action: update.isEnabled ? 'MODULE_ENABLED' : 'MODULE_DISABLED',
          });
          continue;
        }

        if (existing.isEnabled !== update.isEnabled) {
          await tx.tenantModule.update({
            where: { id: existing.id },
            data: {
              isEnabled: update.isEnabled,
              enabledAt: update.isEnabled ? new Date() : existing.enabledAt,
              disabledAt: update.isEnabled ? null : new Date(),
            },
          });
          changes.push({
            moduleKey: update.moduleKey,
            action: update.isEnabled ? 'MODULE_ENABLED' : 'MODULE_DISABLED',
          });
        }
      }
    });

    for (const change of changes) {
      await logAuditAction(req.admin!.id, tenant.id, change.action, {
        moduleKey: change.moduleKey,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Modules updated',
    });
  } catch (error) {
    console.error('Error updating tenant modules:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update tenant modules',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateTenantOwner = async (req: AdminRequest, res: Response) => {
  try {
    const parsed = UpdateOwnerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
      });
    }

    const owner = await prisma.user.findFirst({
      where: { tenantId: tenant.id, role: 'CLIENT_OWNER' },
    });
    if (!owner) {
      return res.status(404).json({
        success: false,
        message: 'Owner not found',
      });
    }

    const normalizedEmail = parsed.data.email
      ? parsed.data.email.toLowerCase().trim()
      : undefined;

    if (normalizedEmail && normalizedEmail !== owner.email) {
      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Email already registered',
        });
      }
    }

    const changes: Array<{ field: string; before: any; after: any }> = [];
    const updates: any = {};
    for (const field of ['firstName', 'lastName', 'phone'] as const) {
      if (parsed.data[field] !== undefined) {
        const nextValue =
          typeof parsed.data[field] === 'string'
            ? parsed.data[field]?.trim()
            : parsed.data[field];
        if ((owner as any)[field] !== nextValue) {
          updates[field] = nextValue;
          changes.push({ field, before: (owner as any)[field], after: nextValue });
        }
      }
    }

    if (normalizedEmail && owner.email !== normalizedEmail) {
      updates.email = normalizedEmail;
      changes.push({ field: 'email', before: owner.email, after: normalizedEmail });
    }

    if (changes.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No changes detected',
        data: owner,
      });
    }

    const updated = await prisma.user.update({
      where: { id: owner.id },
      data: updates,
      select: {
        id: true,
        tenantId: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        avatarUrl: true,
        phone: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await logAuditAction(req.admin!.id, tenant.id, 'OWNER_UPDATED', { changes });

    return res.status(200).json({
      success: true,
      message: 'Owner updated',
      data: updated,
    });
  } catch (error) {
    console.error('Error updating owner:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update owner',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const resetTenantOwnerPassword = async (req: AdminRequest, res: Response) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
      });
    }

    const owner = await prisma.user.findFirst({
      where: { tenantId: tenant.id, role: 'CLIENT_OWNER' },
    });
    if (!owner) {
      return res.status(404).json({
        success: false,
        message: 'Owner not found',
      });
    }

    const temporaryPassword = generateTemporaryPassword(owner.firstName, tenant.subdomain);
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    await prisma.user.update({
      where: { id: owner.id },
      data: {
        passwordHash,
        tokenVersion: { increment: 1 },
      },
    });

    await logAuditAction(req.admin!.id, tenant.id, 'OWNER_PASSWORD_RESET', {
      ownerId: owner.id,
    });

    return res.status(200).json({
      success: true,
      message: 'Password reset',
      data: { temporaryPassword },
    });
  } catch (error) {
    console.error('Error resetting owner password:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to reset password',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
