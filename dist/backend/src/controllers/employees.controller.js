import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '../db.js';
import { sendNotification, broadcastToModule } from '../services/notificationService.js';
import { sendEmail } from '../services/emailService.js';
import { employeeWelcome, employeePasswordReset } from '../emails/templates.js';
import { logAudit, extractRequestContext, AuditActorType } from '../services/auditService.js';
import { resolveSignedUrl, deleteStoredFile } from '../lib/storage.js';
const CreateEmployeeSchema = z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    jobTitle: z.string().optional(),
    roleId: z.string().uuid(),
    avatarUrl: z.string().url().optional(),
    isActive: z.boolean().optional(),
});
const UpdateEmployeeSchema = z.object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    jobTitle: z.string().optional(),
    roleId: z.string().uuid().optional(),
    avatarUrl: z.string().url().nullable().optional(),
    isActive: z.boolean().optional(),
});
const RoleSchema = z.object({
    roleId: z.string().uuid(),
});
const StatusSchema = z.object({
    isActive: z.boolean(),
});
const serializeEmployee = async (employee) => ({
    ...employee,
    avatarUrl: await resolveSignedUrl(employee.avatarUrl),
});
function generateTemporaryPassword(firstName, tenantSlug) {
    const namePart = firstName.trim().toLowerCase();
    const tenantPart = tenantSlug.trim().toUpperCase();
    const random = Math.floor(1000 + Math.random() * 9000);
    return `${namePart}@${tenantPart}${random}`;
}
async function getTenantSlug(tenantId) {
    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { subdomain: true, name: true },
    });
    if (!tenant)
        return null;
    return tenant.subdomain || tenant.name;
}
export const listEmployees = async (req, res) => {
    try {
        const isActive = typeof req.query.isActive === 'string'
            ? req.query.isActive === 'true'
            : undefined;
        const roleId = typeof req.query.roleId === 'string' ? req.query.roleId : undefined;
        const search = typeof req.query.search === 'string' ? req.query.search : undefined;
        const where = { tenantId: req.tenantId };
        if (typeof isActive === 'boolean')
            where.isActive = isActive;
        if (roleId)
            where.roleId = roleId;
        if (search) {
            where.OR = [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
            ];
        }
        const employees = await prisma.employee.findMany({
            where,
            select: {
                id: true,
                tenantId: true,
                roleId: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                jobTitle: true,
                avatarUrl: true,
                isActive: true,
                mustChangePassword: true,
                tokenVersion: true,
                lastLoginAt: true,
                createdAt: true,
                updatedAt: true,
                role: { select: { id: true, name: true, abbreviation: true, isAdmin: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
        const data = await Promise.all(employees.map(async (employee) => ({
            ...(await serializeEmployee(employee)),
            roleName: employee.role.name,
            roleAbbreviation: employee.role.abbreviation,
        })));
        return res.json({
            success: true,
            message: 'Employees retrieved successfully',
            data,
        });
    }
    catch (error) {
        console.error('Error listing employees:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve employees',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const getEmployee = async (req, res) => {
    try {
        const employee = await prisma.employee.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
            select: {
                id: true,
                tenantId: true,
                roleId: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                jobTitle: true,
                avatarUrl: true,
                isActive: true,
                mustChangePassword: true,
                tokenVersion: true,
                lastLoginAt: true,
                createdAt: true,
                updatedAt: true,
                role: {
                    select: {
                        id: true,
                        name: true,
                        abbreviation: true,
                        isAdmin: true,
                        permissions: true,
                    },
                },
            },
        });
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }
        return res.json({
            success: true,
            message: 'Employee retrieved successfully',
            data: await serializeEmployee(employee),
        });
    }
    catch (error) {
        console.error('Error fetching employee:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve employee',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const createEmployee = async (req, res) => {
    try {
        const parsed = CreateEmployeeSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const payload = parsed.data;
        const existingUser = await prisma.user.findUnique({ where: { email: payload.email } });
        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: 'Email already registered',
            });
        }
        const existingEmployee = await prisma.employee.findUnique({ where: { email: payload.email } });
        if (existingEmployee) {
            return res.status(409).json({
                success: false,
                message: 'Email already registered',
            });
        }
        const role = await prisma.role.findFirst({
            where: { id: payload.roleId, tenantId: req.tenantId },
        });
        if (!role) {
            return res.status(400).json({
                success: false,
                message: 'Invalid role',
            });
        }
        const tenantSlug = await getTenantSlug(req.tenantId);
        if (!tenantSlug) {
            return res.status(404).json({
                success: false,
                message: 'Tenant not found',
            });
        }
        const temporaryPassword = generateTemporaryPassword(payload.firstName, tenantSlug);
        const passwordHash = await bcrypt.hash(temporaryPassword, 10);
        const employee = await prisma.employee.create({
            data: {
                tenantId: req.tenantId,
                roleId: payload.roleId,
                firstName: payload.firstName.trim(),
                lastName: payload.lastName.trim(),
                email: payload.email.toLowerCase().trim(),
                phone: payload.phone?.trim() || null,
                jobTitle: payload.jobTitle?.trim() || null,
                avatarUrl: payload.avatarUrl?.trim() || null,
                isActive: payload.isActive ?? true,
                mustChangePassword: true,
                passwordHash,
            },
            select: {
                id: true,
                tenantId: true,
                roleId: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                jobTitle: true,
                avatarUrl: true,
                isActive: true,
                mustChangePassword: true,
                tokenVersion: true,
                lastLoginAt: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        // Notify authorized users in Administration
        await broadcastToModule(req.tenantId, 'administration', {
            type: 'administration.employee.created',
            title: 'New Employee Added',
            message: `${employee.firstName} ${employee.lastName} has been added to the team.`,
            link: `/administration/employees/${employee.id}`,
        });
        // Welcome notification to the user
        const tenant = await prisma.tenant.findUnique({
            where: { id: req.tenantId },
            select: { name: true },
        });
        sendNotification({
            tenantId: req.tenantId,
            userId: employee.id,
            userType: 'EMPLOYEE',
            type: 'employee.welcome',
            title: `Welcome to ${tenant?.name ?? 'the team'}`,
            message: 'Your account has been created. Please log in and change your password.',
            link: '/change-password',
        }).catch(() => { });
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        void sendEmail({
            to: employee.email,
            subject: 'Your StockVero employee account is ready',
            html: employeeWelcome({
                employeeName: `${employee.firstName} ${employee.lastName}`,
                orgName: tenant?.name || 'your organization',
                email: employee.email,
                temporaryPassword,
                loginUrl: frontendUrl,
            }),
        });
        // TODO: In production, verify EMAIL_FROM domain in Resend dashboard
        void logAudit({
            tenantId: req.tenantId,
            actorType: AuditActorType.OWNER,
            actorId: req.user?.id,
            action: 'EMPLOYEE_CREATED',
            module: 'administration',
            entityType: 'Employee',
            entityId: employee.id,
            entityLabel: `${employee.firstName} ${employee.lastName}`,
            details: { email: employee.email, jobTitle: employee.jobTitle },
            ...extractRequestContext(req),
        });
        return res.status(201).json({
            success: true,
            message: 'Employee created successfully',
            data: {
                employee: await serializeEmployee(employee),
                temporaryPassword,
            },
        });
    }
    catch (error) {
        console.error('Error creating employee:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to create employee',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const updateEmployee = async (req, res) => {
    try {
        const parsed = UpdateEmployeeSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const employee = await prisma.employee.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
        });
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }
        const payload = parsed.data;
        if (payload.roleId) {
            const role = await prisma.role.findFirst({
                where: { id: payload.roleId, tenantId: req.tenantId },
            });
            if (!role) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid role',
                });
            }
        }
        if (payload.email) {
            const existingUser = await prisma.user.findUnique({ where: { email: payload.email } });
            if (existingUser) {
                return res.status(409).json({
                    success: false,
                    message: 'Email already registered',
                });
            }
            const existingEmployee = await prisma.employee.findUnique({
                where: { email: payload.email },
            });
            if (existingEmployee && existingEmployee.id !== req.params.id) {
                return res.status(409).json({
                    success: false,
                    message: 'Email already registered',
                });
            }
        }
        const updates = {};
        if (payload.firstName !== undefined)
            updates.firstName = payload.firstName.trim();
        if (payload.lastName !== undefined)
            updates.lastName = payload.lastName.trim();
        if (payload.email !== undefined)
            updates.email = payload.email.toLowerCase().trim();
        if (payload.phone !== undefined)
            updates.phone = payload.phone.trim() || null;
        if (payload.jobTitle !== undefined)
            updates.jobTitle = payload.jobTitle.trim() || null;
        if (payload.roleId !== undefined)
            updates.roleId = payload.roleId;
        if (payload.avatarUrl !== undefined) {
            updates.avatarUrl = payload.avatarUrl ? payload.avatarUrl.trim() : null;
        }
        if (typeof payload.isActive === 'boolean') {
            updates.isActive = payload.isActive;
            if (!payload.isActive && employee.isActive) {
                updates.tokenVersion = { increment: 1 };
            }
        }
        const previousAvatarUrl = employee.avatarUrl;
        const updatedEmployee = await prisma.employee.update({
            where: { id: req.params.id },
            data: updates,
            select: {
                id: true,
                tenantId: true,
                roleId: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                jobTitle: true,
                avatarUrl: true,
                isActive: true,
                mustChangePassword: true,
                tokenVersion: true,
                lastLoginAt: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        if (payload.avatarUrl !== undefined && previousAvatarUrl && previousAvatarUrl !== updatedEmployee.avatarUrl) {
            await deleteStoredFile(previousAvatarUrl);
        }
        // Notify authorized users in Administration
        await broadcastToModule(req.tenantId, 'administration', {
            type: 'administration.employee.updated',
            title: 'Employee Profile Updated',
            message: `The profile of ${updatedEmployee.firstName} ${updatedEmployee.lastName} has been updated.`,
            link: `/administration/employees/${updatedEmployee.id}`,
        });
        void logAudit({
            tenantId: req.tenantId,
            actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
            actorId: req.user?.id,
            action: 'EMPLOYEE_UPDATED',
            module: 'administration',
            entityType: 'Employee',
            entityId: updatedEmployee.id,
            entityLabel: `${updatedEmployee.firstName} ${updatedEmployee.lastName}`,
            ...extractRequestContext(req),
        });
        return res.json({
            success: true,
            message: 'Employee updated successfully',
            data: await serializeEmployee(updatedEmployee),
        });
    }
    catch (error) {
        console.error('Error updating employee:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update employee',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const updateEmployeeRole = async (req, res) => {
    try {
        const parsed = RoleSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const employee = await prisma.employee.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
        });
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }
        const role = await prisma.role.findFirst({
            where: { id: parsed.data.roleId, tenantId: req.tenantId },
        });
        if (!role) {
            return res.status(400).json({
                success: false,
                message: 'Invalid role',
            });
        }
        const updatedEmployee = await prisma.employee.update({
            where: { id: req.params.id },
            data: { roleId: parsed.data.roleId },
            select: {
                id: true,
                tenantId: true,
                roleId: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                jobTitle: true,
                avatarUrl: true,
                isActive: true,
                mustChangePassword: true,
                tokenVersion: true,
                lastLoginAt: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        // Notify authorized users in Administration
        await broadcastToModule(req.tenantId, 'administration', {
            type: 'administration.employee.role_updated',
            title: 'Employee Role Changed',
            message: `${updatedEmployee.firstName}'s role has been updated to ${role.name}.`,
            link: `/administration/employees/${updatedEmployee.id}`,
        });
        return res.json({
            success: true,
            message: 'Employee role updated successfully',
            data: updatedEmployee,
        });
    }
    catch (error) {
        console.error('Error updating employee role:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update employee role',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const updateEmployeeStatus = async (req, res) => {
    try {
        const parsed = StatusSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const employee = await prisma.employee.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
        });
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }
        const updates = { isActive: parsed.data.isActive };
        if (!parsed.data.isActive && employee.isActive) {
            updates.tokenVersion = { increment: 1 };
        }
        const updatedEmployee = await prisma.employee.update({
            where: { id: req.params.id },
            data: updates,
            select: {
                id: true,
                tenantId: true,
                roleId: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                jobTitle: true,
                avatarUrl: true,
                isActive: true,
                mustChangePassword: true,
                tokenVersion: true,
                lastLoginAt: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        // Notify authorized users in Administration
        await broadcastToModule(req.tenantId, 'administration', {
            type: 'administration.employee.status_updated',
            title: 'Employee Status Changed',
            message: `${updatedEmployee.firstName}'s account has been ${updatedEmployee.isActive ? 'activated' : 'deactivated'}.`,
            link: `/administration/employees/${updatedEmployee.id}`,
        });
        void logAudit({
            tenantId: req.tenantId,
            actorType: AuditActorType.OWNER,
            actorId: req.user?.id,
            action: updatedEmployee.isActive ? 'EMPLOYEE_REACTIVATED' : 'EMPLOYEE_DEACTIVATED',
            module: 'administration',
            entityType: 'Employee',
            entityId: updatedEmployee.id,
            entityLabel: `${updatedEmployee.firstName} ${updatedEmployee.lastName}`,
            details: { isActive: updatedEmployee.isActive },
            ...extractRequestContext(req),
        });
        return res.json({
            success: true,
            message: 'Employee status updated successfully',
            data: updatedEmployee,
        });
    }
    catch (error) {
        console.error('Error updating employee status:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update employee status',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const resetEmployeePassword = async (req, res) => {
    try {
        const employee = await prisma.employee.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
        });
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }
        const tenantSlug = await getTenantSlug(req.tenantId);
        if (!tenantSlug) {
            return res.status(404).json({
                success: false,
                message: 'Tenant not found',
            });
        }
        const temporaryPassword = generateTemporaryPassword(employee.firstName, tenantSlug);
        const passwordHash = await bcrypt.hash(temporaryPassword, 10);
        await prisma.employee.update({
            where: { id: req.params.id },
            data: {
                passwordHash,
                mustChangePassword: true,
                tokenVersion: { increment: 1 },
            },
        });
        // Notify employee of reset
        await sendNotification({
            tenantId: req.tenantId,
            userId: employee.id,
            userType: 'EMPLOYEE',
            type: 'employee.password_reset',
            title: 'Security Alert: Password Reset',
            message: 'Your account password has been reset by an administrator.',
            link: '/change-password',
        });
        void sendEmail({
            to: employee.email,
            subject: 'Your StockVero password has been reset',
            html: employeePasswordReset({
                employeeName: employee.firstName,
                temporaryPassword,
            }),
        });
        // TODO: In production, verify EMAIL_FROM domain in Resend dashboard
        void logAudit({
            tenantId: req.tenantId,
            actorType: AuditActorType.OWNER,
            actorId: req.user?.id,
            action: 'EMPLOYEE_PASSWORD_RESET',
            module: 'administration',
            entityType: 'Employee',
            entityId: employee.id,
            entityLabel: `${employee.firstName} ${employee.lastName}`,
            ...extractRequestContext(req),
        });
        return res.json({
            success: true,
            message: 'Password reset successfully',
            data: { temporaryPassword },
        });
    }
    catch (error) {
        console.error('Error resetting employee password:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to reset employee password',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const deleteEmployee = async (req, res) => {
    try {
        const employee = await prisma.employee.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
        });
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }
        await prisma.employee.update({
            where: { id: req.params.id },
            data: {
                isActive: false,
                tokenVersion: { increment: 1 },
            },
        });
        // Notify authorized users in Administration
        await broadcastToModule(req.tenantId, 'administration', {
            type: 'administration.employee.deleted',
            title: 'Employee Deactivated',
            message: `${employee.firstName} ${employee.lastName}'s account has been deactivated.`,
            link: '/administration/employees',
        });
        void logAudit({
            tenantId: req.tenantId,
            actorType: AuditActorType.OWNER,
            actorId: req.user?.id,
            action: 'EMPLOYEE_DEACTIVATED',
            module: 'administration',
            entityType: 'Employee',
            entityId: employee.id,
            entityLabel: `${employee.firstName} ${employee.lastName}`,
            ...extractRequestContext(req),
        });
        return res.json({
            success: true,
            message: 'Employee deactivated successfully',
        });
    }
    catch (error) {
        console.error('Error deleting employee:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete employee',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
