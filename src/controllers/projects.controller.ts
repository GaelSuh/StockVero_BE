import { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ApiError } from '../lib/errors.js';
import { AuthRequest } from '../types/index.js';
import { createProjectInvoice } from '../services/invoiceService.js';
import { sendNotification, broadcastToModule } from '../services/notificationService.js';
import { getProjectAccessRecipients } from '../utils/projectRecipients.js';
import { checkSufficientFunds, recordExpense, reverseExpense } from '../services/balanceService.js';
import { logAudit, extractRequestContext, buildDiff, AuditActorType } from '../services/auditService.js';

async function getExistingPendingEntry(
  tenantId: string,
  sourceType: string,
  sourceId: string,
  transactionType: string,
) {
  return prisma.financeValidationQueue.findFirst({
    where: {
      tenantId,
      sourceType,
      sourceId,
      transactionType,
      status: 'PENDING',
    },
  });
}

const ProjectSchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'TESTING', 'COMPLETED', 'CANCELLED']).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  budget: z.number().nonnegative().optional(),
  technician: z.string().optional(),
  startDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
});

const MilestoneSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['PENDING', 'ACTIVE', 'COMPLETED', 'SKIPPED']).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  notes: z.string().optional(),
  sortOrder: z.number().int().optional(),
});

const MaterialSchema = z.object({
  productId: z.string().uuid().optional(),
  itemSku: z.string().optional(),
  categoryId: z.string().optional(),
  itemId: z.string().optional(), // specific product item to assign
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitCost: z.number().positive().optional(),
  notes: z.string().optional(),
  includeCostInProject: z.boolean().optional(), // required when path is INVENTORY
});

function toDate(value?: string) {
  return value ? new Date(value) : undefined;
}

const getProjectBudgetLimit = (project: { availableBudget?: unknown; budget?: unknown }) => {
  const availableBudget = Number((project as any).availableBudget ?? 0);
  if (availableBudget > 0) return availableBudget;
  return Number((project as any).budget ?? 0);
};

const getProjectSpentAmount = (project: { spentAmount?: unknown; spent?: unknown }) => Math.max(
  Number((project as any).spentAmount ?? 0),
  Number((project as any).spent ?? 0),
);

const toDateOnly = (value?: Date | string | null) => {
  if (!value) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

const validateMilestoneDates = (
  project: { startDate: Date | null; dueDate: Date | null },
  startDate?: string,
  endDate?: string,
) => {
  const projectStart = toDateOnly(project.startDate);
  const projectEnd = toDateOnly(project.dueDate);
  const phaseStart = startDate ? startDate.slice(0, 10) : null;
  const phaseEnd = endDate ? endDate.slice(0, 10) : null;

  if (phaseStart && projectStart && phaseStart < projectStart) {
    return 'Phase start date must be on or after the project start date';
  }
  if (phaseEnd && projectEnd && phaseEnd > projectEnd) {
    return 'Phase end date must be on or before the project due date';
  }
  if (phaseStart && phaseEnd && phaseStart > phaseEnd) {
    return 'Phase end date must be on or after the phase start date';
  }
  return null;
};

const computeProgressFromMilestones = (milestones: Array<{ status: string }>) => {
  const total = milestones.length;
  if (total === 0) return { total, completed: 0, progress: 0, allPhasesComplete: true };
  // Both COMPLETED and SKIPPED count as done — skipped work was intentionally bypassed
  const completed = milestones.filter((m) => m.status === 'COMPLETED' || m.status === 'SKIPPED').length;
  const progress = Math.round((completed / total) * 100);
  const allPhasesComplete = completed === total;
  return { total, completed, progress, allPhasesComplete };
};

const deriveStatusFromMilestones = (currentStatus: string, milestones: Array<{ status: string }>) => {
  // Locked terminal states — never auto-override
  if (currentStatus === 'CANCELLED') return currentStatus;
  const { total, completed } = computeProgressFromMilestones(milestones);
  if (total === 0) return currentStatus;
  // All phases done → project is complete regardless of current status
  if (completed >= total) return 'COMPLETED';
  // Phases still in progress — preserve whatever status the user has set (PENDING, TESTING, IN_PROGRESS, etc.)
  // Only revert from COMPLETED back to IN_PROGRESS if phases somehow became incomplete
  return currentStatus === 'COMPLETED' ? 'IN_PROGRESS' : currentStatus;
};

const applyOverdueStatus = (status: string, dueDate?: Date | null) => {
  if (status === 'COMPLETED' || status === 'CANCELLED') return status;
  if (dueDate && dueDate.getTime() < Date.now()) return 'OVERDUE';
  return status;
};

const resolveInventoryStatus = (quantity: number, lowStockAt: number) => {
  if (quantity <= 0) return 'OUT_OF_STOCK';
  if (quantity <= lowStockAt) return 'LOW_STOCK';
  return 'IN_STOCK';
};

// Shared helper: auto-return all INVENTORY-type materials on a project when it reaches
// COMPLETED or CANCELLED. Sets items AVAILABLE, stamps returnedAt/returnNote on materials,
// creates maintenance log entries, and notifies inventory users.
const autoReturnProjectInventory = async (
  tenantId: string,
  projectId: string,
  projectName: string,
  newStatus: 'COMPLETED' | 'CANCELLED',
) => {
  try {
    const inventoryMaterials = await (prisma as any).projectMaterial.findMany({
      where: { projectId, sourceType: 'INVENTORY' },
    });

    const itemIds: string[] = inventoryMaterials.flatMap((m: any) => m.assignedItemIds as string[]);
    if (itemIds.length === 0) return;

    await (prisma as any).productItem.updateMany({
      where: { id: { in: itemIds } },
      data: { inventoryStatus: 'AVAILABLE', projectId: null, projectMaterialId: null },
    });

    const statusLabel = newStatus === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED';
    const returnNoteText = `Returned automatically when project was marked ${statusLabel}`;

    await (prisma as any).productItemMaintenanceLog.createMany({
      data: itemIds.map((itemId: string) => ({
        tenantId,
        productItemId: itemId,
        performedBy: 'system',
        statusBefore: 'IN_USE',
        statusAfter: 'AVAILABLE',
        title: `Auto-returned \u2014 project ${statusLabel}`,
        notes: `Project '${projectName}' was marked as ${statusLabel}. Inventory item automatically returned to Available. Please confirm physical return.`,
      })),
    });

    for (const mat of inventoryMaterials) {
      if ((mat.assignedItemIds as string[]).length > 0) {
        await (prisma as any).projectMaterial.update({
          where: { id: mat.id },
          data: { returnedAt: new Date(), returnNote: returnNoteText },
        });
      }
    }

    const [inventoryUsers, owner] = await Promise.all([
      prisma.employee.findMany({
        where: {
          tenantId,
          isActive: true,
          role: { permissions: { some: { moduleKey: 'inventory', canRead: true } } },
        },
        select: { id: true },
      }),
      prisma.user.findFirst({
        where: { tenantId, role: 'CLIENT_OWNER' as any },
        select: { id: true },
      }),
    ]);

    const allUserIds = [
      ...inventoryUsers.map((e) => ({ id: e.id, type: 'EMPLOYEE' as const })),
      ...(owner ? [{ id: owner.id, type: 'OWNER' as const }] : []),
    ];

    for (const user of allUserIds) {
      await sendNotification({
        tenantId,
        userId: user.id,
        userType: user.type,
        type: 'inventory.items.returned',
        title: 'Inventory Items Returned',
        message: `Inventory items from project '${projectName}' have been automatically returned to Available. Please confirm physical return.`,
        link: `/inventory?tab=inventory`,
      });
    }
  } catch (err) {
    console.error('[autoReturn] Error auto-returning inventory items:', err);
  }
};

const updateProjectProgressAndStatus = async (tenantId: string, projectId: string) => {
  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId },
    select: { id: true, name: true, status: true, dueDate: true, completedAt: true, progress: true },
  });
  if (!project) return null;

  // CANCELLED is a terminal state — never auto-derive or overwrite it
  if (project.status === 'CANCELLED') {
    return {
      progress: project.progress,
      status: 'CANCELLED',
      project,
    };
  }

  const milestones = await prisma.projectMilestone.findMany({
    where: { projectId, tenantId },
    select: { status: true },
  });

  const { progress } = computeProgressFromMilestones(milestones);
  const nextStatus = deriveStatusFromMilestones(project.status, milestones);
  const completedAt = nextStatus === 'COMPLETED' ? project.completedAt ?? new Date() : null;

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: {
      progress,
      status: nextStatus as any,
      completedAt,
      // Lock when all phases done; unlock if phases are edited back to incomplete
      isLocked: nextStatus === 'COMPLETED' ? true : false,
    },
  });

  // Auto-return inventory items when the project auto-completes
  if (nextStatus === 'COMPLETED') {
    await autoReturnProjectInventory(tenantId, projectId, project.name, 'COMPLETED');
  }

  // When a previously-completed project transitions back to active (e.g. a phase was re-opened),
  // clear the "Returned" notes on materials so the UI reflects the active state again
  if (project.status === 'COMPLETED' && nextStatus !== 'COMPLETED') {
    try {
      await (prisma as any).projectMaterial.updateMany({
        where: { projectId },
        data: { returnedAt: null, returnNote: null },
      });
    } catch (err) {
      console.error('[reopen] Error clearing material return fields:', err);
    }
  }

  return {
    progress,
    status: applyOverdueStatus(updated.status as any, updated.dueDate),
    project: updated,
  };
};

