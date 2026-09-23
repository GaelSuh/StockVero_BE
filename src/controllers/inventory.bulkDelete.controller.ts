import { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AuthRequest } from '../types/index.js';
import { checkInventoryCategoriesDependencies } from '../services/dependencyCheckService.js';
import { broadcastToModule } from '../services/notificationService.js';
import { deleteStorageFiles } from '../lib/storage.js';
import { logAudit, extractRequestContext, AuditActorType } from '../services/auditService.js';

const BulkIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'Select at least one product').max(200),
});

interface BlockedEntry {
  id: string;
  name: string;
  reasons: Array<{ module: string; description: string; action: string; count: number }>;
}

/**
 * Dry run for the bulk-delete dialog: which of the selected products can go, and
 * for the rest, exactly what is holding each one back.
 */
export const bulkCheckCategories = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const parsed = BulkIdsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const categories = await (prisma as any).inventoryCategory.findMany({
      where: { tenantId, id: { in: parsed.data.ids } },
      select: { id: true, name: true },
    });
    const nameById = new Map<string, string>(
      categories.map((c: any) => [c.id, c.name as string]),
    );

    const reports = await checkInventoryCategoriesDependencies(
      categories.map((c: any) => c.id),
      tenantId,
    );

    const deletable: Array<{ id: string; name: string }> = [];
    const blocked: BlockedEntry[] = [];

    for (const [id, report] of reports) {
      const name = nameById.get(id) ?? id;
      if (report.canDelete) {
        deletable.push({ id, name });
      } else {
        blocked.push({
          id,
          name,
          reasons: report.dependencies
            .filter((dep) => !dep.isWarning)
            .map((dep) => ({
              module: dep.module,
              description: dep.description,
              action: dep.action,
              count: dep.count,
            })),
        });
      }
    }

    return res.json({
      success: true,
      message: 'Dependency check complete',
      data: {
        deletable,
        blocked,
        missing: parsed.data.ids.filter((id) => !nameById.has(id)),
      },
    });
  } catch (error) {
    console.error('Error checking categories for bulk delete:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not check these products',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Deletes the selected products that have nothing depending on them, and reports
 * back the ones it refused to touch. Anything with sales, price-list rules,
 * customer purchase history, open purchase invoices, project usage or serialised
 * units is left exactly as it was.
 */
export const bulkDeleteCategories = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const parsed = BulkIdsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const categories = await (prisma as any).inventoryCategory.findMany({
      where: { tenantId, id: { in: parsed.data.ids } },
      select: { id: true, name: true, images: true, imageUrl: true },
    });
    if (categories.length === 0) {
      return res.status(404).json({ success: false, message: 'No matching products found' });
    }

    const reports = await checkInventoryCategoriesDependencies(
      categories.map((c: any) => c.id),
      tenantId,
    );

    const deletable: any[] = [];
    const blocked: BlockedEntry[] = [];

    for (const category of categories) {
      const report = reports.get(category.id);
      if (report?.canDelete) {
        deletable.push(category);
      } else {
        blocked.push({
          id: category.id,
          name: category.name,
          reasons: (report?.dependencies ?? [])
            .filter((dep) => !dep.isWarning)
            .map((dep) => ({
              module: dep.module,
              description: dep.description,
              action: dep.action,
              count: dep.count,
            })),
        });
      }
    }

    // Re-checked inside the transaction rather than trusted from the preview:
    // a sale could have been recorded between the dialog opening and confirming.
    let deletedIds: string[] = [];
    if (deletable.length > 0) {
      deletedIds = await prisma.$transaction(async (tx) => {
        const ids = deletable.map((c) => c.id);

        // The three relations the database itself refuses to orphan. Anything
        // caught here is dropped from the batch rather than failing the whole run.
        const [soldRows, unitRows, priceRows] = await Promise.all([
          (tx as any).saleItem.findMany({
            where: { categoryId: { in: ids } },
            select: { categoryId: true },
            distinct: ['categoryId'],
          }),
          (tx as any).productItem.findMany({
            where: { categoryId: { in: ids } },
            select: { categoryId: true },
            distinct: ['categoryId'],
          }),
          (tx as any).priceRule.findMany({
            where: { categoryId: { in: ids } },
            select: { categoryId: true },
            distinct: ['categoryId'],
          }),
        ]);
        const nowBlocked = new Set<string>([
          ...soldRows.map((r: any) => r.categoryId),
          ...unitRows.map((r: any) => r.categoryId),
          ...priceRows.map((r: any) => r.categoryId),
        ]);
        const safeIds = ids.filter((id) => !nowBlocked.has(id));

        if (safeIds.length > 0) {
          // Category-owned history cascades on delete; everything else is a hard
          // dependency that the check above already refused.
          await (tx as any).inventoryCategory.deleteMany({
            where: { tenantId, id: { in: safeIds } },
          });
        }
        return safeIds;
      });

      const deletedSet = new Set(deletedIds);
      for (const category of deletable) {
        if (!deletedSet.has(category.id)) {
          blocked.push({
            id: category.id,
            name: category.name,
            reasons: [
              {
                module: 'Inventory',
                description: 'Something started using this product while you were confirming',
                action: 'Refresh the list and try again',
                count: 1,
              },
            ],
          });
        }
      }

      // Storage cleanup for what actually went (fire-and-forget).
      const images = deletable
        .filter((c) => deletedSet.has(c.id))
        .flatMap((c) => [...(Array.isArray(c.images) ? c.images : []), c.imageUrl])
        .filter(Boolean) as string[];
      if (images.length) deleteStorageFiles([...new Set(images)]).catch(() => {});

      for (const category of deletable.filter((c) => deletedSet.has(c.id))) {
        void logAudit({
          tenantId,
          actorType:
            req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
          actorId: req.user?.id,
          action: 'PRODUCT_DELETED',
          module: 'inventory',
          entityType: 'InventoryCategory',
          entityId: category.id,
          entityLabel: category.name,
          details: { bulk: true },
          ...extractRequestContext(req),
        });
      }

      if (deletedIds.length > 0) {
        broadcastToModule(tenantId, 'inventory', {
          type: 'inventory.category.deleted',
          title: 'Products deleted',
          message: `${deletedIds.length} product${deletedIds.length === 1 ? '' : 's'} removed from inventory.`,
          link: '/inventory/categories',
        }).catch((err: any) => console.error('[notify] bulk delete:', err));
      }
    }

    return res.json({
      success: true,
      message:
        deletedIds.length > 0
          ? `${deletedIds.length} product${deletedIds.length === 1 ? '' : 's'} deleted`
          : 'Nothing was deleted',
      data: {
        deleted: deletedIds.length,
        deletedIds,
        blocked,
      },
    });
  } catch (error) {
    console.error('Error bulk deleting categories:', error);
    return res.status(500).json({
      success: false,
      message: 'Delete failed. Nothing was removed, so you can safely try again.',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
