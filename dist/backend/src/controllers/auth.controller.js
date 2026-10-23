import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '../db.js';
import { generateToken, verifyToken } from '../lib/jwt.js';
import { MODULE_KEYS, MODULES_CONFIG, OWNER_PERMANENT_MODULES } from '../config/modules.js';
import { ORGANIZATION_TYPES } from '../config/industries.js';
import { isValidSlug, generateSlug } from '../lib/slug.js';
import { defaultSettingsForSignup, readTenantSettings } from '../lib/tenantSettings.js';
import { UserRole } from '@prisma/client';
import { calculatePricing, PRICING_MODULE_KEYS, } from '../lib/pricing.js';
import { getPeriodEnd, toDecimal } from '../services/billing.service.js';
import { sendNotification } from '../services/notificationService.js';
import { sendEmail } from '../services/emailService.js';
import { tenantRegistrationReceived, forgotPassword as forgotPasswordTemplate, emailVerification as emailVerificationTemplate } from '../emails/templates.js';
import { isValidPhone, passwordStrengthMessage } from '../lib/validators.js';
import { logAudit, extractRequestContext, AuditActorType, AuditStatus } from '../services/auditService.js';
import { resolveSignedUrl, deleteStoredFile, uploadPrivateFile } from '../lib/storage.js';
import crypto from 'crypto';
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
    password: z
        .string()
        .min(8)
        .superRefine((val, ctx) => {
        const msg = passwordStrengthMessage(val);
        if (msg)
            ctx.addIssue({ code: 'custom', message: msg });
    }),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    organizationName: z.string().min(1),
    slug: z.string().optional(),
    industry: z.string().min(1),
    /**
     * The business type behind the industry label. Optional so an older client
     * still works; absent, it is inferred from the modules that were picked.
     */
    organizationType: z.enum(ORGANIZATION_TYPES).optional(),
    /**
     * Free-text business/industry name the owner types when they pick "Something
     * else" (OTHER). Optional otherwise; required when organisationType == OTHER.
     */
    customIndustry: z.string().trim().max(120).optional(),
    website: z.string().optional(),
    phone: z.string().min(1),
    country: z.string().min(1),
    city: z.string().min(1),
    state: z.string().optional(),
    /**
     * Proof that the owner controls the address, issued by
     * /verify-email/confirm. Required: an unverified address meant a mistyped
     * email locked someone out of a brand-new account with no way back in,
     * since every recovery path goes through that same address. Admin approval
     * (PENDING_APPROVAL) still applies afterwards — this gates it, not replaces it.
     */
    verificationToken: z.string().min(1, 'Verify your email before creating the account.'),
    /**
     * Optional business-identity evidence. Optional as a product decision, so
     * every field here may be absent — but the combination is checked below:
     * a chosen type needs its document, and TAX_ID needs its number. Half-filled
     * is worse than empty, because it looks submitted to the approving admin.
     */
    verificationIdType: z.enum(['TAX_ID', 'NATIONAL_ID']).optional(),
    verificationIdNumber: z.string().trim().max(64).optional(),
    /** Object path in the private bucket, from /signup/verification-document. */
    verificationDocPath: z.string().trim().max(512).optional(),
    verificationDocName: z.string().trim().max(200).optional(),
    verificationDocMime: z.string().trim().max(100).optional(),
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
        const { email, password, firstName, lastName, organizationName, slug, industry, organizationType, customIndustry, website, phone, country, city, state, verificationToken, organisationSize, modules, billingCycle, startTrial, paymentMethod, theme, } = parsed.data;
        // Identity evidence is optional as a whole, but not partially. Either
        // nothing was submitted, or what was submitted has to be coherent —
        // otherwise the approving admin sees "Tax ID" with no number and no
        // document and cannot tell whether the owner failed to supply it or the
        // upload silently dropped.
        const { verificationIdType, verificationIdNumber, verificationDocPath, verificationDocName, verificationDocMime, } = parsed.data;
        if (verificationIdType && !verificationDocPath) {
            return res.status(400).json({
                success: false,
                message: 'Attach the supporting document, or leave the ID section empty.',
            });
        }
        if (verificationIdType === 'TAX_ID' && !verificationIdNumber?.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Enter the Tax ID number, or leave the ID section empty.',
            });
        }
        // A path with no type is meaningless to the admin reviewing it.
        if (verificationDocPath && !verificationIdType) {
            return res.status(400).json({
                success: false,
                message: 'Choose whether this document is a Tax ID or a National ID.',
            });
        }
        // Only paths this server issued are accepted. Without this the field is an
        // open pointer into the private bucket, and a caller could attach some
        // other tenant's object to their own account.
        if (verificationDocPath && !verificationDocPath.startsWith('pending-signups/')) {
            return res.status(400).json({
                success: false,
                message: 'That document reference is not valid. Please re-upload the document.',
            });
        }
        // A phone number is only valid against the country it belongs to — the
        // length expected after the dial code differs per country.
        if (!isValidPhone(phone, country)) {
            return res.status(400).json({
                success: false,
                message: 'Enter a valid phone number for the selected country.',
            });
        }
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
        // The token must be present (schema-enforced) AND bound to this exact
        // address. Binding matters: without the email check a token earned for
        // one address would let an account be created for a different, unverified
        // one — which is the whole thing this gate exists to prevent.
        try {
            const decoded = verifyToken(verificationToken);
            const valid = decoded.purpose === 'email_verification' &&
                String(decoded.email ?? '').toLowerCase() === email.toLowerCase();
            if (!valid) {
                return res.status(422).json({
                    success: false,
                    message: 'That email has not been verified. Please verify it and try again.',
                });
            }
        }
        catch {
            return res.status(422).json({
                success: false,
                message: 'Your email verification has expired. Please request a new code and verify again.',
            });
        }
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
        // organizationType was declared on the tenant model but nothing ever wrote
        // it, so every downstream default had to be guessed from the module list.
        // An older client that does not send it still gets a sensible value rather
        // than null.
        const resolvedOrgType = organizationType ??
            (selectedModules.includes(MODULE_KEYS.RETAIL_SALES) &&
                selectedModules.includes(MODULE_KEYS.WHOLESALE_SALES)
                ? 'RETAIL_WHOLESALE'
                : selectedModules.includes(MODULE_KEYS.WHOLESALE_SALES)
                    ? 'WHOLESALE_DISTRIBUTION'
                    : selectedModules.includes(MODULE_KEYS.RETAIL_SALES)
                        ? 'RETAIL_SHOP'
                        : selectedModules.includes(MODULE_KEYS.PROJECTS)
                            ? 'SERVICE_INSTALLATION'
                            : 'OTHER');
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
        // For "Something else" (OTHER) the owner describes their industry in their
        // own words. That name becomes the tenant's industry so every screen that
        // already reads it keeps working.
        const storedIndustry = resolvedOrgType === 'OTHER' && customIndustry ? customIndustry : industry;
        const tenant = await prisma.tenant.create({
            data: {
                name: organizationName,
                subdomain,
                industry: storedIndustry,
                organizationType: resolvedOrgType ?? undefined,
                website: website || null,
                phone,
                country,
                city,
                state: state || null,
                // Only the object path is stored — never a URL. Admins read it via a
                // short-lived signed URL; see GET .../verification-document.
                verificationIdType: verificationIdType ?? null,
                verificationIdNumber: verificationIdType === 'TAX_ID' ? verificationIdNumber?.trim() || null : null,
                verificationDocPath: verificationDocPath || null,
                verificationDocName: verificationDocName || null,
                verificationDocMime: verificationDocMime || null,
                organisationSize: sizeValueMap[organisationSize],
                billingCycle,
                isTrialActive: startTrial,
                trialEndsAt: null,
                nextBillingDate: null,
                currentMonthlyAmount: toDecimal(pricing.monthlyTotal),
                currentAnnualAmount: toDecimal(pricing.annualTotal),
                themeConfig: theme || getDefaultTheme(),
                // Shops and distributors put stock straight on the shelf; project-based
                // businesses keep finance approval in front of it.
                settingsConfig: defaultSettingsForSignup({
                    organizationType: resolvedOrgType,
                    selectedModules,
                }),
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
        // One-time: the verification code cannot be reused for a second account.
        await prisma.emailVerificationOtp.updateMany({
            where: { email, usedAt: null },
            data: { usedAt: new Date() },
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
/**
 * The tenant object every auth response returns.
 *
 * Written once because it was previously written four times — twice in login and
 * twice in me — and the copies had already drifted: only the two in me carried
 * `subdomain`, and none of them carried industry, website or organizationType.
 * The client filled those gaps with hardcoded defaults, so every login silently
 * reset the displayed industry to "Solar Energy" and blanked the website.
 */
function tenantPayload(tenant, logoUrl) {
    return {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        industry: tenant.industry ?? '',
        website: tenant.website ?? '',
        organizationType: tenant.organizationType ?? null,
        country: tenant.country ?? '',
        state: tenant.state ?? '',
        city: tenant.city ?? '',
        theme: tenant.themeConfig,
        settings: readTenantSettings(tenant),
        logoUrl,
    };
}
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
                    tenant: tenantPayload(user.tenant, logoUrl),
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
        const { activeModules, permissions } = buildEmployeePermissions(employee.role.permissions, enabledModules);
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
        const empPref = await prisma.userPreference.findUnique({
            where: { tenantId_userId: { tenantId: employee.tenantId, userId: employee.id } },
            select: { themeConfig: true },
        });
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
                tenant: tenantPayload(employee.tenant, employeeLogoUrl),
                userTheme: empPref?.themeConfig ?? null,
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
            if (await bcrypt.compare(newPassword, user.passwordHash)) {
                return res.status(400).json({
                    success: false,
                    message: 'New password must be different from the current password',
                });
            }
            const passwordHash = await bcrypt.hash(newPassword, 10);
            await prisma.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: null } });
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
        if (await bcrypt.compare(newPassword, employee.passwordHash)) {
            return res.status(400).json({
                success: false,
                message: 'New password must be different from the current password',
            });
        }
        const passwordHash = await bcrypt.hash(newPassword, 10);
        const updated = await prisma.employee.update({
            where: { id: employee.id },
            data: {
                passwordHash,
                mustChangePassword: false,
                tokenVersion: { increment: 1 },
                passwordChangedAt: null,
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
            const ownerPref = await prisma.userPreference.findUnique({
                where: { tenantId_userId: { tenantId: user.tenantId, userId: user.id } },
                select: { themeConfig: true },
            });
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
                    tenant: tenantPayload(user.tenant, logoUrl),
                    userTheme: ownerPref?.themeConfig ?? null,
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
        const mePref = await prisma.userPreference.findUnique({
            where: { tenantId_userId: { tenantId: employee.tenantId, userId: employee.id } },
            select: { themeConfig: true },
        });
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
                tenant: tenantPayload(employee.tenant, employeeLogoUrl),
                userTheme: mePref?.themeConfig ?? null,
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
    // Legacy fallback: roles with isAdmin=true that predate the module-based
    // permission system may have no RolePermission row for 'administration'.
    // Grant canRead+canCreate automatically so these employees can still access
    // the Administration pages without requiring a re-login or migration.
    if (isAdmin && !permissions['administration'] && enabledModules.includes('administration')) {
        permissions['administration'] = { canRead: true, canCreate: true, canUpdate: false, canDelete: false };
        activeModules.push('administration');
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
        const record = user || employee;
        const userType = user ? 'OWNER' : 'EMPLOYEE';
        if (record) {
            const otp = String(Math.floor(100000 + Math.random() * 900000));
            const otpHash = await bcrypt.hash(otp, 10);
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
            // Invalidate any previous unused OTPs for this account before creating a new one
            await prisma.passwordResetOtp.updateMany({
                where: { userId: record.id, userType, usedAt: null },
                data: { usedAt: new Date() },
            });
            await prisma.passwordResetOtp.create({
                data: {
                    userId: record.id,
                    userType,
                    otpHash,
                    expiresAt,
                },
            });
            const sent = await sendEmail({
                to: email,
                subject: 'Your StockVero password reset code',
                html: forgotPasswordTemplate({ name: record.firstName, otpCode: otp }),
            });
            // The account genuinely exists but we could not deliver the reset code.
            // Silently returning success here would lock a real, trusting user out of
            // their own account, so surface the failure clearly instead.
            if (!sent) {
                console.error(`[forgot-password] Failed to email reset code to existing account ${email}`);
                return res.status(422).json({
                    success: false,
                    message: 'We could not send the reset code to that email. Please check the address or contact support.',
                });
            }
            void logAudit({
                tenantId: record.tenantId,
                actorType: user === record ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
                actorId: record.id,
                action: 'PASSWORD_RESET_REQUESTED',
                module: 'settings',
                ...extractRequestContext(req),
            });
        }
        // Identical response for unknown accounts and successful sends, to avoid
        // user enumeration. (A real delivery failure above is the only case that
        // returns a distinct, non-200 response, and only to someone who already
        // controls the account's inbox.)
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
const RequestEmailVerificationSchema = z.object({
    email: z.string().email(),
});
const ConfirmEmailVerificationSchema = z.object({
    email: z.string().email(),
    otp: z.string().length(6),
});
// TODO(phone-channel): add 'SMS' | 'WHATSAPP' here and a matching case in
// sendVerificationCode once a provider and template are approved.
/**
 * Delivers a verification code over the requested channel.
 *
 * The single place that knows how a code reaches a person. Callers pass a
 * destination and a channel and get back whether it was delivered; they do not
 * know or care which transport ran.
 */
async function sendVerificationCode(params) {
    const { channel, destination, code, name } = params;
    switch (channel) {
        case 'EMAIL':
            return sendEmail({
                to: destination,
                subject: 'Confirm your email — StockVero',
                html: emailVerificationTemplate({ name: name ?? 'there', otpCode: code }),
            });
        default: {
            // Exhaustiveness guard: adding a channel to the union without handling
            // it here becomes a compile error rather than a silent no-send.
            const unreachable = channel;
            console.error(`[verification] Unsupported channel: ${String(unreachable)}`);
            return false;
        }
    }
}
/** How long a signup verification code stays valid. */
const OTP_TTL_MS = 15 * 60 * 1000;
/** Minimum gap between code requests for the same address. */
const RESEND_COOLDOWN_MS = 60 * 1000;
/**
 * Wrong guesses allowed per code. Six digits is a million combinations, so this
 * is not really about brute force inside 15 minutes — it is about not letting a
 * typo-loop run forever, while still telling the person what is happening.
 */
const MAX_OTP_ATTEMPTS = 5;
/** Identity documents only — a scan or photo, or a PDF certificate. */
const ID_DOC_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
/** Smaller than the 10MB general document cap; this is one page or one photo. */
const ID_DOC_MAX_BYTES = 5 * 1024 * 1024;
/**
 * POST /api/v1/auth/signup/verification-document
 *
 * Stages the optional business-identity document while the account still does
 * not exist. Three things make this safe to expose without a session:
 *
 *  - It requires the `email_verification` token, so the caller has already
 *    proved control of the address. It is never anonymous, and the token
 *    expires in 10 minutes.
 *  - The object goes to the PRIVATE bucket, so the returned path is not
 *    fetchable by URL. Only an authenticated admin can later sign it.
 *  - Type and size are capped before anything is uploaded.
 *
 * Returns the object path, which the client passes to /signup. The account is
 * created from that path — this endpoint writes no database row, because at
 * this point there is no tenant to attach one to.
 */
export const uploadSignupVerificationDocument = async (req, res) => {
    try {
        const token = String(req.body?.verificationToken ?? '');
        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Verify your email before uploading a document.',
            });
        }
        let email;
        try {
            const decoded = verifyToken(token);
            if (decoded.purpose !== 'email_verification' || !decoded.email) {
                return res.status(401).json({
                    success: false,
                    message: 'That verification is not valid for uploading a document.',
                });
            }
            email = String(decoded.email).toLowerCase();
        }
        catch {
            return res.status(401).json({
                success: false,
                message: 'Your email verification has expired. Please request a new code.',
            });
        }
        const file = req.file;
        if (!file) {
            return res.status(400).json({ success: false, message: 'No document was attached.' });
        }
        if (!ID_DOC_MIME_TYPES.includes(file.mimetype)) {
            return res.status(400).json({
                success: false,
                message: 'That file type is not supported. Upload a JPG, PNG, WEBP or PDF.',
            });
        }
        if (file.size > ID_DOC_MAX_BYTES) {
            return res.status(400).json({
                success: false,
                message: 'That file is larger than 5 MB. Please upload a smaller image or PDF.',
            });
        }
        // Keyed by a hash of the email, not the address itself: object paths end up
        // in storage logs, and an email is personal data in its own right.
        const emailKey = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);
        const cleanName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
        const storagePath = `pending-signups/${emailKey}/${Date.now()}_${cleanName}`;
        const uploaded = await uploadPrivateFile(storagePath, file.buffer, file.mimetype);
        if (!uploaded.ok) {
            console.error('[signup-doc] Upload failed:', uploaded.error);
            return res.status(502).json({
                success: false,
                message: 'We could not store that document. Please try again in a moment.',
            });
        }
        return res.status(201).json({
            success: true,
            message: 'Document uploaded.',
            data: {
                storagePath,
                fileName: file.originalname,
                mimeType: file.mimetype,
            },
        });
    }
    catch (error) {
        console.error('Error uploading signup verification document:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to upload the document. Please try again.',
        });
    }
};
/**
 * POST /api/v1/auth/verify-email/request
 *
 * Sends a 6-digit code to the address the owner gave, so they can prove they
 * control it before the account is created. This is what stops a mistyped or
 * nonexistent address from locking someone out of a brand-new account.
 */
export const requestEmailVerification = async (req, res) => {
    try {
        const parsed = RequestEmailVerificationSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const email = parsed.data.email.toLowerCase().trim();
        // Do not hand out codes for addresses that already own an account. Both
        // tables are checked: an employee's address would otherwise be handed a
        // code and only collide at account creation, after the person had already
        // gone to the trouble of verifying it.
        const [existingUser, existingEmployee] = await Promise.all([
            prisma.user.findUnique({ where: { email } }),
            prisma.employee.findUnique({ where: { email } }),
        ]);
        if (existingUser || existingEmployee) {
            return res.status(200).json({
                success: true,
                message: 'If an account exists for that email, a code has been sent.',
            });
        }
        // Resend cooldown. Without it the endpoint is an open relay: anyone could
        // aim repeated emails at an address they do not own.
        const lastCode = await prisma.emailVerificationOtp.findFirst({
            where: { email },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
        });
        if (lastCode) {
            const elapsedMs = Date.now() - lastCode.createdAt.getTime();
            if (elapsedMs < RESEND_COOLDOWN_MS) {
                const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000);
                return res.status(429).json({
                    success: false,
                    message: `Please wait ${waitSeconds} second${waitSeconds === 1 ? '' : 's'} before requesting another code.`,
                    data: { retryAfterSeconds: waitSeconds },
                });
            }
        }
        // Only one code is ever live per address — requesting a new one retires the
        // previous, so an old code in an old email cannot still be used.
        const otp = String(Math.floor(100000 + Math.random() * 900000));
        const otpHash = await bcrypt.hash(otp, 10);
        const expiresAt = new Date(Date.now() + OTP_TTL_MS);
        await prisma.emailVerificationOtp.updateMany({
            where: { email, usedAt: null },
            data: { usedAt: new Date() },
        });
        await prisma.emailVerificationOtp.create({
            data: { email, otpHash, expiresAt },
        });
        // Routed through the channel seam rather than calling sendEmail directly,
        // so a phone channel later needs no change here.
        const sent = await sendVerificationCode({
            channel: 'EMAIL',
            destination: email,
            code: otp,
        });
        if (!sent) {
            console.error(`[verify-email] Failed to email verification code to ${email}`);
            return res.status(422).json({
                success: false,
                message: 'We could not send a verification code to that email. Please check the address and try again.',
            });
        }
        return res.status(200).json({
            success: true,
            message: 'Verification code sent.',
        });
    }
    catch (error) {
        console.error('Error sending email verification code:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to send verification code',
        });
    }
};
/**
 * POST /api/v1/auth/verify-email/confirm
 *
 * Checks the code and, if valid, returns a short-lived token tied to that exact
 * email. The token is what the signup endpoint requires to proceed.
 */
