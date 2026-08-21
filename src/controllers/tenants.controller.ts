import { Response } from 'express';
import { ORGANIZATION_TYPES, INDUSTRIES } from '../config/industries.js';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { resolveSignedUrl, deleteStoredFile } from '../lib/storage.js';
import { broadcastToModule } from '../services/notificationService.js';
import { logAudit, extractRequestContext, AuditActorType } from '../services/auditService.js';
import { readTenantSettings } from '../lib/tenantSettings.js';

const UpdateModuleSchema = z.object({
  isEnabled: z.boolean(),
});

export const getTenantModules = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.params.id;
    if (req.user?.role !== 'SUPER_ADMIN' && req.tenantId !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    const modules = await prisma.tenantModule.findMany({
      where: { tenantId },
      include: { module: true },
      orderBy: { moduleKey: 'asc' },
    });

    return res.json({
      success: true,
      message: 'Tenant modules retrieved successfully',
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

const UpdateTenantMeSchema = z.object({
  name: z.string().min(1).optional(),
  industry: z.string().optional(),
  /** Business type. Drives suggested modules; never restricts them. */
  organizationType: z.enum(ORGANIZATION_TYPES as [string, ...string[]]).optional(),
  website: z.string().optional(),
  logoUrl: z.string().nullable().optional(),
  /** Owner-controlled: put stock purchases in front of finance before units land. */
  stockApprovalRequired: z.boolean().optional(),
});

export const updateMyTenant = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = UpdateTenantMeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const { name, industry, organizationType, website, logoUrl, stockApprovalRequired } = parsed.data;
    const updates: Record<string, any> = {};

    // Merged rather than replaced — settingsConfig is a shared bag and other
    // keys will land in it later.
    if (stockApprovalRequired !== undefined) {
      const current = await prisma.tenant.findUnique({
        where: { id: req.tenantId! },
        select: { settingsConfig: true },
      });
      updates.settingsConfig = {
        ...(readTenantSettings(current) as Record<string, unknown>),
        stockApprovalRequired,
      };
    }
    if (name !== undefined) updates.name = name;
    if (industry !== undefined) updates.industry = industry || null;
    if (organizationType !== undefined) updates.organizationType = organizationType;
    if (website !== undefined) updates.website = website || null;
    if (logoUrl !== undefined) updates.logoUrl = logoUrl;

    if (logoUrl !== undefined) {
      const current = await prisma.tenant.findUnique({
        where: { id: req.tenantId! },
        select: { logoUrl: true },
      });
      if (current?.logoUrl && current.logoUrl !== logoUrl) {
        await deleteStoredFile(current.logoUrl);
      }
    }

    const updated = await prisma.tenant.update({
      where: { id: req.tenantId! },
      data: updates,
      // organizationType is selected back deliberately: it was being written and
      // then omitted from the response, so the client could not tell whether the
      // change had taken.
      select: {
        id: true,
        name: true,
        industry: true,
        organizationType: true,
        website: true,
        logoUrl: true,
        settingsConfig: true,
      },
    });

    // Notify authorized users
    await broadcastToModule(req.tenantId!, 'settings', {
      type: 'tenant.details.updated',
      title: 'Company Profile Updated',
      message: 'The organization profile details have been updated.',
      link: '/settings',
    });

    const logoUrlSigned = await resolveSignedUrl(updated.logoUrl);

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'employee' ? AuditActorType.EMPLOYEE : AuditActorType.OWNER,
      actorId: req.user?.id,
      action: 'COMPANY_UPDATED',
      module: 'settings',
      entityType: 'Tenant',
      entityId: req.tenantId!,
      details: { name: updated.name, industry: updated.industry, website: updated.website },
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Company details updated',
      data: { ...updated, logoUrl: logoUrlSigned },
    });
  } catch (error) {
    console.error('Error updating tenant:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update company details',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

const UpdateTenantThemeSchema = z.object({
  mode: z.enum(['light', 'dark']).optional(),
  themeKey: z.string().optional(),
  primaryColor: z.string().optional(),
  accentColor: z.string().optional(),
  customTokens: z.record(z.string(), z.string()).optional(),
});

export const updateMyTenantTheme = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = UpdateTenantThemeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const current = await prisma.tenant.findUnique({
      where: { id: req.tenantId! },
      select: { themeConfig: true },
    });

    const existing = (current?.themeConfig as Record<string, unknown>) ?? {};
    const merged = { ...existing, ...parsed.data };

    const updated = await prisma.tenant.update({
      where: { id: req.tenantId! },
      data: { themeConfig: merged },
      select: { id: true, themeConfig: true },
    });

    // Notify authorized users
    await broadcastToModule(req.tenantId!, 'settings', {
      type: 'tenant.theme.updated',
      title: 'Visual Theme Updated',
      message: 'The organization visual theme configuration has been updated.',
      link: '/settings',
    });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'employee' ? AuditActorType.EMPLOYEE : AuditActorType.OWNER,
      actorId: req.user?.id,
      action: 'THEME_CHANGED',
      module: 'settings',
      entityType: 'Tenant',
      entityId: req.tenantId!,
      details: { newTheme: merged },
      ...extractRequestContext(req),
    });

    return res.json({ success: true, message: 'Theme updated', data: updated });
  } catch (error) {
    console.error('Error updating tenant theme:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update theme',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateTenantModule = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.params.id;
    if (req.user?.role !== 'SUPER_ADMIN' && req.tenantId !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    const parsed = UpdateModuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const moduleExists = await prisma.module.findUnique({
      where: { key: req.params.key },
    });
    if (!moduleExists) {
      return res.status(404).json({
        success: false,
        message: 'Module not found',
      });
    }

    // upsert, not update: a module the tenant never selected at signup has no
    // row at all, so switching it on later failed with a record-not-found error
    // rather than enabling anything.
    //
    // Disabling only flips the flag. Nothing is deleted — the module disappears
    // from the menu and its routes are refused, and switching it back on brings
    // everything with it.
    const updated = await prisma.tenantModule.upsert({
      where: { tenantId_moduleKey: { tenantId, moduleKey: req.params.key } },
      update: {
        isEnabled: parsed.data.isEnabled,
        enabledAt: parsed.data.isEnabled ? new Date() : undefined,
        disabledAt: parsed.data.isEnabled ? null : new Date(),
      },
      create: {
        tenantId,
        moduleKey: req.params.key,
        isEnabled: parsed.data.isEnabled,
        enabledAt: parsed.data.isEnabled ? new Date() : undefined,
        disabledAt: parsed.data.isEnabled ? undefined : new Date(),
      },
    });

    // Notify authorized users
    await broadcastToModule(tenantId, 'administration', {
      type: 'tenant.module.updated',
      title: 'Module Access Changed',
      message: `The ${req.params.key} module has been ${parsed.data.isEnabled ? 'enabled' : 'disabled'} for your organization.`,
      link: '/admin',
    });

    return res.json({
      success: true,
      message: 'Tenant module updated successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Error updating tenant module:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update tenant module',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * The business types on offer, with the modules each suggests.
 *
 * Served rather than duplicated as a constant in the client so the two cannot
 * drift: this file decides what may be stored, so it should also decide what is
 * offered.
 */
export const listIndustries = async (_req: AuthRequest, res: Response) => {
  return res.json({ success: true, data: INDUSTRIES });
};
