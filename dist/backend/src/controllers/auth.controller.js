import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '../db.js';
import { generateToken, verifyToken } from '../lib/jwt.js';
import { MODULE_KEYS, MODULES_CONFIG, OWNER_PERMANENT_MODULES } from '../config/modules.js';
import { isValidSlug, generateSlug } from '../lib/slug.js';
import { UserRole } from '@prisma/client';
import { calculatePricing, PRICING_MODULE_KEYS, } from '../lib/pricing.js';
import { getPeriodEnd, toDecimal } from '../services/billing.service.js';
import { sendNotification } from '../services/notificationService.js';
import { sendEmail } from '../services/emailService.js';
import { tenantRegistrationReceived, forgotPassword as forgotPasswordTemplate } from '../emails/templates.js';
import { logAudit, extractRequestContext, AuditActorType, AuditStatus } from '../services/auditService.js';
import { resolveSignedUrl, deleteStoredFile } from '../lib/storage.js';
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
const SignupSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    organizationName: z.string().min(1),
    slug: z.string().optional(),
    industry: z.string().min(1),
    website: z.string().optional(),
    phone: z.string().min(1),
    country: z.string().min(1),
    city: z.string().min(1),
    // [PAYMENT_DISABLED] - Restore when payment integration is ready
    // organisationSize: z.enum(['1-10', '11-50', '51-200', '201+']),
    organisationSize: z.enum(['1-10', '11-50', '51-200', '201+']).optional().default('1-10'),
    modules: z.array(z.string()).min(1),
    // [PAYMENT_DISABLED] - Restore when payment integration is ready
    // billingCycle: z.enum(['MONTHLY', 'ANNUAL']),
    // startTrial: z.boolean(),
    // paymentMethod: PaymentMethodSchema,
    billingCycle: z.enum(['MONTHLY', 'ANNUAL']).optional().default('MONTHLY'),
    startTrial: z.boolean().optional().default(false),
    paymentMethod: PaymentMethodSchema.optional().nullable(),
    theme: z.record(z.string(), z.any()).optional(),
});
const LoginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});
const RefreshSchema = z.object({
    refreshToken: z.string().min(1),
});
const ChangePasswordSchema = z.object({
    currentPassword: z.string().optional(),
    newPassword: z.string().min(8),
});
export const signup = async (req, res) => {
    try {
        const parsed = SignupSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const { email, password, firstName, lastName, organizationName, slug, industry, website, phone, country, city, organisationSize, modules, billingCycle, startTrial, paymentMethod, theme, } = parsed.data;
        // [PAYMENT_DISABLED] - Restore when payment integration is ready
        // if (paymentMethod.type === 'CARD' && !paymentMethod.cardNumber) {
        //   return res.status(400).json({
        //     success: false,
        //     message: 'Card number is required',
        //   });
        // }
        // [PAYMENT_DISABLED] - Restore when payment integration is ready
        // if (paymentMethod.type !== 'CARD' && !paymentMethod.momoPhone) {
        //   return res.status(400).json({
        //     success: false,
        //     message: 'Mobile money phone is required',
        //   });
        // }
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: 'Email already registered',
            });
        }
        const passwordHash = await bcrypt.hash(password, 10);
        let subdomain;
        const providedSlug = slug?.trim().toLowerCase();
        if (providedSlug) {
            // Validate user-provided slug format
            if (!isValidSlug(providedSlug)) {
                return res.status(422).json({
                    success: false,
                    message: 'Slug must be 3–20 characters, lowercase letters, numbers and hyphens only.',
                });
            }
            // Check uniqueness — user must pick another if taken
            const existingTenant = await prisma.tenant.findUnique({ where: { subdomain: providedSlug } });
            if (existingTenant) {
                return res.status(409).json({
                    success: false,
                    message: 'Slug already in use. Please choose a different one.',
                });
            }
            subdomain = providedSlug;
        }
        else {
            // Auto-generate from org name, append a counter until unique
            const base = generateSlug(organizationName);
            let attempt = base;
            let counter = 2;
            while (await prisma.tenant.findUnique({ where: { subdomain: attempt } })) {
                const suffix = String(counter++);
                attempt = base.slice(0, 20 - suffix.length) + suffix;
            }
            subdomain = attempt;
        }
        const requestedModules = Array.from(new Set(modules.map(m => String(m).toLowerCase())));
        const invalidModules = requestedModules.filter(key => !PRICING_MODULE_KEYS.includes(key));
        if (invalidModules.length > 0) {
            return res.status(422).json({
                success: false,
                message: `Unknown module keys: ${invalidModules.join(', ')}`,
            });
        }
        const nonDashboardModules = requestedModules.filter(key => key !== MODULE_KEYS.DASHBOARD);
        if (nonDashboardModules.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'At least one module must be selected',
            });
        }
        const selectedModules = Array.from(new Set([MODULE_KEYS.DASHBOARD, ...requestedModules]));
        const sizeValueMap = {
            '1-10': 10,
            '11-50': 50,
            '51-200': 200,
            '201+': 201,
        };
        const pricing = calculatePricing({
            modules: selectedModules,
            organisationSize,
            billingCycle,
        });
        const now = new Date();
        const periodEnd = startTrial ? now : getPeriodEnd(now, billingCycle);
        const tenant = await prisma.tenant.create({
            data: {
                name: organizationName,
                subdomain,
                industry,
                website: website || null,
                phone,
                country,
                city,
                organisationSize: sizeValueMap[organisationSize],
                billingCycle,
                isTrialActive: startTrial,
                trialEndsAt: null,
                nextBillingDate: null,
                currentMonthlyAmount: toDecimal(pricing.monthlyTotal),
                currentAnnualAmount: toDecimal(pricing.annualTotal),
                themeConfig: theme || getDefaultTheme(),
                status: 'PENDING_APPROVAL',
                users: {
                    create: {
                        email,
                        passwordHash,
                        firstName,
                        lastName,
                        role: UserRole.CLIENT_OWNER,
                    },
                },
            },
            include: { users: true },
        });
        const tenantModules = Array.from(new Set([...selectedModules, MODULE_KEYS.BILLING, MODULE_KEYS.SETTINGS, MODULE_KEYS.ADMINISTRATION]));
        if (tenantModules.length > 0) {
            await prisma.module.createMany({
                data: MODULES_CONFIG
                    .filter((module) => tenantModules.includes(module.key))
                    .map((module, index) => ({
                    key: module.key,
                    displayName: module.displayName,
                    description: module.description ?? null,
                    sortOrder: index,
                    isActive: true,
                })),
                skipDuplicates: true,
            });
            await prisma.tenantModule.createMany({
                data: tenantModules.map(key => ({
                    tenantId: tenant.id,
                    moduleKey: key,
                    isEnabled: true,
                })),
            });
        }
        // [PAYMENT_DISABLED] - Restore when payment integration is ready
        // if (paymentMethod) {
        // const subscription = await prisma.subscription.create({
        //   data: {
        //     tenantId: tenant.id,
        //     billingCycle,
        //     status: startTrial ? 'TRIALING' : 'ACTIVE',
        //     monthlyAmount: toDecimal(pricing.monthlyTotal),
        //     annualAmount: toDecimal(pricing.annualTotal),
        //     trialEndsAt: null,
        //     currentPeriodStart: now,
        //     currentPeriodEnd: periodEnd,
        //   },
        // });
        //
        // const modulePriceMap = new Map(PRICING_MODULES.map((m) => [m.key, m.monthlyPrice]));
        // await prisma.subscriptionModule.createMany({
        //   data: selectedModules.map((key) => ({
        //     tenantId: tenant.id,
        //     moduleKey: key,
        //     status: 'ACTIVE',
        //     monthlyPrice: toDecimal(modulePriceMap.get(key) || 0),
        //   })),
        // });
        //
        // const cardBrand =
        //   paymentMethod.type === 'CARD'
        //     ? paymentMethod.cardNumber?.startsWith('4')
        //       ? 'Visa'
        //       : paymentMethod.cardNumber?.startsWith('5')
        //         ? 'Mastercard'
        //         : null
        //     : null;
        //
        // const lastFour = paymentMethod.cardNumber
        //   ? paymentMethod.cardNumber.slice(-4)
        //   : null;
        //
        // await prisma.paymentMethod.create({
        //   data: {
        //     tenantId: tenant.id,
        //     type: paymentMethod.type,
        //     isDefault: true,
        //     lastFour,
        //     cardBrand,
        //     holderName: paymentMethod.holderName || null,
        //     expiryMonth: paymentMethod.expiryMonth || null,
        //     expiryYear: paymentMethod.expiryYear || null,
        //     momoPhone: paymentMethod.momoPhone || null,
        //     country: paymentMethod.country || null,
        //     city: paymentMethod.city || null,
        //     state: paymentMethod.state || null,
        //     zipCode: paymentMethod.zipCode || null,
        //     isVerified: false,
        //   },
        // });
        // } // end if (paymentMethod)
        // [PAYMENT_DISABLED] - Restore when payment integration is ready
        // if (!startTrial) {
        //   const amount = billingCycle === BILLING_CYCLES.ANNUAL
        //     ? pricing.annualTotal
        //     : pricing.monthlyTotal;
        //
        //   await prisma.paymentTransaction.create({
        //     data: {
        //       tenantId: tenant.id,
        //       subscriptionId: subscription.id,
        //       amount: toDecimal(amount),
        //       currency: 'XAF',
        //       status: 'COMPLETED',
        //       type: 'SUBSCRIPTION_CHARGE',
        //       description: `Initial charge - ${selectedModules.join(', ')}`,
        //       paidAt: now,
        //     },
        //   });
        // }
        void sendEmail({
            to: email,
            subject: 'We received your registration — StockVero',
            html: tenantRegistrationReceived({
                ownerName: `${firstName} ${lastName}`,
                orgName: organizationName,
            }),
        });
        // TODO: In production, verify EMAIL_FROM domain in Resend dashboard
        return res.status(201).json({
            success: true,
            message: 'Signup submitted',
            data: {
                tenantId: tenant.id,
                status: tenant.status,
                trialSelected: startTrial,
            },
        });
    }
    catch (error) {
        console.error('Error during signup:', error);
        return res.status(500).json({
            success: false,
            message: 'Signup failed',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
/**
 * GET /api/v1/auth/check-slug?slug=:slug
 * Public. Returns { available: boolean, suggestion?: string }.
 */
export const checkSlug = async (req, res) => {
    try {
        const slug = String(req.query.slug ?? '').trim().toLowerCase();
        if (!slug || !/^[a-z0-9-]{3,20}$/.test(slug)) {
            return res.status(200).json({ success: true, data: { available: false } });
        }
        const existing = await prisma.tenant.findUnique({ where: { subdomain: slug } });
        if (!existing) {
            return res.status(200).json({ success: true, data: { available: true } });
        }
        // Find the next available suggestion by appending a counter
        const base = slug;
        let counter = 2;
        let suggestion;
        do {
            const suffix = String(counter++);
            suggestion = base.slice(0, 20 - suffix.length) + suffix;
        } while (await prisma.tenant.findUnique({ where: { subdomain: suggestion } }));
        return res.status(200).json({ success: true, data: { available: false, suggestion } });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to check slug availability' });
    }
};
export const login = async (req, res) => {
    try {
        const parsed = LoginSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const { email, password } = parsed.data;
        const user = await prisma.user.findUnique({
            where: { email },
            include: { tenant: { include: { modules: true } } },
        });
        if (user) {
            const status = user.tenant.status;
            if (status !== 'ACTIVE') {
                const ctx = extractRequestContext(req);
                void logAudit({
                    tenantId: user.tenantId,
                    actorType: AuditActorType.OWNER,
                    actorId: user.id,
                    actorName: `${user.firstName} ${user.lastName}`,
                    action: 'LOGIN_BLOCKED',
                    module: 'auth',
                    status: AuditStatus.FAILURE,
                    notes: status === 'PENDING_APPROVAL' ? 'Account pending approval' : 'Account suspended',
                    ...ctx,
                });
                return respondWithTenantStatus(res, status, user.tenant.suspendedReason);
            }
            const isValid = await bcrypt.compare(password, user.passwordHash);
            if (!isValid) {
                const ctx = extractRequestContext(req);
                void logAudit({
                    tenantId: user.tenantId,
                    actorType: AuditActorType.OWNER,
                    actorId: user.id,
                    actorName: `${user.firstName} ${user.lastName}`,
                    action: 'LOGIN_FAILED',
                    module: 'auth',
                    status: AuditStatus.FAILURE,
                    notes: 'Invalid credentials',
                    ...ctx,
                });
                return res.status(401).json({
                    success: false,
                    message: 'Incorrect password. Please try again.',
                    field: 'password',
                });
            }
            const activeModules = Array.from(new Set([...OWNER_PERMANENT_MODULES, ...user.tenant.modules.filter(m => m.isEnabled).map(m => m.moduleKey)]));
            const token = generateToken({
                userId: user.id,
                tenantId: user.tenantId,
                tenantSlug: user.tenant.subdomain,
                role: user.role,
                accountType: 'owner',
                active_modules: activeModules,
                tokenVersion: user.tokenVersion,
            });
            await prisma.user.update({
                where: { id: user.id },
                data: { lastLoginAt: new Date() },
            });
            const ctx = extractRequestContext(req);
            void logAudit({
                tenantId: user.tenantId,
                actorType: AuditActorType.OWNER,
                actorId: user.id,
                actorName: `${user.firstName} ${user.lastName}`,
                action: 'LOGIN_SUCCESS',
                module: 'auth',
                ...ctx,
            });
            const logoUrl = await resolveSignedUrl(user.tenant.logoUrl);
            return res.status(200).json({
                success: true,
                message: 'Login successful',
                data: {
                    token,
                    user: {
                        id: user.id,
                        tenantId: user.tenantId,
                        email: user.email,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        role: user.role,
                        accountType: 'owner',
                        avatarUrl: user.avatarUrl ? await resolveSignedUrl(user.avatarUrl) : null,
                        phone: user.phone,
                    },
                    tenant: {
                        id: user.tenant.id,
                        name: user.tenant.name,
                        theme: user.tenant.themeConfig,
                        logoUrl,
                    },
                },
            });
        }
        const employee = await prisma.employee.findUnique({
            where: { email },
            include: {
                tenant: { include: { modules: true } },
                role: { include: { permissions: true } },
            },
        });
        if (!employee) {
            return res.status(401).json({
                success: false,
                message: 'No account found with that email address',
                field: 'email',
            });
        }
        const status = employee.tenant.status;
        if (status !== 'ACTIVE') {
            const ctx = extractRequestContext(req);
            void logAudit({
                tenantId: employee.tenantId,
                actorType: AuditActorType.EMPLOYEE,
                actorId: employee.id,
                actorName: `${employee.firstName} ${employee.lastName}`,
                action: 'LOGIN_BLOCKED',
                module: 'auth',
                status: AuditStatus.FAILURE,
                notes: status === 'PENDING_APPROVAL' ? 'Account pending approval' : 'Account suspended',
                ...ctx,
            });
            return respondWithTenantStatus(res, status, employee.tenant.suspendedReason);
        }
        if (!employee.isActive) {
            const ctx = extractRequestContext(req);
            void logAudit({
                tenantId: employee.tenantId,
                actorType: AuditActorType.EMPLOYEE,
                actorId: employee.id,
                actorName: `${employee.firstName} ${employee.lastName}`,
                action: 'LOGIN_BLOCKED',
                module: 'auth',
                status: AuditStatus.FAILURE,
                notes: 'Account deactivated',
                ...ctx,
            });
            return res.status(403).json({
                success: false,
                message: 'Your account has been deactivated.',
            });
        }
        const isValid = await bcrypt.compare(password, employee.passwordHash);
        if (!isValid) {
            const ctx = extractRequestContext(req);
            void logAudit({
                tenantId: employee.tenantId,
                actorType: AuditActorType.EMPLOYEE,
                actorId: employee.id,
                actorName: `${employee.firstName} ${employee.lastName}`,
                action: 'LOGIN_FAILED',
                module: 'auth',
                status: AuditStatus.FAILURE,
                notes: 'Invalid credentials',
                ...ctx,
            });
            return res.status(401).json({
                success: false,
                message: 'Incorrect password. Please try again.',
                field: 'password',
            });
        }
        const enabledModules = Array.from(new Set([...OWNER_PERMANENT_MODULES, ...employee.tenant.modules.filter(m => m.isEnabled).map(m => m.moduleKey)]));
        const { activeModules, permissions } = buildEmployeePermissions(employee.role.permissions, enabledModules, employee.role.isAdmin);
        const token = generateToken({
            userId: employee.id,
            tenantId: employee.tenantId,
            tenantSlug: employee.tenant.subdomain,
            accountType: 'employee',
            roleId: employee.roleId,
            mustChangePassword: employee.mustChangePassword,
            tokenVersion: employee.tokenVersion,
            permissions,
            active_modules: activeModules,
            isAdmin: employee.role.isAdmin,
        });
        await prisma.employee.update({
            where: { id: employee.id },
            data: { lastLoginAt: new Date() },
        });
        const empCtx = extractRequestContext(req);
        void logAudit({
            tenantId: employee.tenantId,
            actorType: AuditActorType.EMPLOYEE,
            actorId: employee.id,
            actorName: `${employee.firstName} ${employee.lastName}`,
            action: 'LOGIN_SUCCESS',
            module: 'auth',
            ...empCtx,
        });
        const employeeLogoUrl = await resolveSignedUrl(employee.tenant.logoUrl);
        return res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                token,
                user: {
                    id: employee.id,
                    tenantId: employee.tenantId,
                    email: employee.email,
                    firstName: employee.firstName,
                    lastName: employee.lastName,
                    accountType: 'employee',
                    roleId: employee.roleId,
                    mustChangePassword: employee.mustChangePassword,
                    avatarUrl: employee.avatarUrl ? await resolveSignedUrl(employee.avatarUrl) : null,
                    phone: employee.phone,
                    jobTitle: employee.jobTitle,
                },
                tenant: {
                    id: employee.tenant.id,
                    name: employee.tenant.name,
                    theme: employee.tenant.themeConfig,
                    logoUrl: employeeLogoUrl,
                },
            },
        });
    }
    catch (error) {
        console.error('Error during login:', error);
        return res.status(500).json({
            success: false,
            message: 'Login failed',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const refresh = async (req, res) => {
    try {
        const parsed = RefreshSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        let decoded;
        try {
            decoded = verifyToken(parsed.data.refreshToken);
        }
        catch {
            return res.status(401).json({
                success: false,
                message: 'Invalid refresh token',
            });
        }
        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            include: { tenant: { include: { modules: true } } },
        });
        if (!user || !user.isActive) {
            return res.status(401).json({
                success: false,
                message: 'Invalid refresh token',
            });
        }
        if (typeof decoded.tokenVersion === 'number' && decoded.tokenVersion !== user.tokenVersion) {
            return res.status(401).json({
                success: false,
                message: 'Invalid refresh token',
            });
        }
        const activeModules = Array.from(new Set([...OWNER_PERMANENT_MODULES, ...user.tenant.modules.filter(m => m.isEnabled).map(m => m.moduleKey)]));
        const token = generateToken({
            userId: user.id,
            tenantId: user.tenantId,
            role: user.role,
            accountType: 'owner',
            active_modules: activeModules,
            tokenVersion: user.tokenVersion,
        });
        return res.status(200).json({
            success: true,
            message: 'Token refreshed',
            data: { token },
        });
    }
    catch (error) {
        console.error('Error refreshing token:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to refresh token',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const changePassword = async (req, res) => {
    try {
        const parsed = ChangePasswordSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const { currentPassword, newPassword } = parsed.data;
        if (newPassword.length < 8 || !/\d/.test(newPassword)) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters and include a number',
            });
        }
        if (req.user?.accountType === 'owner') {
            const user = await prisma.user.findUnique({ where: { id: req.user.id } });
            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found',
                });
            }
            const isValid = !currentPassword || await bcrypt.compare(currentPassword, user.passwordHash);
            if (!isValid) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid current password',
                });
            }
            const passwordHash = await bcrypt.hash(newPassword, 10);
            await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
            // Notify user
            await sendNotification({
                tenantId: user.tenantId,
                userId: user.id,
                userType: 'OWNER',
                type: 'system.security.password_updated',
                title: 'Password Changed',
                message: 'Your account password has been updated successfully.',
            });
            const tenantModules = await prisma.tenantModule.findMany({
                where: { tenantId: user.tenantId, isEnabled: true },
                select: { moduleKey: true },
            });
            void logAudit({
                tenantId: user.tenantId,
                actorType: AuditActorType.OWNER,
                actorId: user.id,
                actorName: `${user.firstName} ${user.lastName}`,
                action: 'PASSWORD_CHANGED',
                module: 'auth',
                ...extractRequestContext(req),
            });
            const token = generateToken({
                userId: user.id,
                tenantId: user.tenantId,
                role: user.role,
                accountType: 'owner',
                active_modules: Array.from(new Set([...OWNER_PERMANENT_MODULES, ...tenantModules.map(m => m.moduleKey)])),
                tokenVersion: user.tokenVersion,
            });
            return res.status(200).json({
                success: true,
                message: 'Password updated successfully',
                data: { token },
            });
        }
        const employee = await prisma.employee.findUnique({
            where: { id: req.user.id },
            include: {
                tenant: { include: { modules: true } },
                role: { include: { permissions: true } },
            },
        });
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }
        const isValid = !currentPassword || await bcrypt.compare(currentPassword, employee.passwordHash);
        if (!isValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid current password',
            });
        }
        const passwordHash = await bcrypt.hash(newPassword, 10);
        const updated = await prisma.employee.update({
            where: { id: employee.id },
            data: {
                passwordHash,
                mustChangePassword: false,
                tokenVersion: { increment: 1 },
            },
        });
        // Notify user
        await sendNotification({
            tenantId: employee.tenantId,
            userId: employee.id,
            userType: 'EMPLOYEE',
            type: 'system.security.password_updated',
            title: 'Password Changed',
            message: 'Your account password has been updated successfully.',
        });
        void logAudit({
            tenantId: employee.tenantId,
            actorType: AuditActorType.EMPLOYEE,
            actorId: employee.id,
            actorName: `${employee.firstName} ${employee.lastName}`,
            action: employee.mustChangePassword ? 'FIRST_LOGIN_PASSWORD_SET' : 'PASSWORD_CHANGED',
            module: 'auth',
            ...extractRequestContext(req),
        });
        const enabledModules = Array.from(new Set([...OWNER_PERMANENT_MODULES, ...employee.tenant.modules.filter(m => m.isEnabled).map(m => m.moduleKey)]));
        const { activeModules, permissions } = buildEmployeePermissions(employee.role.permissions, enabledModules, employee.role.isAdmin);
        const token = generateToken({
            userId: updated.id,
            tenantId: updated.tenantId,
            accountType: 'employee',
            roleId: updated.roleId,
            mustChangePassword: false,
            tokenVersion: updated.tokenVersion,
            permissions,
            active_modules: activeModules,
            isAdmin: employee.role.isAdmin,
        });
        return res.status(200).json({
            success: true,
            message: 'Password updated successfully',
            data: { token },
        });
    }
    catch (error) {
        console.error('Error changing password:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to change password',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const me = async (req, res) => {
    try {
        if (req.user?.accountType === 'owner') {
            const user = await prisma.user.findUnique({
                where: { id: req.user.id },
                include: { tenant: { include: { modules: true } } },
            });
            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found',
                });
            }
            const activeModules = Array.from(new Set([...OWNER_PERMANENT_MODULES, ...user.tenant.modules.filter(m => m.isEnabled).map(m => m.moduleKey)]));
            const token = generateToken({
                userId: user.id,
                tenantId: user.tenantId,
                tenantSlug: user.tenant.subdomain,
                role: user.role,
                accountType: 'owner',
                active_modules: activeModules,
                tokenVersion: user.tokenVersion,
            });
            const logoUrl = await resolveSignedUrl(user.tenant.logoUrl);
            return res.status(200).json({
                success: true,
                message: 'User retrieved successfully',
                data: {
                    token,
                    user: {
                        id: user.id,
                        tenantId: user.tenantId,
                        email: user.email,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        role: user.role,
                        accountType: 'owner',
                        phone: user.phone,
                        avatarUrl: user.avatarUrl ? await resolveSignedUrl(user.avatarUrl) : null,
                    },
                    tenant: {
                        id: user.tenant.id,
                        name: user.tenant.name,
                        subdomain: user.tenant.subdomain,
                        theme: user.tenant.themeConfig,
                        logoUrl,
                    },
                },
            });
        }
        const employee = await prisma.employee.findUnique({
            where: { id: req.user.id },
            include: {
                tenant: { include: { modules: true } },
                role: { include: { permissions: true } },
            },
        });
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }
        const enabledModules = Array.from(new Set([...OWNER_PERMANENT_MODULES, ...employee.tenant.modules.filter(m => m.isEnabled).map(m => m.moduleKey)]));
        const { activeModules, permissions } = buildEmployeePermissions(employee.role.permissions, enabledModules, employee.role.isAdmin);
        const token = generateToken({
            userId: employee.id,
            tenantId: employee.tenantId,
            tenantSlug: employee.tenant.subdomain,
            accountType: 'employee',
            roleId: employee.roleId,
            mustChangePassword: employee.mustChangePassword,
            tokenVersion: employee.tokenVersion,
            permissions,
            active_modules: activeModules,
            isAdmin: employee.role.isAdmin,
        });
        const employeeLogoUrl = await resolveSignedUrl(employee.tenant.logoUrl);
        return res.status(200).json({
            success: true,
            message: 'User retrieved successfully',
            data: {
                token,
                user: {
                    id: employee.id,
                    tenantId: employee.tenantId,
                    email: employee.email,
                    firstName: employee.firstName,
                    lastName: employee.lastName,
                    accountType: 'employee',
                    roleId: employee.roleId,
                    mustChangePassword: employee.mustChangePassword,
                    avatarUrl: employee.avatarUrl ? await resolveSignedUrl(employee.avatarUrl) : null,
                    phone: employee.phone,
                    jobTitle: employee.jobTitle,
                },
                tenant: {
                    id: employee.tenant.id,
                    name: employee.tenant.name,
                    subdomain: employee.tenant.subdomain,
                    theme: employee.tenant.themeConfig,
                    logoUrl: employeeLogoUrl,
                },
            },
        });
    }
    catch (error) {
        console.error('Error fetching user:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve user',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
function getDefaultTheme() {
    return {
        primary: '#0EA5E9',
        secondary: '#0F172A',
        background: '#F0F9FF',
        surface: '#FFFFFF',
        accent: '#F59E0B',
        text: '#1F2937',
        muted: '#6B7280',
        radius: '0.5rem',
    };
}
function buildEmployeePermissions(rolePermissions, enabledModules, isAdmin = false) {
    const permissions = {};
    const activeModules = [];
    for (const perm of rolePermissions) {
        if (!enabledModules.includes(perm.moduleKey))
            continue;
        if (!perm.canRead)
            continue;
        permissions[perm.moduleKey] = {
            canRead: Boolean(perm.canRead),
            canCreate: Boolean(perm.canCreate),
            canUpdate: Boolean(perm.canUpdate),
            canDelete: Boolean(perm.canDelete),
        };
        activeModules.push(perm.moduleKey);
    }
    // Admin-role employees automatically get full administration access if the tenant has it enabled
    if (isAdmin && enabledModules.includes(MODULE_KEYS.ADMINISTRATION) && !activeModules.includes(MODULE_KEYS.ADMINISTRATION)) {
        permissions[MODULE_KEYS.ADMINISTRATION] = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };
        activeModules.push(MODULE_KEYS.ADMINISTRATION);
    }
    return { permissions, activeModules };
}
const UpdateMeSchema = z.object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    phone: z.string().optional(),
    avatarUrl: z.string().url().nullable().optional(),
});
export const updateMe = async (req, res) => {
    try {
        const parsed = UpdateMeSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const { firstName, lastName, phone, avatarUrl } = parsed.data;
        const updates = {};
        if (firstName !== undefined)
            updates.firstName = firstName;
        if (lastName !== undefined)
            updates.lastName = lastName;
        if (phone !== undefined)
            updates.phone = phone || null;
        if (avatarUrl !== undefined)
            updates.avatarUrl = avatarUrl;
        if (req.user?.accountType === 'owner') {
            const current = await prisma.user.findUnique({
                where: { id: req.user.id },
                select: { avatarUrl: true },
            });
            const previousAvatarUrl = current?.avatarUrl ?? null;
            const updated = await prisma.user.update({
                where: { id: req.user.id },
                data: updates,
                select: { id: true, email: true, firstName: true, lastName: true, phone: true, tenantId: true, avatarUrl: true },
            });
            if (avatarUrl !== undefined && previousAvatarUrl && previousAvatarUrl !== updated.avatarUrl) {
                await deleteStoredFile(previousAvatarUrl);
            }
            // Notify user
            await sendNotification({
                tenantId: updated.tenantId,
                userId: updated.id,
                userType: 'OWNER',
                type: 'system.profile.updated',
                title: 'Profile Updated',
                message: 'Your profile information has been updated.',
            });
            void logAudit({
                tenantId: updated.tenantId,
                actorType: AuditActorType.OWNER,
                actorId: updated.id,
                actorName: `${updated.firstName} ${updated.lastName}`,
                action: 'PROFILE_UPDATED',
                module: 'settings',
                ...extractRequestContext(req),
            });
            return res.json({
                success: true,
                message: 'Profile updated',
                data: {
                    ...updated,
                    avatarUrl: await resolveSignedUrl(updated.avatarUrl),
                },
            });
        }
        if (req.user?.accountType === 'employee') {
            const current = await prisma.employee.findUnique({
                where: { id: req.user.id },
                select: { avatarUrl: true },
            });
            const previousAvatarUrl = current?.avatarUrl ?? null;
            const updated = await prisma.employee.update({
                where: { id: req.user.id },
                data: updates,
                select: { id: true, email: true, firstName: true, lastName: true, phone: true, tenantId: true, avatarUrl: true },
            });
            if (avatarUrl !== undefined && previousAvatarUrl && previousAvatarUrl !== updated.avatarUrl) {
                await deleteStoredFile(previousAvatarUrl);
            }
            // Notify user
            await sendNotification({
                tenantId: updated.tenantId,
                userId: updated.id,
                userType: 'EMPLOYEE',
                type: 'system.profile.updated',
                title: 'Profile Updated',
                message: 'Your profile information has been updated.',
            });
            void logAudit({
                tenantId: updated.tenantId,
                actorType: AuditActorType.EMPLOYEE,
                actorId: updated.id,
                actorName: `${updated.firstName} ${updated.lastName}`,
                action: 'PROFILE_UPDATED',
                module: 'settings',
                ...extractRequestContext(req),
            });
            return res.json({
                success: true,
                message: 'Profile updated',
                data: {
                    ...updated,
                    avatarUrl: await resolveSignedUrl(updated.avatarUrl),
                },
            });
        }
        return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    catch (error) {
        console.error('Error updating profile:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update profile',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
function respondWithTenantStatus(res, status, suspendedReason) {
    if (status === 'PENDING_APPROVAL') {
        return res.status(403).json({
            success: false,
            code: 'ACCOUNT_PENDING_APPROVAL',
            message: 'Your account is pending approval. Please check back later.',
        });
    }
    if (status === 'SUSPENDED') {
        return res.status(403).json({
            success: false,
            code: 'ACCOUNT_SUSPENDED',
            message: 'Your account has been suspended. Please contact support.',
            reason: suspendedReason || null,
        });
    }
    if (status === 'INACTIVE') {
        return res.status(403).json({
            success: false,
            code: 'ACCOUNT_INACTIVE',
            message: 'This account is no longer active.',
        });
    }
    return res.status(403).json({
        success: false,
        code: 'ACCOUNT_INACTIVE',
        message: 'This account is no longer active.',
    });
}
const ForgotPasswordSchema = z.object({
    email: z.string().email(),
});
const VerifyOtpSchema = z.object({
    email: z.string().email(),
    otp: z.string().length(6),
});
const ResetPasswordSchema = z.object({
    resetToken: z.string(),
    newPassword: z.string().min(8),
});
export const forgotPassword = async (req, res) => {
    try {
        const parsed = ForgotPasswordSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const email = parsed.data.email.toLowerCase().trim();
        const [user, employee] = await Promise.all([
            prisma.user.findUnique({ where: { email } }),
            prisma.employee.findUnique({ where: { email } }),
        ]);
        if (user) {
            const otp = String(Math.floor(100000 + Math.random() * 900000));
            const otpHash = await bcrypt.hash(otp, 10);
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
            // Invalidate any previous unused OTPs for this user before creating a new one
            await prisma.passwordResetOtp.updateMany({
                where: { userId: user.id, userType: 'OWNER', usedAt: null },
                data: { usedAt: new Date() },
            });
            await prisma.passwordResetOtp.create({
                data: {
                    userId: user.id,
                    userType: 'OWNER',
                    otpHash,
                    expiresAt,
                },
            });
            void sendEmail({
                to: email,
                subject: 'Your StockVero password reset code',
                html: forgotPasswordTemplate({ name: user.firstName, otpCode: otp }),
            });
            void logAudit({
                tenantId: user.tenantId,
                actorType: AuditActorType.OWNER,
                actorId: user.id,
                action: 'PASSWORD_RESET_REQUESTED',
                module: 'settings',
                ...extractRequestContext(req),
            });
        }
        else if (employee) {
            const otp = String(Math.floor(100000 + Math.random() * 900000));
            const otpHash = await bcrypt.hash(otp, 10);
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
            // Invalidate any previous unused OTPs for this employee before creating a new one
            await prisma.passwordResetOtp.updateMany({
                where: { userId: employee.id, userType: 'EMPLOYEE', usedAt: null },
                data: { usedAt: new Date() },
            });
            await prisma.passwordResetOtp.create({
                data: {
                    userId: employee.id,
                    userType: 'EMPLOYEE',
                    otpHash,
                    expiresAt,
                },
            });
            void sendEmail({
                to: email,
                subject: 'Your StockVero password reset code',
                html: forgotPasswordTemplate({ name: employee.firstName, otpCode: otp }),
            });
            void logAudit({
                tenantId: employee.tenantId,
                actorType: AuditActorType.EMPLOYEE,
                actorId: employee.id,
                action: 'PASSWORD_RESET_REQUESTED',
                module: 'settings',
                ...extractRequestContext(req),
            });
        }
        // send the email regardless to avoid user enumeration
        return res.status(200).json({
            success: true,
            message: 'If an account exists for that email, a reset code has been sent.',
        });
    }
    catch (error) {
        console.error('Error generating password reset OTP:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to process request',
        });
    }
};
export const verifyOtp = async (req, res) => {
    try {
        const parsed = VerifyOtpSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const { email, otp } = parsed.data;
        const normalizedEmail = email.toLowerCase().trim();
        const [user, employee] = await Promise.all([
            prisma.user.findUnique({ where: { email: normalizedEmail } }),
            prisma.employee.findUnique({ where: { email: normalizedEmail } }),
        ]);
        const record = user || employee;
        const userType = user ? 'OWNER' : 'EMPLOYEE';
        if (!record) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }
        const otpRecord = await prisma.passwordResetOtp.findFirst({
            where: {
                userId: record.id,
                userType,
                usedAt: null,
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
        });
        if (!otpRecord) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired OTP',
            });
        }
        const isValid = await bcrypt.compare(otp, otpRecord.otpHash);
        if (!isValid) {
            return res.status(400).json({
                success: false,
                message: 'Invalid OTP',
            });
        }
        const resetToken = generateToken({
            userId: record.id,
            userType,
            purpose: 'password_reset',
        }, '5m');
        void logAudit({
            tenantId: record.tenantId,
            actorType: userType === 'OWNER' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
            actorId: record.id,
            actorName: `${record.firstName} ${record.lastName}`,
            action: 'OTP_VERIFIED',
            module: 'auth',
            ...extractRequestContext(req),
        });
        return res.status(200).json({
            success: true,
            message: 'OTP verified',
            data: { resetToken },
        });
    }
    catch (error) {
        console.error('Error verifying OTP:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to verify OTP',
        });
    }
};
export const resetPassword = async (req, res) => {
    try {
        const parsed = ResetPasswordSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const { resetToken, newPassword } = parsed.data;
        const decoded = verifyToken(resetToken);
        if (decoded.purpose !== 'password_reset') {
            return res.status(400).json({
                success: false,
                message: 'Invalid token purpose',
            });
        }
        const { userId, userType } = decoded;
        const passwordHash = await bcrypt.hash(newPassword, 10);
        if (userType === 'OWNER') {
            await prisma.user.update({
                where: { id: userId },
                data: { passwordHash },
            });
        }
        else {
            await prisma.employee.update({
                where: { id: userId },
                data: {
                    passwordHash,
                    mustChangePassword: false,
                    tokenVersion: { increment: 1 },
                },
            });
        }
        await prisma.passwordResetOtp.updateMany({
            where: { userId, usedAt: null },
            data: { usedAt: new Date() },
        });
        void logAudit({
            tenantId: decoded.tenantId ?? 'unknown',
            actorType: userType === 'OWNER' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
            actorId: userId,
            action: 'PASSWORD_RESET_COMPLETED',
            module: 'auth',
            ...extractRequestContext(req),
        });
        return res.status(200).json({
            success: true,
            message: 'Password reset successfully',
        });
    }
    catch (error) {
        console.error('Error resetting password:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to reset password',
        });
    }
};