// Reusable function: recomputes project progress from phase statuses and persists it.
// Returns { progress, allPhasesComplete } for use in guards (e.g. COMPLETED status check).
const recalculateProjectProgress = async (projectId: string, tenantId: string) => {
  const milestones = await prisma.projectMilestone.findMany({
    where: { projectId, tenantId },
    select: { status: true },
  });

  const total = milestones.length;
  const done = milestones.filter((p) =>
    p.status === 'COMPLETED' || p.status === 'SKIPPED',
  ).length;

  const progress = total === 0 ? 0 : Math.round((done / total) * 100);
  const allPhasesComplete = total === 0 || done === total;

  await prisma.project.update({
    where: { id: projectId },
    data: { progress },
  });

  return { progress, allPhasesComplete };
};

export const createProject = async (req: AuthRequest, res: Response) => {
  try {
    const Schema = ProjectSchema.extend({
      milestones: z.array(MilestoneSchema).optional(),
      materials: z.array(MaterialSchema).optional(),
    });

    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const payload = parsed.data;

    // Server-side guard: COMPLETED can only be set automatically via all phases completing
    if (payload.status === 'COMPLETED') {
      return res.status(400).json({
        success: false,
        message: 'Project cannot be manually set to Completed. All phases must be completed for the project to reach Completed status automatically.',
      });
    }

    // At least one phase is required
    if (!payload.milestones || payload.milestones.length === 0) {
      return res.status(422).json({
        success: false,
        message: 'At least one project phase is required when creating a project.',
      });
    }

    let customerName: string | null = null;
    if (payload.customerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: payload.customerId, tenantId: req.tenantId! },
      });
      if (!customer) {
        return res.status(400).json({
          success: false,
          message: 'Customer not found',
        });
      }
      customerName = customer.name;
    }

    let totalSpent = 0;
    if (payload.materials) {
      for (const mat of payload.materials) {
        totalSpent += mat.quantity * (mat.unitCost ?? 0);
      }
    }

    if (payload.startDate || payload.dueDate) {
      for (const milestone of payload.milestones || []) {
        const message = validateMilestoneDates(
          { startDate: toDate(payload.startDate) ?? null, dueDate: toDate(payload.dueDate) ?? null },
          milestone.startDate,
          milestone.endDate,
        );
        if (message) {
          return res.status(400).json({
            success: false,
            message,
          });
        }
      }
    }

    const project = await prisma.project.create({
      data: {
        tenantId: req.tenantId!,
        customerId: payload.customerId,
        name: payload.name,
        description: payload.description,
        status: (payload.status as any) || 'PENDING',
        progress: payload.progress || 0,
        budget: payload.budget as any,
        spent: totalSpent as any,
        technician: payload.technician,
        startDate: toDate(payload.startDate),
        dueDate: toDate(payload.dueDate),
        milestones: {
          create: (payload.milestones || []).map((m, i) => ({
            tenantId: req.tenantId!,
            name: m.name,
            status: (m.status as any) || 'PENDING',
            progress: m.progress || 0,
            startDate: toDate(m.startDate),
            endDate: toDate(m.endDate),
            notes: m.notes,
            sortOrder: m.sortOrder ?? i,
          })),
        },
        materials: {
          create: (payload.materials || []).map(m => ({
            tenantId: req.tenantId!,
            productId: m.productId,
            itemSku: m.itemSku ? m.itemSku.toUpperCase() : undefined,
            name: m.name,
            quantity: m.quantity,
            unitCost: (m.unitCost ?? 0) as any,
            totalCost: (m.quantity * (m.unitCost ?? 0)) as any,
            notes: m.notes,
          })),
        },
      },
      include: { milestones: true, materials: true },
    });

    const recalculated = await updateProjectProgressAndStatus(req.tenantId!, project.id);
    const responseProject = {
      ...project,
      progress: recalculated?.progress ?? project.progress,
      status: recalculated?.status ?? project.status,
    };

    const budgetValue = project.budget !== null && project.budget !== undefined
      ? Number(project.budget)
      : null;
    const submittedBy = req.user?.id;

    // Create project invoice for budget approval
    let projectInvoice = null;
    if (submittedBy && budgetValue !== null && budgetValue > 0) {
      try {
        projectInvoice = await createProjectInvoice({
          tenantId: req.tenantId!,
          projectId: project.id,
          budget: budgetValue,
          submittedBy,
        });
      } catch (error) {
        console.error('Error creating project invoice:', error);
      }
    }

    // Notify all project-access users that a new project was created
    getProjectAccessRecipients(req.tenantId!).then((recipients) =>
      Promise.all(
        recipients.map((r) =>
          sendNotification({
            tenantId: req.tenantId!,
            userId: r.id,
            userType: r.type,
            type: 'project.created',
            title: 'New Project Created',
            message: `Project "${project.name}" has been created${payload.dueDate ? ` and is due on ${new Date(payload.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}.`,
            link: `/projects/${project.id}`,
          }).catch(() => {}),
        ),
      ),
    ).catch(() => {});

    // Notify technician if assigned
    if (payload.technician) {
      const techParts = payload.technician.trim().split(/\s+/);
      const techEmployee = await prisma.employee.findFirst({
        where: {
          tenantId: req.tenantId!,
          isActive: true,
          OR: [
            { firstName: { contains: techParts[0], mode: 'insensitive' } },
            { lastName: { contains: techParts[techParts.length - 1], mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      if (techEmployee) {
        sendNotification({
          tenantId: req.tenantId!,
          userId: techEmployee.id,
          userType: 'EMPLOYEE',
          type: 'project.assigned',
          title: 'Project Assigned to You',
          message: `You have been assigned to project: ${project.name}.`,
          link: `/projects/${project.id}`,
        }).catch(() => {});

        // Auto-create ProjectAssignment for the technician
        prisma.projectAssignment.create({
          data: {
            tenantId: req.tenantId!,
            projectId: project.id,
            employeeId: techEmployee.id,
            role: 'TECHNICIAN',
          },
        }).catch((err) => console.error('Failed to auto-create assignment:', err));
      }
    }

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PROJECT_CREATED',
      module: 'projects',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: project.name,
      details: { name: project.name, budget: project.budget, status: project.status },
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: 'Project created successfully',
      data: { project: responseProject, invoice: projectInvoice },
    });
  } catch (error) {
    console.error('Error creating project:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create project',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const listProjects = async (req: AuthRequest, res: Response) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const status = req.query.status ? String(req.query.status) : undefined;
    const skip = (page - 1) * limit;

    const where: any = { tenantId: req.tenantId! };
    if (status && status.toUpperCase() === 'OVERDUE') {
      where.dueDate = { lt: new Date() };
      where.status = { notIn: ['COMPLETED', 'CANCELLED'] };
    } else if (status) {
      where.status = status as any;
    }

    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
          milestones: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.project.count({ where }),
    ]);

    const data = projects.map((project) => {
      const milestones = project.milestones ?? [];
      const { progress } = computeProgressFromMilestones(milestones);
      const baseStatus = deriveStatusFromMilestones(project.status, milestones);
      const statusWithOverdue = applyOverdueStatus(baseStatus, project.dueDate);
      return {
        ...project,
        progress,
        status: statusWithOverdue,
      };
    });

    return res.json({
      success: true,
      message: 'Projects retrieved successfully',
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error listing projects:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve projects',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const getProject = async (req: AuthRequest, res: Response) => {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: {
        customer: true,
        milestones: { orderBy: { sortOrder: 'asc' } },
        materials: true,
      },
    }) as any;

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Attach assigned serialised items to each inventory-linked material
    const inventoryMaterialIds = (project.materials as any[])
      .filter((m) => m.categoryId)
      .map((m) => m.id);

    let itemsByMaterialId: Record<string, any[]> = {};
    if (inventoryMaterialIds.length > 0) {
      const assignedItems = await (prisma as any).productItem.findMany({
        where: { tenantId: req.tenantId!, projectMaterialId: { in: inventoryMaterialIds } },
        select: {
          id: true,
          systemId: true,
          userIdentifier: true,
          stockStatus: true,
          inventoryStatus: true,
          projectMaterialId: true,
        },
      });
      for (const item of assignedItems) {
        if (!itemsByMaterialId[item.projectMaterialId]) itemsByMaterialId[item.projectMaterialId] = [];
        itemsByMaterialId[item.projectMaterialId].push({
          id: item.id,
          systemId: item.systemId,
          userIdentifier: item.userIdentifier,
          status: item.stockStatus ?? item.inventoryStatus ?? 'UNKNOWN',
        });
      }
    }

    const materialsWithItems = (project.materials as any[]).map((m) => ({
      ...m,
      assignedItems: itemsByMaterialId[m.id] ?? [],
    }));

    const milestones = project.milestones ?? [];
    const { progress } = computeProgressFromMilestones(milestones);
    const baseStatus = deriveStatusFromMilestones(project.status, milestones);
    const statusWithOverdue = applyOverdueStatus(baseStatus, project.dueDate);

    return res.json({
      success: true,
      message: 'Project retrieved successfully',
      data: { ...project, materials: materialsWithItems, progress, status: statusWithOverdue },
    });
  } catch (error) {
    console.error('Error fetching project:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve project',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateProject = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = ProjectSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const existing = await prisma.project.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    const data = parsed.data;

    // Server-side guard: COMPLETED can only be set automatically via all phases completing
    if (data.status === 'COMPLETED') {
      return res.status(400).json({
        success: false,
        message: 'Project cannot be manually set to Completed. All phases must be completed for the project to reach Completed status automatically.',
      });
    }

    // Validate customer if provided (null clears the assignment)
    if (data.customerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: data.customerId, tenantId: req.tenantId! },
      });
      if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
      }
    }

    const existingBudget = existing.budget !== null && existing.budget !== undefined
      ? Number(existing.budget)
      : null;
    const budgetChanged = data.budget !== undefined
      && (existingBudget === null || Number(data.budget) !== existingBudget);

    // Determine lock changes driven by an explicit status change via the edit form.
    // COMPLETED is rejected above, so the only terminal state reachable here is CANCELLED.
    const statusChanged = data.status !== undefined && data.status !== existing.status;
    const newStatusIsLocked = data.status === 'CANCELLED';
    const newStatusIsActive = statusChanged && !newStatusIsLocked;
    const isLockedUpdate = statusChanged
      ? (newStatusIsLocked ? true : false)
      : undefined; // leave unchanged when status not supplied

    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: {
        name: data.name,
        description: data.description,
        customerId: data.customerId !== undefined ? data.customerId : undefined,
        // progress is calculated automatically from phase completion — not user-editable
        budget: data.budget as any,
        technician: data.technician,
        startDate: toDate(data.startDate),
        dueDate: toDate(data.dueDate),
        status: data.status ? (data.status as any) : undefined,
        isLocked: isLockedUpdate,
      },
      include: {
        customer: true,
        milestones: true,
        materials: true,
      },
    });

    const recalculated = await updateProjectProgressAndStatus(req.tenantId!, project.id);
    const milestones = project.milestones ?? [];
    const progress = recalculated?.progress ?? computeProgressFromMilestones(milestones).progress;
    const baseStatus = recalculated?.status ?? deriveStatusFromMilestones(project.status, milestones);
    const statusWithOverdue = applyOverdueStatus(baseStatus, project.dueDate);

    // When status changes to an active status via the edit form, clear returnedAt/returnNote
    // on project materials so the "Returned" badge disappears (items stay Available in inventory)
    if (newStatusIsActive) {
      try {
        await (prisma as any).projectMaterial.updateMany({
          where: { projectId: project.id },
          data: { returnedAt: null, returnNote: null },
        });
      } catch (err) {
        console.error('[edit] Error clearing material return fields on unlock:', err);
      }
    }

    // When CANCELLED via the edit form, auto-return inventory items
    if (newStatusIsLocked && statusChanged) {
      await autoReturnProjectInventory(req.tenantId!, project.id, project.name, 'CANCELLED');
    }

    const submittedBy = req.user?.id;
    if (submittedBy && budgetChanged) {
      const nextBudget = data.budget !== undefined ? Number(data.budget) : existingBudget;
      if (nextBudget !== null && nextBudget > 0) {
        try {
          // Create a new project invoice for the revised budget
          await createProjectInvoice({
            tenantId: req.tenantId!,
            projectId: project.id,
            budget: nextBudget,
            submittedBy,
          });
        } catch (error) {
          console.error('Error creating project invoice for budget update:', error);
        }
      }
    }

    // Notify technician if assignment changed
    if (data.technician && data.technician !== existing.technician) {
      const techParts = data.technician.trim().split(/\s+/);
      const techEmployee = await prisma.employee.findFirst({
        where: {
          tenantId: req.tenantId!,
          isActive: true,
          OR: [
            { firstName: { contains: techParts[0], mode: 'insensitive' } },
            { lastName: { contains: techParts[techParts.length - 1], mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      if (techEmployee) {
        sendNotification({
          tenantId: req.tenantId!,
          userId: techEmployee.id,
          userType: 'EMPLOYEE',
          type: 'project.assigned',
          title: 'Project Assigned to You',
          message: `You have been assigned to project: ${project.name}.`,
          link: `/projects/${project.id}`,
        }).catch(() => {});

        // Upsert ProjectAssignment — replace any existing assignment for this employee
        prisma.projectAssignment.upsert({
          where: { projectId_employeeId: { projectId: project.id, employeeId: techEmployee.id } },
          update: { role: 'TECHNICIAN' },
          create: {
            tenantId: req.tenantId!,
            projectId: project.id,
            employeeId: techEmployee.id,
            role: 'TECHNICIAN',
          },
        }).catch((err) => console.error('Failed to upsert assignment:', err));
      }
    }

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PROJECT_UPDATED',
      module: 'projects',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: project.name,
      details: buildDiff(existing as any, project as any),
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Project updated successfully',
      data: { ...project, progress, status: statusWithOverdue },
    });
  } catch (error) {
    console.error('Error updating project:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update project',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateProjectStatus = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = z.object({ status: z.string() }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const project = await prisma.project.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      select: { id: true, name: true, startDate: true, dueDate: true, status: true, budget: true, spent: true },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Guard: when completing a project, all phases must be COMPLETED or SKIPPED
    if (parsed.data.status === 'COMPLETED') {
      const { allPhasesComplete } = await recalculateProjectProgress(req.params.id as string, req.tenantId!);
      if (!allPhasesComplete) {
        return res.status(400).json({
          success: false,
          message: 'Cannot complete this project. All phases must be completed or skipped before marking the project as done.',
          error: {
            code: 'PHASES_INCOMPLETE',
            message: 'Cannot complete this project. All phases must be completed or skipped before marking the project as done.',
          },
        });
      }
    }

    const newStatus = parsed.data.status;
    const shouldLock = newStatus === 'COMPLETED' || newStatus === 'CANCELLED';
    const shouldUnlock = !shouldLock;

    const updated = await prisma.project.update({
      where: { id: req.params.id },
      data: {
        status: newStatus as any,
        completedAt: newStatus === 'COMPLETED' ? new Date() : null,
        isLocked: shouldLock ? true : false,
      },
    });

    // When unlocking (changing away from COMPLETED or CANCELLED), clear returnedAt/returnNote
    // on all project materials so the "Returned" badge disappears. Items are NOT re-assigned —
    // they are already Available in the inventory system.
    if (shouldUnlock) {
      try {
        await (prisma as any).projectMaterial.updateMany({
          where: { projectId: req.params.id },
          data: { returnedAt: null, returnNote: null },
        });
      } catch (err) {
        console.error('[unlock] Error clearing material return fields:', err);
      }
    }

    // Auto-return inventory items when project is COMPLETED or CANCELLED
    if (shouldLock) {
      await autoReturnProjectInventory(req.tenantId!, req.params.id as string, project.name, newStatus as 'COMPLETED' | 'CANCELLED');
    }

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PROJECT_STATUS_CHANGED',
      module: 'projects',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: project.name,
      details: { from: project.status, to: newStatus },
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Project status updated successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Error updating project status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update project status',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const deleteProject = async (req: AuthRequest, res: Response) => {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }
    if (project.isLocked) {
      return res.status(403).json({
        success: false,
        message: 'This project is locked. No further changes can be made to phases or materials.',
      });
    }

    await prisma.project.delete({ where: { id: req.params.id } });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PROJECT_DELETED',
      module: 'projects',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: project.name,
      details: { name: project.name },
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Project deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting project:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete project',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const createMilestone = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = MilestoneSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const project = await prisma.project.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // CANCELLED projects are fully locked — phases cannot be modified.
    // COMPLETED projects allow phase editing (to record corrections/updates).
    if (project.status === 'CANCELLED') {
      return res.status(403).json({
        success: false,
        message: 'This project has been cancelled. Phases cannot be modified.',
      });
    }

    const message = validateMilestoneDates(
      { startDate: project.startDate ?? null, dueDate: project.dueDate ?? null },
      parsed.data.startDate,
      parsed.data.endDate,
    );
    if (message) {
      return res.status(400).json({
        success: false,
        message,
      });
    }

    const maxSort = await prisma.projectMilestone.findFirst({
      where: { projectId: req.params.id },
      orderBy: { sortOrder: 'desc' },
    });

    const milestone = await prisma.projectMilestone.create({
      data: {
        tenantId: req.tenantId!,
        projectId: req.params.id,
        name: parsed.data.name,
        status: (parsed.data.status as any) || 'PENDING',
        progress: parsed.data.progress || 0,
        startDate: toDate(parsed.data.startDate),
        endDate: toDate(parsed.data.endDate),
        notes: parsed.data.notes,
        sortOrder: parsed.data.sortOrder ?? (maxSort?.sortOrder || 0) + 1,
      },
    });

    const recalculated = await updateProjectProgressAndStatus(req.tenantId!, req.params.id);

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PHASE_CREATED',
      module: 'projects',
      entityType: 'ProjectPhase',
      entityId: milestone.id,
      entityLabel: milestone.name,
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: 'Milestone created successfully',
      data: milestone,
      progress: recalculated?.progress ?? 0,
    });
  } catch (error) {
    console.error('Error creating milestone:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create milestone',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateMilestone = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = MilestoneSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const milestone = await prisma.projectMilestone.findFirst({
      where: { id: req.params.milestoneId, projectId: req.params.id, tenantId: req.tenantId! },
    });
    if (!milestone) {
      return res.status(404).json({
        success: false,
        message: 'Milestone not found',
      });
    }

    const project = await prisma.project.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
      select: { startDate: true, dueDate: true, isLocked: true, status: true },
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }
    // CANCELLED projects are fully locked — phases cannot be modified.
    // COMPLETED projects allow phase editing.
    if (project.status === 'CANCELLED') {
      return res.status(403).json({
        success: false,
        message: 'This project has been cancelled. Phases cannot be modified.',
      });
    }

    const nextStartDate = parsed.data.startDate ?? (milestone.startDate ? milestone.startDate.toISOString().slice(0, 10) : undefined);
    const nextEndDate = parsed.data.endDate ?? (milestone.endDate ? milestone.endDate.toISOString().slice(0, 10) : undefined);
    const message = validateMilestoneDates(
      { startDate: project.startDate ?? null, dueDate: project.dueDate ?? null },
      typeof nextStartDate === 'string' ? nextStartDate : undefined,
      typeof nextEndDate === 'string' ? nextEndDate : undefined,
    );
    if (message) {
      return res.status(400).json({
        success: false,
        message,
      });
    }

    const updateData: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
    if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
    if (parsed.data.progress !== undefined) updateData.progress = parsed.data.progress;
    if (parsed.data.startDate !== undefined) updateData.startDate = toDate(parsed.data.startDate);
    if (parsed.data.endDate !== undefined) updateData.endDate = toDate(parsed.data.endDate);
    if (parsed.data.notes !== undefined) updateData.notes = parsed.data.notes;
    if (parsed.data.sortOrder !== undefined) updateData.sortOrder = parsed.data.sortOrder;

    const updated = await prisma.projectMilestone.update({
      where: { id: req.params.milestoneId },
      data: updateData,
    });

    const recalculated = await updateProjectProgressAndStatus(req.tenantId!, req.params.id);

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PHASE_UPDATED',
      module: 'projects',
      entityType: 'ProjectPhase',
      entityId: updated.id,
      entityLabel: updated.name,
      details: buildDiff(milestone as any, updated as any),
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Milestone updated successfully',
      data: updated,
      progress: recalculated?.progress ?? 0,
    });
  } catch (error) {
    console.error('Error updating milestone:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update milestone',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const deleteMilestone = async (req: AuthRequest, res: Response) => {
  try {
    const milestone = await prisma.projectMilestone.findFirst({
      where: { id: req.params.milestoneId, projectId: req.params.id, tenantId: req.tenantId! },
      include: { project: { select: { isLocked: true, status: true } } },
    });
    if (!milestone) {
      return res.status(404).json({
        success: false,
        message: 'Milestone not found',
      });
    }

    // CANCELLED projects are fully locked — phases cannot be modified.
    // COMPLETED projects allow phase editing.
    if (milestone.project.status === 'CANCELLED') {
      return res.status(403).json({
        success: false,
        message: 'This project has been cancelled. Phases cannot be modified.',
      });
    }

    await prisma.projectMilestone.delete({ where: { id: req.params.milestoneId } });
    const recalculated = await updateProjectProgressAndStatus(req.tenantId!, req.params.id);

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PHASE_DELETED',
      module: 'projects',
      entityType: 'ProjectPhase',
      entityId: milestone.id,
      entityLabel: milestone.name,
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Milestone deleted successfully',
      progress: recalculated?.progress ?? 0,
    });
  } catch (error) {
    console.error('Error deleting milestone:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete milestone',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const addMaterial = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = MaterialSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }
    const { data } = parsed;

    // ── Path A/B — category-linked material (STOCK or INVENTORY) ──────────────────────
    if (data.categoryId) {
      if (data.unitCost !== undefined && data.unitCost <= 0) {
        return res.status(400).json({ success: false, message: 'unitCost must be positive' });
      }

      const result = await prisma.$transaction(async (tx) => {
        const project = await tx.project.findFirst({
          where: { id: req.params.id, tenantId: req.tenantId! },
        });
        if (!project) throw new ApiError(404, 'Project not found');
        if (project.isLocked) throw new ApiError(403, 'This project is locked. No further changes can be made to phases or materials.');
        if (!(project as any).invoiceApproved) {
          throw new ApiError(
            403,
            'Cannot add materials. The project invoice has not been approved by finance yet. At least one instalment must be approved before materials can be added.',
          );
        }

        const category = await (tx as any).inventoryCategory.findFirst({
          where: { id: data.categoryId, tenantId: req.tenantId! },
        });
        if (!category) throw new ApiError(404, 'Inventory category not found');

        const catType: string = category.type ?? 'STOCK';
        const isInventoryType = catType === 'INVENTORY';

        if (isInventoryType && data.includeCostInProject === undefined) {
          throw new ApiError(400, 'includeCostInProject is required for inventory materials.');
        }

        // Status fields for the correct category type
        const availStatusField = isInventoryType ? 'inventoryStatus' : 'stockStatus';
        const activeStatusValue = isInventoryType ? 'IN_USE' : 'DEPLOYED';

        // Item selection: specific item (by itemId) or FIFO auto-assign
        let availableItems: any[];
        if (data.itemId) {
          const specificItem = await (tx as any).productItem.findFirst({
            where: { id: data.itemId, tenantId: req.tenantId!, categoryId: data.categoryId, [availStatusField]: 'AVAILABLE' },
          });
          if (!specificItem) {
            throw new ApiError(404, 'The selected unit is not available or does not belong to this category.');
          }
          availableItems = [specificItem];
        } else {
          availableItems = await (tx as any).productItem.findMany({
            where: { tenantId: req.tenantId!, categoryId: data.categoryId, [availStatusField]: 'AVAILABLE' },
            orderBy: { createdAt: 'asc' },
            take: data.quantity,
          });
          if (availableItems.length < data.quantity) {
            throw new ApiError(
              400,
              `Insufficient stock. Only ${availableItems.length} items available in ${category.name}.`,
            );
          }
        }

        const effectiveQuantity = data.itemId ? 1 : data.quantity;
        // For STOCK: use sellingPrice as unitCost (what client is charged); store costPrice as unitCostPrice
        // For INVENTORY: use costPrice if includeCostInProject, since inventory is not sold
        const isStockType = catType === 'STOCK';
        const effectiveUnitCost = data.unitCost ??
          (isStockType
            ? (Number(category.sellingPrice ?? 0) || Number(category.costPrice ?? 0))
            : Number(category.costPrice ?? 0));
        const internalCostPrice = Number(category.costPrice ?? 0);
        const includeCost = isInventoryType ? (data.includeCostInProject ?? true) : true;
        const budgetDeduction = includeCost ? effectiveQuantity * effectiveUnitCost : 0;
        const availableBudget = getProjectBudgetLimit(project);
        const spentAmount = getProjectSpentAmount(project);
        const newSpentAmount = spentAmount + budgetDeduction;

        if (newSpentAmount > availableBudget + 0.01) {
          throw new ApiError(
            400,
            `Adding this material would exceed the project approved budget. Available: ${availableBudget} XAF. Already spent: ${spentAmount} XAF. This addition: ${budgetDeduction} XAF. Shortfall: ${newSpentAmount - availableBudget} XAF.`,
          );
        }

        if (isStockType && budgetDeduction > 0) {
          await (tx as any).transaction.create({
            data: {
              tenantId: req.tenantId!,
              type: 'INTERNAL',
              status: 'ACCEPTED',
              amount: budgetDeduction as any,
              currency: 'XAF',
              description: `Stock deployed to project "${project.name}": ${effectiveQuantity} x ${data.name} at ${effectiveUnitCost} XAF (selling price)`,
              category: 'Stock Deployment',
              projectId: project.id,
              moduleRef: 'projects',
              entityId: project.id,
              isAutomatic: true,
              notes: `Cost price: ${internalCostPrice} XAF per unit. Margin: ${effectiveUnitCost - internalCostPrice} XAF per unit.`,
              recordedAt: new Date(),
            },
          });
        }

        if (isInventoryType && includeCost && budgetDeduction > 0) {
          await (tx as any).transaction.create({
            data: {
              tenantId: req.tenantId!,
              type: 'INTERNAL',
              status: 'ACCEPTED',
              amount: budgetDeduction as any,
              currency: 'XAF',
              description: `Inventory deployed to project "${project.name}": ${effectiveQuantity} x ${data.name} at ${effectiveUnitCost} XAF`,
              category: 'Inventory Deployment',
              projectId: project.id,
              moduleRef: 'projects',
              entityId: project.id,
              isAutomatic: true,
              recordedAt: new Date(),
            },
          });
        }

        const material = await tx.projectMaterial.create({
          data: {
            tenantId: req.tenantId!,
            projectId: req.params.id,
            categoryId: data.categoryId,
            sourceType: catType,
            includeCostInProject: includeCost,
            name: data.name,
            quantity: effectiveQuantity,
            unitCost: effectiveUnitCost as any,
            unitCostPrice: internalCostPrice as any,
            totalCost: budgetDeduction as any,
            assignedItemIds: availableItems.map((i: any) => i.id),
            notes: data.notes,
          },
        });

        // Mark items with the appropriate active status
        await (tx as any).productItem.updateMany({
          where: { id: { in: availableItems.map((i: any) => i.id) } },
          data: { [availStatusField]: activeStatusValue, projectId: project.id, projectMaterialId: material.id },
        });

        await tx.project.update({
          where: { id: req.params.id },
          data: {
            spent: (project.spent as any).add ? project.spent.add(budgetDeduction) : (project.spent as any) + budgetDeduction,
            spentAmount: newSpentAmount as any,
            remainingBudget: Math.max(0, availableBudget - newSpentAmount) as any,
          },
        });

        return {
          material,
          assignedItems: availableItems.map((i: any) => ({ id: i.id, systemId: i.systemId, userIdentifier: i.userIdentifier })),
          projectName: project.name,
          catType,
          includeCost,
        };
      });

      const submittedBy = req.user?.id;
      // Materials are tracked via client invoices — no queue entries needed

      return res.status(201).json({
        success: true,
        message: 'Material added successfully',
        data: { ...result.material, assignedItems: result.assignedItems },
      });
    }

    // ── Path C — EXTERNAL material (no inventory link) ────────────────────────────
    if (data.unitCost === undefined) {
      return res.status(400).json({ success: false, message: 'unitCost is required for external materials' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: req.params.id, tenantId: req.tenantId! },
      });
      if (!project) throw new ApiError(404, 'Project not found');
      if (project.isLocked) throw new ApiError(403, 'This project is locked. No further changes can be made to phases or materials.');
      if (!(project as any).invoiceApproved) {
        throw new ApiError(
          403,
          'Cannot add materials. The project invoice has not been approved by finance yet. At least one instalment must be approved before materials can be added.',
        );
      }

      let product = null as null | { id: string; name: string; quantity: number; lowStockAt: number; sku: string };
      if (data.productId) {
        product = await tx.inventoryItem.findFirst({
          where: { id: data.productId, tenantId: req.tenantId! },
          select: { id: true, name: true, quantity: true, lowStockAt: true, sku: true },
        });
        if (!product) throw new ApiError(404, 'Inventory product not found');
        if (product.quantity < data.quantity) {
          throw new ApiError(400, `Insufficient stock. Only ${product.quantity} units available for ${product.name}.`);
        }
      }

      const totalCost = data.quantity * data.unitCost!;
      const availableBudget = getProjectBudgetLimit(project);
      const spentAmount = getProjectSpentAmount(project);
      const newSpentAmount = spentAmount + totalCost;

      if (newSpentAmount > availableBudget + 0.01) {
        throw new ApiError(
          400,
          `Adding this material would exceed the project approved budget. Available: ${availableBudget} XAF. Already spent: ${spentAmount} XAF. This addition: ${totalCost} XAF. Shortfall: ${newSpentAmount - availableBudget} XAF.`,
        );
      }

      await checkSufficientFunds(req.tenantId!, totalCost);
      await (tx as any).transaction.create({
        data: {
          tenantId: req.tenantId!,
          type: 'EXPENSE',
          status: 'ACCEPTED',
          amount: totalCost as any,
          currency: 'XAF',
          description: `External material for project "${project.name}": ${data.quantity} x ${data.name} at ${data.unitCost} XAF`,
          category: 'Project Materials',
          projectId: project.id,
          moduleRef: 'projects',
          entityId: project.id,
          isAutomatic: true,
          recordedAt: new Date(),
        },
      });
      await recordExpense(req.tenantId!, totalCost, tx);

      const material = await tx.projectMaterial.create({
        data: {
          tenantId: req.tenantId!,
          projectId: req.params.id,
          productId: data.productId ?? undefined,
          itemSku: data.itemSku ? data.itemSku.toUpperCase() : product?.sku ?? undefined,
          sourceType: 'EXTERNAL',
          name: data.name,
          quantity: data.quantity,
          unitCost: data.unitCost as any,
          totalCost: totalCost as any,
          notes: data.notes,
        },
      });

      await tx.project.update({
        where: { id: req.params.id },
        data: {
          spent: (project.spent as any).add ? project.spent.add(totalCost) : (project.spent as any) + totalCost,
          spentAmount: newSpentAmount as any,
          remainingBudget: Math.max(0, availableBudget - newSpentAmount) as any,
        },
      });

      let stockAfter: number | null = null;
      let productName: string | null = null;

      if (product) {
        const stockBefore = product.quantity;
        const nextStock = stockBefore - data.quantity;
        const status = resolveInventoryStatus(nextStock, product.lowStockAt);
        await tx.inventoryItem.update({ where: { id: product.id }, data: { quantity: nextStock, status: status as any } });
        await tx.stockMovement.create({
          data: {
            tenantId: req.tenantId!,
            productId: product.id,
            projectId: project.id,
            projectMaterialId: material.id,
            type: 'DEDUCTION',
            quantity: data.quantity,
            stockBefore,
            stockAfter: nextStock,
            note: `Used in project: ${project.name}`,
          },
        });
        stockAfter = nextStock;
        productName = product.name;
      }

      return { material, stockAfter, productName, projectName: project.name };
    });

    const submittedBy = req.user?.id;
    // Materials are tracked via client invoices — no per-material queue entries needed

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'MATERIAL_ADDED',
      module: 'projects',
      entityType: 'ProjectMaterial',
      entityId: result.material.id,
      entityLabel: result.material.name,
      details: { name: result.material.name, sourceType: result.material.sourceType, quantity: result.material.quantity, totalCost: result.material.totalCost },
      ...extractRequestContext(req),
    });

    return res.status(201).json({
      success: true,
      message: 'Material added successfully',
      data: {
        ...result.material,
        assignedItems: [],
        stockAfter: result.stockAfter ?? undefined,
        productName: result.productName ?? undefined,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error('Error adding material:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to add material',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const updateMaterial = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = MaterialSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }
    const { data } = parsed;

    const result = await prisma.$transaction(async (tx) => {
      const material = await tx.projectMaterial.findFirst({
        where: { id: req.params.materialId, projectId: req.params.id, tenantId: req.tenantId! },
        include: {
          project: {
            select: {
              isLocked: true,
              name: true,
              spent: true,
              budget: true,
              availableBudget: true,
              spentAmount: true,
              remainingBudget: true,
              invoiceApproved: true,
            },
          },
        },
      });
      if (!material) {
        throw new ApiError(404, 'Material not found');
      }

      if (material.project.isLocked) {
        throw new ApiError(403, 'This project is locked. No further changes can be made to phases or materials.');
      }

      const project = material.project;
      if (!(project as any).invoiceApproved) {
        throw new ApiError(
          403,
          'Cannot update materials. The project invoice has not been approved by finance yet. At least one instalment must be approved before materials can be changed.',
        );
      }

      const nextQuantity = data.quantity ?? material.quantity;
      const nextUnitCost = data.unitCost ?? Number(material.unitCost);
      const newTotal = nextQuantity * nextUnitCost;
      const diff = newTotal - Number(material.totalCost);
      const isExternalMaterial = ((material as any).sourceType ?? 'EXTERNAL') === 'EXTERNAL' && !material.categoryId;
      const spentAmount = getProjectSpentAmount(project);
      const availableBudget = getProjectBudgetLimit(project);
      const nextSpentAmount = spentAmount + diff;

      if (diff > 0 && nextSpentAmount > availableBudget + 0.01) {
        throw new ApiError(
          400,
          `Updating this material would exceed the project approved budget. Available: ${availableBudget} XAF. Already spent: ${spentAmount} XAF. This change: ${diff} XAF. Shortfall: ${nextSpentAmount - availableBudget} XAF.`,
        );
      }

      if (isExternalMaterial && diff > 0) {
        await checkSufficientFunds(req.tenantId!, diff);
        await (tx as any).transaction.create({
          data: {
            tenantId: req.tenantId!,
            type: 'EXPENSE',
            status: 'ACCEPTED',
            amount: diff as any,
            currency: 'XAF',
            description: `External material adjustment: ${data.name ?? material.name} for project ${project.name}`,
            category: 'Project Materials',
            projectId: req.params.id,
            moduleRef: 'projects',
            entityId: req.params.id,
            isAutomatic: true,
            recordedAt: new Date(),
          },
        });
        await recordExpense(req.tenantId!, diff, tx);
      } else if (isExternalMaterial && diff < 0) {
        await reverseExpense(req.tenantId!, Math.abs(diff), tx);
      }

      const updateData: Record<string, unknown> = {
        totalCost: newTotal as any,
      };
      const nextProductId = data.productId ?? material.productId;
      if (data.productId && material.productId && data.productId !== material.productId) {
        throw new ApiError(400, 'Changing linked product is not supported.');
      }
      if (data.name !== undefined) updateData.name = data.name;
      if (data.quantity !== undefined) updateData.quantity = data.quantity;
      if (data.unitCost !== undefined) updateData.unitCost = data.unitCost as any;
      if (data.notes !== undefined) updateData.notes = data.notes;
      if (data.itemSku !== undefined) {
        updateData.itemSku = data.itemSku ? data.itemSku.toUpperCase() : undefined;
      }
      if (data.productId !== undefined && data.productId !== material.productId) {
        updateData.productId = data.productId;
      }

      const updated = await tx.projectMaterial.update({
        where: { id: req.params.materialId },
        data: updateData,
      });

      await tx.project.update({
        where: { id: req.params.id },
        data: {
          spent: (project.spent as any).add ? project.spent.add(diff) : (project.spent as any) + diff,
          spentAmount: Math.max(0, nextSpentAmount) as any,
          remainingBudget: Math.max(0, availableBudget - Math.max(0, nextSpentAmount)) as any,
        },
      });

      if (nextProductId) {
        const wasLinked = Boolean(material.productId);
        const isLinkingNow = !wasLinked && Boolean(data.productId);
        const delta = nextQuantity - material.quantity;

        if (isLinkingNow || delta !== 0) {
          const product = await tx.inventoryItem.findFirst({
            where: { id: nextProductId, tenantId: req.tenantId! },
            select: { id: true, name: true, quantity: true, lowStockAt: true },
          });
          if (!product) {
            throw new ApiError(404, 'Inventory product not found');
          }

          const required = isLinkingNow ? nextQuantity : Math.abs(delta);
          if ((isLinkingNow || delta > 0) && product.quantity < required) {
            throw new ApiError(
              400,
              `Insufficient stock. Only ${product.quantity} units available for ${product.name}.`,
            );
          }

          const stockBefore = product.quantity;
          const stockAfter = isLinkingNow
            ? stockBefore - nextQuantity
            : delta > 0
              ? stockBefore - delta
              : stockBefore + Math.abs(delta);
          const status = resolveInventoryStatus(stockAfter, product.lowStockAt);

          await tx.inventoryItem.update({
            where: { id: product.id },
            data: {
              quantity: stockAfter,
              status: status as any,
            },
          });

          await tx.stockMovement.create({
            data: {
              tenantId: req.tenantId!,
              productId: product.id,
              projectId: project.id,
              projectMaterialId: material.id,
              type: isLinkingNow || delta > 0 ? 'DEDUCTION' : 'RESTOCK',
              quantity: isLinkingNow ? nextQuantity : Math.abs(delta),
              stockBefore,
              stockAfter,
              note: isLinkingNow || delta > 0
                ? `Used in project: ${project.name}`
                : `Quantity reduced on project: ${project.name}`,
            },
          });
        }
      }

      return { updated, projectName: project.name, priceDiff: diff };
    });

    const submittedBy = req.user?.id;
    const priceDiff = Number(result.priceDiff);
    if (submittedBy && priceDiff !== 0) {
      const totalCost = Number(result.updated.totalCost);
      const isFromInventory = Boolean(result.updated.productId);
      // Type when cost increases: INCOME if from inventory, EXPENSE if external.
      // Type when cost decreases (deduction): always EXPENSE regardless of source.
      const originalType: 'INCOME' | 'EXPENSE' = isFromInventory ? 'INCOME' : 'EXPENSE';
      try {
        // Check if the material still has an unvalidated PENDING entry.
        const pendingEntry = await getExistingPendingEntry(
          req.tenantId!,
          'PROJECT',
          result.updated.id,
          originalType,
        );

        if (pendingEntry) {
          // Not yet validated: update the pending entry to the current full total.
          const sourceLabel = `Material: ${result.updated.name} for project ${result.projectName}`;
          const description = isFromInventory
            ? `Inventory deployed on project ${result.projectName}: ${result.updated.quantity} × ${result.updated.name} at ${Number(result.updated.unitCost)} XAF. Value delivered to client.`
            : `External material purchased for project ${result.projectName}: ${result.updated.quantity} × ${result.updated.name} at ${Number(result.updated.unitCost)} XAF.`;
          await prisma.financeValidationQueue.update({
            where: { id: pendingEntry.id },
            data: {
              projectedAmount: totalCost as any,
              sourceLabel,
              description,
              category: isFromInventory ? 'Materials Revenue' : 'Materials',
            },
          });
        } else {
          // Previously validated (APPROVED/REJECTED): queue only the delta change.
          const deltaAmount = Math.abs(priceDiff);
          // Increase: same type as creation (inventory→INCOME, external→EXPENSE).
          // Decrease: inverted type (inventory→EXPENSE, external→INCOME).
          const deltaType: 'INCOME' | 'EXPENSE' = priceDiff > 0
            ? (isFromInventory ? 'INCOME' : 'EXPENSE')
            : (isFromInventory ? 'EXPENSE' : 'INCOME');
          const sourceLabel = `Material delta: ${result.updated.name} for project ${result.projectName}`;
          const description = priceDiff > 0
            ? (isFromInventory
                ? `Additional inventory deployed on project ${result.projectName}: ${result.updated.name} value increased by ${deltaAmount} XAF. Value delivered to client.`
                : `Additional external material cost for project ${result.projectName}: ${result.updated.name} value increased by ${deltaAmount} XAF.`)
            : (isFromInventory
                ? `Inventory value reduced on project ${result.projectName}: ${result.updated.name} decreased by ${deltaAmount} XAF. Less value delivered to client.`
                : `External material cost reduced on project ${result.projectName}: ${result.updated.name} decreased by ${deltaAmount} XAF. Cost saving.`);
          const category = deltaType === 'INCOME' ? 'Materials Revenue' : 'Materials';
          await prisma.financeValidationQueue.create({
            data: {
              tenantId: req.tenantId!,
              type: deltaType as any,
              status: 'PENDING',
              sourceModule: 'PROJECT',
              sourceId: result.updated.id,
              sourceLabel,
              projectedAmount: deltaAmount as any,
              category,
              description,
              submittedBy,
              projectId: req.params.id,
              inventoryItemId: null,
            },
          });
          await broadcastToModule(req.tenantId!, 'finance', {
            type: 'finance.entry.pending',
            title: 'New Validation Required',
            message: `${sourceLabel} requires finance validation.`,
            link: '/finances?tab=validations',
          });
        }
      } catch (error) {
        console.error('Error syncing finance queue for project material update:', error);
      }
    }

    return res.json({
      success: true,
      message: 'Material updated successfully',
      data: result.updated,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    console.error('Error updating material:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update material',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const deleteMaterial = async (req: AuthRequest, res: Response) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const material = await tx.projectMaterial.findFirst({
        where: { id: req.params.materialId, projectId: req.params.id, tenantId: req.tenantId! },
        include: {
          project: {
            select: {
              isLocked: true,
              name: true,
              spent: true,
              budget: true,
              availableBudget: true,
              spentAmount: true,
              remainingBudget: true,
            },
          },
        },
      });
      if (!material) {
        throw new ApiError(404, 'Material not found');
      }

      if (material.project.isLocked) {
        throw new ApiError(403, 'This project is locked. No further changes can be made to phases or materials.');
      }

      const project = material.project;
      const budgetDeduction = Number(material.totalCost ?? 0);
      const availableBudget = getProjectBudgetLimit(project);
      const nextSpentAmount = Math.max(0, getProjectSpentAmount(project) - budgetDeduction);
      const sourceType = (material as any).sourceType ?? 'EXTERNAL';
      const materialName = material.name;

      await tx.project.update({
        where: { id: req.params.id },
        data: {
          spent: (project.spent as any).sub ? project.spent.sub(material.totalCost) : (project.spent as any) - (material.totalCost as any),
          spentAmount: nextSpentAmount as any,
          remainingBudget: Math.max(0, availableBudget - nextSpentAmount) as any,
        },
      });

      if (sourceType === 'EXTERNAL') {
        await reverseExpense(req.tenantId!, budgetDeduction, tx);
      }

      if (sourceType === 'STOCK' || sourceType === 'INVENTORY') {
        await (tx as any).transaction.updateMany({
          where: {
            tenantId: req.tenantId!,
            type: 'INTERNAL',
            isAutomatic: true,
            projectId: req.params.id,
            description: { contains: materialName, mode: 'insensitive' },
          },
          data: {
            notes: `REVERSED - material removed from project on ${new Date().toISOString().split('T')[0]}`,
          },
        });
      }

      if (material.productId) {
        const product = await tx.inventoryItem.findFirst({
          where: { id: material.productId, tenantId: req.tenantId! },
          select: { id: true, name: true, quantity: true, lowStockAt: true },
        });
        if (!product) {
          throw new ApiError(404, 'Inventory product not found');
        }

        const stockBefore = product.quantity;
        const stockAfter = stockBefore + material.quantity;
        const status = resolveInventoryStatus(stockAfter, product.lowStockAt);

        await tx.inventoryItem.update({
          where: { id: product.id },
          data: {
            quantity: stockAfter,
            status: status as any,
          },
        });

        await tx.stockMovement.create({
          data: {
            tenantId: req.tenantId!,
            productId: product.id,
            projectId: project.id,
            projectMaterialId: material.id,
            type: 'RESTOCK',
            quantity: material.quantity,
            stockBefore,
            stockAfter,
            note: `Material removed from project: ${project.name}`,
          },
        });
      }

      // Return serialised items to AVAILABLE using the correct status field based on sourceType
      if ((material as any).categoryId) {
        const matSourceType: string = (material as any).sourceType ?? 'STOCK';
        const isInventoryMat = matSourceType === 'INVENTORY';
        const statusField = isInventoryMat ? 'inventoryStatus' : 'stockStatus';
        await (tx as any).productItem.updateMany({
          where: { projectMaterialId: req.params.materialId, tenantId: req.tenantId! },
          data: { [statusField]: 'AVAILABLE', projectId: null, projectMaterialId: null },
        });
      }

      await tx.projectMaterial.delete({ where: { id: req.params.materialId } });

      return { materialId: material.id };
    });

    try {
      await prisma.financeValidationQueue.updateMany({
        where: {
          tenantId: req.tenantId!,
          sourceModule: 'PROJECT',
          sourceId: result.materialId,
          status: 'PENDING',
        },
        data: {
          status: 'REJECTED',
          rejectionReason: 'Material was removed from the project',
          rejectedAt: new Date(),
        },
      });
    } catch (error) {
      console.error('Error rejecting finance queue entry for material deletion:', error);
    }

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'MATERIAL_REMOVED',
      module: 'projects',
      entityType: 'ProjectMaterial',
      entityId: result.materialId,
      ...extractRequestContext(req),
    });

    return res.json({
      success: true,
      message: 'Material deleted successfully',
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    console.error('Error deleting material:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete material',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const removeMaterialItem = async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId, materialId, itemId } = req.params as Record<string, string>;
    const isFaulty = req.query.reason === 'faulty';

    const result = await prisma.$transaction(async (tx) => {
      const material = await tx.projectMaterial.findFirst({
        where: { id: materialId, projectId, tenantId: req.tenantId! },
        include: { project: { select: { isLocked: true, name: true, spent: true } } },
      }) as any;
      if (!material) throw new ApiError(404, 'Material not found');
      if (material.project.isLocked) throw new ApiError(403, 'This project is locked. No further changes can be made to phases or materials.');

      // Verify the item belongs to this material
      const item = await (tx as any).productItem.findFirst({
        where: { id: itemId, projectMaterialId: materialId, tenantId: req.tenantId! },
      });
      if (!item) throw new ApiError(404, 'Item not found on this material');

      // Un-deploy the item using correct status field based on sourceType
      const matSourceType: string = (material as any).sourceType ?? 'STOCK';
      const isInventoryMat = matSourceType === 'INVENTORY';
      const itemStatusField = isInventoryMat ? 'inventoryStatus' : 'stockStatus';
      const returnedStatus = isFaulty ? 'FAULTY' : 'AVAILABLE';

      await (tx as any).productItem.update({
        where: { id: itemId },
        data: { [itemStatusField]: returnedStatus, projectId: null, projectMaterialId: null },
      });

      const newQuantity = material.quantity - 1;
      const unitCost = Number(material.unitCost);
      const newTotalCost = newQuantity * unitCost;
      const costDiff = Number(material.totalCost) - newTotalCost;

      const updatedMaterial = await tx.projectMaterial.update({
        where: { id: materialId },
        data: {
          quantity: newQuantity,
          totalCost: newTotalCost as any,
          assignedItemIds: { set: material.assignedItemIds.filter((iid: string) => iid !== itemId) },
        } as any,
      });

      // Adjust project spent
      await tx.project.update({
        where: { id: projectId },
        data: { spent: (material.project.spent as any).sub ? material.project.spent.sub(costDiff) : (material.project.spent as any) - costDiff },
      });

      // Fetch remaining assigned items
      const remainingItems = await (tx as any).productItem.findMany({
        where: { projectMaterialId: materialId, tenantId: req.tenantId! },
        select: { id: true, systemId: true, userIdentifier: true, stockStatus: true, inventoryStatus: true },
      });

      return { updatedMaterial, remainingItems, costDiff, projectName: material.project.name };
    });

    // Adjust finance queue entry if still pending
    const submittedBy = req.user?.id;
    if (submittedBy && result.costDiff !== 0) {
      try {
        const pendingEntry = await getExistingPendingEntry(req.tenantId!, 'PROJECT', materialId, 'INCOME');
        if (pendingEntry) {
          await prisma.financeValidationQueue.update({
            where: { id: pendingEntry.id },
            data: { projectedAmount: Number(result.updatedMaterial.totalCost) as any },
          });
        }
      } catch (err) {
        console.error('Error adjusting finance queue after item removal:', err);
      }
    }

    return res.json({
      success: true,
      message: 'Item removed from material successfully',
      data: { ...result.updatedMaterial, assignedItems: result.remainingItems },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error('Error removing material item:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to remove item from material',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// ── Project Assignments ──────────────────────────────────────────────────────

export const listAssignments = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const project = await prisma.project.findFirst({
      where: { id, tenantId: req.tenantId! },
      select: { id: true },
    });
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    const assignments = await prisma.projectAssignment.findMany({
      where: { projectId: id },
      include: {
        employee: {
          select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    }) as any[];

    return res.json({
      success: true,
      data: assignments.map((a) => ({
        id: a.id,
        employeeId: a.employeeId,
        role: a.role,
        createdAt: a.createdAt,
        employee: a.employee,
      })),
    });
  } catch (error) {
    console.error('Error listing project assignments:', error);
    return res.status(500).json({ success: false, message: 'Failed to list assignments' });
  }
};

export const createAssignment = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { employeeId, role } = req.body;

    if (!employeeId) {
      return res.status(400).json({ success: false, message: 'employeeId is required' });
    }

    const project = await prisma.project.findFirst({
      where: { id, tenantId: req.tenantId! },
      select: { id: true, name: true },
    });
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, tenantId: req.tenantId!, isActive: true },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found or inactive' });
    }

    const existing = await prisma.projectAssignment.findUnique({
      where: { projectId_employeeId: { projectId: id, employeeId } },
    });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Employee is already assigned to this project' });
    }

    const assignment = await prisma.projectAssignment.create({
      data: {
        tenantId: req.tenantId!,
        projectId: id,
        employeeId,
        role: role || 'TECHNICIAN',
      },
      include: {
        employee: {
          select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true },
        },
      },
    }) as any;

    sendNotification({
      tenantId: req.tenantId!,
      userId: employeeId,
      userType: 'EMPLOYEE',
      type: 'project.assigned',
      title: 'Project Assigned to You',
      message: `You have been assigned to project: ${project.name}.`,
      link: `/projects/${id}`,
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      data: {
        id: assignment.id,
        employeeId: assignment.employeeId,
        role: assignment.role,
        createdAt: assignment.createdAt,
        employee: assignment.employee,
      },
    });
  } catch (error) {
    console.error('Error creating project assignment:', error);
    return res.status(500).json({ success: false, message: 'Failed to create assignment' });
  }
};

export const deleteAssignment = async (req: AuthRequest, res: Response) => {
  try {
    const { id, assignmentId } = req.params;

    const project = await prisma.project.findFirst({
      where: { id, tenantId: req.tenantId! },
      select: { id: true },
    });
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    const assignment = await prisma.projectAssignment.findFirst({
      where: { id: assignmentId, projectId: id },
    });
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Assignment not found' });
    }

    await prisma.projectAssignment.delete({ where: { id: assignmentId } });

    return res.json({ success: true, message: 'Assignment removed successfully' });
  } catch (error) {
    console.error('Error deleting project assignment:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete assignment' });
  }
};

// ── Project Expense (Additional Costs) ─────────────────────────────────────

const ProjectExpenseSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  amount: z.number().positive('Amount must be greater than 0'),
  category: z.enum(['Transportation', 'Food', 'Labor', 'Site Logistics', 'Permit Fees', 'Other']),
});

export const addProjectExpense = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = ProjectExpenseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
    }
    const { description, amount, category } = parsed.data;

    const result = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: req.params.id, tenantId: req.tenantId! },
      });
      if (!project) throw new ApiError(404, 'Project not found');
      if (project.isLocked) throw new ApiError(400, 'Cannot add expenses to a locked project');

      const availableBudget = getProjectBudgetLimit(project);
      const spentAmount = getProjectSpentAmount(project);

      if (availableBudget > 0) {
        const newSpentAmount = spentAmount + amount;
        if (newSpentAmount > availableBudget + 0.01) {
          throw new ApiError(400, `This expense (${amount.toLocaleString()} XAF) would exceed the remaining project budget of ${(availableBudget - spentAmount).toLocaleString()} XAF.`);
        }
      }

      // Deduct from company balance
      await recordExpense(req.tenantId!, amount, tx);

      const transaction = await tx.transaction.create({
        data: {
          tenantId: req.tenantId!,
          type: 'EXPENSE',
          status: 'ACCEPTED',
          amount: amount as any,
          currency: 'XAF',
          description,
          category,
          projectId: project.id,
          moduleRef: 'projects',
          entityId: project.id,
          isAutomatic: true,
          recordedAt: new Date(),
        },
      });

      // Update project spending
      const newSpentAmount = spentAmount + amount;
      await tx.project.update({
        where: { id: project.id },
        data: {
          spent: { increment: amount as any },
          spentAmount: newSpentAmount as any,
          remainingBudget: Math.max(0, availableBudget - newSpentAmount) as any,
        },
      });

      return transaction;
    });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PROJECT_EXPENSE_ADDED',
      module: 'projects',
      entityType: 'Transaction',
      entityId: result.id,
      entityLabel: description,
      details: { projectId: req.params.id, amount, category },
      ...extractRequestContext(req),
    });

    return res.status(201).json({ success: true, message: 'Expense added successfully', data: result });
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error('Error adding project expense:', error);
    return res.status(500).json({ success: false, message: 'Failed to add expense' });
  }
};

export const deleteProjectExpense = async (req: AuthRequest, res: Response) => {
  try {
    const { id, txId } = req.params;

    await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id, tenantId: req.tenantId! },
      });
      if (!project) throw new ApiError(404, 'Project not found');
      if (project.isLocked) throw new ApiError(400, 'Cannot modify expenses on a locked project');

      const transaction = await tx.transaction.findFirst({
        where: { id: txId, projectId: id, tenantId: req.tenantId!, type: 'EXPENSE', isAutomatic: true, moduleRef: 'projects' },
      });
      if (!transaction) throw new ApiError(404, 'Expense not found');

      const amount = Number(transaction.amount);

      // Reverse from company balance
      await reverseExpense(req.tenantId!, amount, tx);

      // Update project spending
      const spentAmount = getProjectSpentAmount(project);
      const availableBudget = getProjectBudgetLimit(project);
      const newSpentAmount = Math.max(0, spentAmount - amount);
      await tx.project.update({
        where: { id: project.id },
        data: {
          spent: { decrement: amount as any },
          spentAmount: newSpentAmount as any,
          remainingBudget: Math.max(0, availableBudget - newSpentAmount) as any,
        },
      });

      await tx.transaction.delete({ where: { id: txId } });
    });

    void logAudit({
      tenantId: req.tenantId!,
      actorType: req.user?.accountType === 'owner' ? AuditActorType.OWNER : AuditActorType.EMPLOYEE,
      actorId: req.user?.id,
      action: 'PROJECT_EXPENSE_DELETED',
      module: 'projects',
      entityType: 'Transaction',
      entityId: txId,
      details: { projectId: id },
      ...extractRequestContext(req),
    });

    return res.json({ success: true, message: 'Expense removed successfully' });
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error('Error deleting project expense:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete expense' });
  }
};