export const confirmEmailVerification = async (req, res) => {
    try {
        const parsed = ConfirmEmailVerificationSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const email = parsed.data.email.toLowerCase().trim();
        const { otp } = parsed.data;
        // Fetched without the expiry filter so an expired code can be reported as
        // expired. Filtering it out here made a timed-out code indistinguishable
        // from a wrong one, and "invalid or has expired" told the user neither.
        const record = await prisma.emailVerificationOtp.findFirst({
            where: { email, usedAt: null },
            orderBy: { createdAt: 'desc' },
        });
        if (!record) {
            return res.status(400).json({
                success: false,
                message: 'No verification code is pending for this email. Request a new one.',
            });
        }
        if (record.expiresAt.getTime() <= Date.now()) {
            return res.status(400).json({
                success: false,
                message: 'That code has expired. Request a new one.',
                data: { reason: 'expired' },
            });
        }
        if (record.attempts >= MAX_OTP_ATTEMPTS) {
            // Retired so the next attempt cannot keep hammering a burnt code.
            await prisma.emailVerificationOtp.update({
                where: { id: record.id },
                data: { usedAt: new Date() },
            });
            return res.status(429).json({
                success: false,
                message: 'Too many incorrect attempts on that code. Request a new one.',
                data: { reason: 'attempts_exhausted' },
            });
        }
        const isValid = await bcrypt.compare(otp, record.otpHash);
        if (!isValid) {
            const attempts = record.attempts + 1;
            await prisma.emailVerificationOtp.update({
                where: { id: record.id },
                data: { attempts },
            });
            const remaining = MAX_OTP_ATTEMPTS - attempts;
            return res.status(400).json({
                success: false,
                message: remaining > 0
                    ? `That code is incorrect. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
                    : 'That code is incorrect, and you have no attempts left. Request a new one.',
                data: { reason: 'incorrect', attemptsRemaining: Math.max(0, remaining) },
            });
        }
        // Spent on success. Without this the code stayed replayable for the rest of
        // its 15-minute window, so one intercepted email could be reused.
        await prisma.emailVerificationOtp.update({
            where: { id: record.id },
            data: { usedAt: new Date() },
        });
        const verificationToken = generateToken({
            email,
            purpose: 'email_verification',
        }, '10m');
        return res.status(200).json({
            success: true,
            message: 'Email verified.',
            data: { verificationToken },
        });
    }
    catch (error) {
        console.error('Error confirming email verification:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to verify email',
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
        const currentRecord = userType === 'OWNER'
            ? await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
            : await prisma.employee.findUnique({ where: { id: userId }, select: { passwordHash: true } });
        if (!currentRecord) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }
        // Reject reusing the current password so a reset must actually change it.
        if (await bcrypt.compare(newPassword, currentRecord.passwordHash)) {
            return res.status(400).json({
                success: false,
                message: 'New password must be different from the current password',
            });
        }
        const passwordHash = await bcrypt.hash(newPassword, 10);
        if (userType === 'OWNER') {
            await prisma.user.update({
                where: { id: userId },
                data: { passwordHash, passwordChangedAt: null },
            });
        }
        else {
            await prisma.employee.update({
                where: { id: userId },
                data: {
                    passwordHash,
                    mustChangePassword: false,
                    tokenVersion: { increment: 1 },
                    passwordChangedAt: null,
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
