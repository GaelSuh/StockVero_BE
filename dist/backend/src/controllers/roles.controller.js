import { z } from 'zod';
import { prisma } from '../db.js';
import { broadcastToModule } from '../services/notificationService.js';
import { logAudit, extractRequestContext, AuditActorType } from '../services/auditService.js';
const PermissionSchema = z.object({
    moduleKey: z.string().min(1),
    canRead: z.boolean(),
    canCreate: z.boolean(),
    canUpdate: z.boolean(),
    canDelete: z.boolean(),
});
const RoleSchema = z.object({
    name: z.string().min(1),
    abbreviation: z.string().min(1).max(8),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
    isAdmin: z.boolean().optional(),
    permissions: z.array(PermissionSchema),
});
async function getEnabledModuleKeys(tenantId) {
    const modules = await prisma.tenantModule.findMany({
        where: { tenantId, isEnabled: true },
        select: { moduleKey: true },
    });
    return modules.map(m => m.moduleKey);
}
function validatePermissions(permissions, enabledModules) {
    for (const perm of permissions) {
        if (!enabledModules.includes(perm.moduleKey)) {
            return `Module ${perm.moduleKey} is not enabled for this tenant`;
        }
        if (!perm.canRead && (perm.canCreate || perm.canUpdate || perm.canDelete)) {
            return `Permission rule violation: canRead must be true when create/update/delete is enabled for ${perm.moduleKey}`;
        }
    }
    return null;
}
export const listRoles = async (req, res) => {
    try {
        const roles = await prisma.role.findMany({
            where: { tenantId: req.tenantId },
            include: {
                permissions: true,
                _count: { select: { employees: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
        const data = roles.map(role => ({
            ...role,
            employeeCount: role._count.employees,
        }));
        return res.json({
            success: true,
            message: 'Roles retrieved successfully',
            data,
        });
    }
    catch (error) {
        console.error('Error listing roles:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve roles',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const getRole = async (req, res) => {
    try {
        const role = await prisma.role.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
            include: {
                permissions: true,
                employees: { select: { id: true, firstName: true, lastName: true } },
            },
        });
        if (!role) {
            return res.status(404).json({
                success: false,
                message: 'Role not found',
            });
        }
        return res.json({
            success: true,
            message: 'Role retrieved successfully',
            data: role,
        });
    }
    catch (error) {
        console.error('Error fetching role:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve role',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const createRole = async (req, res) => {
    try {
        const parsed = RoleSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const payload = parsed.data;
        const existing = await prisma.role.findFirst({
            where: {
                tenantId: req.tenantId,
                OR: [{ name: payload.name }, { abbreviation: payload.abbreviation.toUpperCase() }],
            },
        });
        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'Role name or abbreviation already exists',
            });
        }
        const enabledModules = await getEnabledModuleKeys(req.tenantId);
        const validationError = validatePermissions(payload.permissions, enabledModules);
        if (validationError) {
            return res.status(400).json({
                success: false,
                message: validationError,
            });
        }
        const role = await prisma.$transaction(async (tx) => {
            if (payload.isDefault) {
                await tx.role.updateMany({
                    where: { tenantId: req.tenantId, isDefault: true },
                    data: { isDefault: false },
                });
            }
            return tx.role.create({
                data: {
                    tenantId: req.tenantId,
                    name: payload.name.trim(),
                    abbreviation: payload.abbreviation.toUpperCase().trim(),
                    description: payload.description?.trim() || null,
                    isDefault: payload.isDefault ?? false,
                    isAdmin: payload.isAdmin ?? false,
                    permissions: {
                        create: payload.permissions.map((perm) => ({
                            moduleKey: perm.moduleKey,
                            canRead: perm.canRead,
                            canCreate: perm.canCreate,
                            canUpdate: perm.canUpdate,
                            canDelete: perm.canDelete,
                        })),
                    },
                },
                include: { permissions: true },
            });
        });
        // Notify authorized users in Administration
        await broadcastToModule(req.tenantId, 'administration', {
            type: 'administration.role.created',
            title: 'New Role Created',
            message: `A new role "${role.name}" (${role.abbreviation}) has been added.`,
            link: '/administration/roles',
        });
        void logAudit({
            tenantId: req.tenantId,
            actorType: AuditActorType.OWNER,
            actorId: req.user?.id,
            action: 'ROLE_CREATED',
            module: 'administration',
            entityType: 'Role',
            entityId: role.id,
            entityLabel: role.name,
            ...extractRequestContext(req),
        });
        return res.status(201).json({
            success: true,
            message: 'Role created successfully',
            data: role,
        });
    }
    catch (error) {
        console.error('Error creating role:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to create role',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const updateRole = async (req, res) => {
    try {
        const parsed = RoleSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const existingRole = await prisma.role.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
        });
        if (!existingRole) {
            return res.status(404).json({
                success: false,
                message: 'Role not found',
            });
        }
        const duplicate = await prisma.role.findFirst({
            where: {
                tenantId: req.tenantId,
                OR: [{ name: parsed.data.name }, { abbreviation: parsed.data.abbreviation.toUpperCase() }],
                NOT: { id: req.params.id },
            },
        });
        if (duplicate) {
            return res.status(409).json({
                success: false,
                message: 'Role name or abbreviation already exists',
            });
        }
        const enabledModules = await getEnabledModuleKeys(req.tenantId);
        const validationError = validatePermissions(parsed.data.permissions, enabledModules);
        if (validationError) {
            return res.status(400).json({
                success: false,
                message: validationError,
            });
        }
        const role = await prisma.$transaction(async (tx) => {
            const nextIsDefault = parsed.data.isDefault ?? existingRole.isDefault;
            if (nextIsDefault) {
                await tx.role.updateMany({
                    where: { tenantId: req.tenantId, isDefault: true },
                    data: { isDefault: false },
                });
            }
            await tx.role.update({
                where: { id: req.params.id },
                data: {
                    name: parsed.data.name.trim(),
                    abbreviation: parsed.data.abbreviation.toUpperCase().trim(),
                    description: parsed.data.description?.trim() || null,
                    isDefault: nextIsDefault,
                    isAdmin: parsed.data.isAdmin ?? existingRole.isAdmin,
                },
            });
            await tx.rolePermission.deleteMany({ where: { roleId: req.params.id } });
            if (parsed.data.permissions.length > 0) {
                await tx.rolePermission.createMany({
                    data: parsed.data.permissions.map((perm) => ({
                        roleId: req.params.id,
                        moduleKey: perm.moduleKey,
                        canRead: perm.canRead,
                        canCreate: perm.canCreate,
                        canUpdate: perm.canUpdate,
                        canDelete: perm.canDelete,
                    })),
                });
            }
            return tx.role.findUnique({
                where: { id: req.params.id },
                include: { permissions: true },
            });
        });
        // Notify authorized users in Administration
        await broadcastToModule(req.tenantId, 'administration', {
            type: 'administration.role.updated',
            title: 'Role Updated',
            message: `The permissions for role "${role?.name}" have been updated.`,
            link: '/administration/roles',
        });
        void logAudit({
            tenantId: req.tenantId,
            actorType: AuditActorType.OWNER,
            actorId: req.user?.id,
            action: 'ROLE_UPDATED',
            module: 'administration',
            entityType: 'Role',
            entityId: role?.id,
            entityLabel: role?.name,
            ...extractRequestContext(req),
        });
        return res.json({
            success: true,
            message: 'Role updated successfully',
            data: role,
        });
    }
    catch (error) {
        console.error('Error updating role:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update role',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const deleteRole = async (req, res) => {
    try {
        const role = await prisma.role.findFirst({
            where: { id: req.params.id, tenantId: req.tenantId },
        });
        if (!role) {
            return res.status(404).json({
                success: false,
                message: 'Role not found',
            });
        }
        const employeeCount = await prisma.employee.count({
            where: { tenantId: req.tenantId, roleId: req.params.id },
        });
        if (employeeCount > 0) {
            return res.status(400).json({
                message: `Cannot delete role. ${employeeCount} employee(s) are currently assigned to this role.`,
            });
        }
        await prisma.role.delete({ where: { id: req.params.id } });
        // Notify authorized users in Administration
        await broadcastToModule(req.tenantId, 'administration', {
            type: 'administration.role.deleted',
            title: 'Role Deleted',
            message: `The role "${role.name}" has been removed.`,
            link: '/administration/roles',
        });
        void logAudit({
            tenantId: req.tenantId,
            actorType: AuditActorType.OWNER,
            actorId: req.user?.id,
            action: 'ROLE_DELETED',
            module: 'administration',
            entityType: 'Role',
            entityId: role.id,
            entityLabel: role.name,
            ...extractRequestContext(req),
        });
        return res.json({
            success: true,
            message: 'Role deleted successfully',
        });
    }
    catch (error) {
        console.error('Error deleting role:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete role',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
