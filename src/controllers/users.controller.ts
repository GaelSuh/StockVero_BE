import { Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '../db.js';
import { AuthRequest, Permission } from '../types/index.js';
import { generateToken } from '../lib/jwt.js';
import { OWNER_PERMANENT_MODULES } from '../config/modules.js';
import { resolveSignedUrl, deleteStoredFile } from '../lib/storage.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const UpdateProfileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

const UpdatePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const UpdatePreferencesSchema = z.object({
  themeConfig: z.record(z.string(), z.unknown()).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the `permissions` + `activeModules` for an employee JWT. */
function buildPermissions(rolePermissions: { moduleKey: string; canRead: boolean; canCreate: boolean; canUpdate: boolean; canDelete: boolean }[], enabledModules: string[]) {
  const permissions: Record<string, Permission> = {};
  const activeModules: string[] = [];
  for (const perm of rolePermissions) {
    if (!enabledModules.includes(perm.moduleKey)) continue;
    if (!perm.canRead) continue;
    permissions[perm.moduleKey] = {
      canRead: Boolean(perm.canRead),
      canCreate: Boolean(perm.canCreate),
      canUpdate: Boolean(perm.canUpdate),
      canDelete: Boolean(perm.canDelete),
    };
    activeModules.push(perm.moduleKey);
  }
  return { permissions, activeModules };
}

// ---------------------------------------------------------------------------
// GET /api/v1/users/me/profile
// ---------------------------------------------------------------------------

export const getMyProfile = async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.accountType === 'owner') {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatarUrl: true },
      });
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      return res.json({
        success: true,
        data: { ...user, avatarUrl: await resolveSignedUrl(user.avatarUrl) },
      });
    }

    const employee = await prisma.employee.findUnique({
      where: { id: req.user!.id },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatarUrl: true, jobTitle: true },
    });
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });
    return res.json({
      success: true,
      data: { ...employee, avatarUrl: await resolveSignedUrl(employee.avatarUrl) },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to retrieve profile', error: error instanceof Error ? error.message : 'Unknown error' });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/v1/users/me/profile
// ---------------------------------------------------------------------------

export const updateMyProfile = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = UpdateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    const { firstName, lastName, phone, avatarUrl } = parsed.data;
    const updates: Record<string, unknown> = {};
    if (firstName !== undefined) updates.firstName = firstName;
    if (lastName !== undefined) updates.lastName = lastName;
    if (phone !== undefined) updates.phone = phone || null;

    if (req.user?.accountType === 'owner') {
      const current = await prisma.user.findUnique({ where: { id: req.user.id }, select: { avatarUrl: true } });
      if (avatarUrl !== undefined) {
        updates.avatarUrl = avatarUrl;
        if (current?.avatarUrl && current.avatarUrl !== avatarUrl) {
          await deleteStoredFile(current.avatarUrl).catch(() => undefined);
        }
      }
      const updated = await prisma.user.update({
        where: { id: req.user.id },
        data: updates,
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatarUrl: true },
      });
      return res.json({ success: true, data: { ...updated, avatarUrl: await resolveSignedUrl(updated.avatarUrl) } });
    }

    const current = await prisma.employee.findUnique({ where: { id: req.user!.id }, select: { avatarUrl: true } });
    if (avatarUrl !== undefined) {
      updates.avatarUrl = avatarUrl;
      if (current?.avatarUrl && current.avatarUrl !== avatarUrl) {
        await deleteStoredFile(current.avatarUrl).catch(() => undefined);
      }
    }
    const updated = await prisma.employee.update({
      where: { id: req.user!.id },
      data: updates,
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatarUrl: true, jobTitle: true },
    });
    return res.json({ success: true, data: { ...updated, avatarUrl: await resolveSignedUrl(updated.avatarUrl) } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update profile', error: error instanceof Error ? error.message : 'Unknown error' });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/v1/users/me/password
// ---------------------------------------------------------------------------

export const updateMyPassword = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = UpdatePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    const { currentPassword, newPassword } = parsed.data;

    if (req.user?.accountType === 'owner') {
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return res.status(401).json({ success: false, message: 'Current password is incorrect' });

      const passwordHash = await bcrypt.hash(newPassword, 10);
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, tokenVersion: { increment: 1 } },
        include: { tenant: { include: { modules: true } } },
      });

      const activeModules = Array.from(new Set([...OWNER_PERMANENT_MODULES, ...updated.tenant.modules.filter(m => m.isEnabled).map(m => m.moduleKey)]));
      const token = generateToken({
        userId: updated.id,
        tenantId: updated.tenantId,
        tenantSlug: updated.tenant.subdomain,
        role: updated.role,
        accountType: 'owner',
        active_modules: activeModules,
        tokenVersion: updated.tokenVersion,
      });
      return res.json({ success: true, message: 'Password updated successfully', data: { token } });
    }

    // employee
    const employee = await prisma.employee.findUnique({
      where: { id: req.user!.id },
      include: { tenant: { include: { modules: true } }, role: { include: { permissions: true } } },
    });
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    const valid = await bcrypt.compare(currentPassword, employee.passwordHash);
    if (!valid) return res.status(401).json({ success: false, message: 'Current password is incorrect' });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updated = await prisma.employee.update({
      where: { id: employee.id },
      data: { passwordHash, mustChangePassword: false, tokenVersion: { increment: 1 } },
    });

    const enabledModules = Array.from(new Set([...OWNER_PERMANENT_MODULES, ...employee.tenant.modules.filter(m => m.isEnabled).map(m => m.moduleKey)]));
    const { activeModules, permissions } = buildPermissions(employee.role.permissions, enabledModules);

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
    return res.json({ success: true, message: 'Password updated successfully', data: { token } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update password', error: error instanceof Error ? error.message : 'Unknown error' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/users/me/preferences
// ---------------------------------------------------------------------------

export const getMyPreferences = async (req: AuthRequest, res: Response) => {
  try {
    const pref = await prisma.userPreference.findUnique({
      where: { tenantId_userId: { tenantId: req.tenantId!, userId: req.user!.id } },
      select: { themeConfig: true },
    });
    return res.json({ success: true, data: { themeConfig: pref?.themeConfig ?? null } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to retrieve preferences', error: error instanceof Error ? error.message : 'Unknown error' });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/v1/users/me/preferences
// ---------------------------------------------------------------------------

export const updateMyPreferences = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = UpdatePreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    const { themeConfig } = parsed.data;
    const userType = req.user?.accountType === 'owner' ? 'OWNER' : 'EMPLOYEE';

    const pref = await prisma.userPreference.upsert({
      where: { tenantId_userId: { tenantId: req.tenantId!, userId: req.user!.id } },
      create: {
        tenantId: req.tenantId!,
        userId: req.user!.id,
        userType,
        themeConfig: themeConfig ?? null,
      },
      update: {
        themeConfig: themeConfig ?? null,
      },
    });

    return res.json({ success: true, data: { themeConfig: pref.themeConfig } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update preferences', error: error instanceof Error ? error.message : 'Unknown error' });
  }
};
