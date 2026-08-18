import { prisma } from '../db.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DependencyItem {
  module: string;      // e.g. "Projects", "Finance", "Invoices"
  description: string; // e.g. "Used in 3 active project materials"
  count: number;
  action: string;      // What the user must do first
  isWarning?: boolean; // true = informational only, does not block deletion
  links?: { id: string; label: string; route: string }[]; // Up to 5 specific records
}

export interface DependencyReport {
  canDelete: boolean;
  dependencies: DependencyItem[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmount(amount: number): string {
  return new Intl.NumberFormat('fr-CM', { minimumFractionDigits: 0 }).format(Math.round(amount));
}

function isBlocked(deps: DependencyItem[]): boolean {
  return deps.some(d => !d.isWarning);
}

// ── Inventory Category ────────────────────────────────────────────────────────

export async function checkInventoryCategoryDependencies(
  categoryId: string,
  tenantId: string,
): Promise<DependencyReport> {
  const deps: DependencyItem[] = [];

  // 1. Active project materials
  const activeMaterials = await (prisma as any).projectMaterial.findMany({
    where: {
      categoryId,
      tenantId,
      project: { status: { notIn: ['CANCELLED'] } },
    },
    include: { project: { select: { id: true, name: true } } },
    take: 5,
  });

  if (activeMaterials.length > 0) {
    // De-duplicate by project
    const seen = new Set<string>();
    const uniqueProjects: { id: string; name: string }[] = [];
    for (const m of activeMaterials) {
      if (!seen.has(m.project.id)) {
        seen.add(m.project.id);
        uniqueProjects.push(m.project);
      }
    }
    // Get real total count
    const totalProjects = await (prisma as any).projectMaterial.groupBy({
      by: ['projectId'],
      where: {
        categoryId,
        tenantId,
        project: { status: { notIn: ['CANCELLED'] } },
      },
      _count: true,
    });
    deps.push({
      module: 'Projects',
      description: `Used in ${totalProjects.length} active project(s) as material`,
      count: totalProjects.length,
      action: 'Remove this product from those projects first',
      links: uniqueProjects.slice(0, 5).map(p => ({
        id: p.id,
        label: p.name,
        route: `/projects/${p.id}`,
      })),
    });
  }

  // 2. Pending or Approved purchase invoices
  const pendingInvoiceCount = await (prisma as any).invoice.count({
    where: {
      categoryId,
      tenantId,
      type: 'PURCHASE',
      status: { in: ['PENDING', 'APPROVED'] },
    },
  });
  if (pendingInvoiceCount > 0) {
    deps.push({
      module: 'Invoices',
      description: `Has ${pendingInvoiceCount} pending or approved purchase invoice(s)`,
      count: pendingInvoiceCount,
      action: 'Resolve those invoices first',
    });
  }

  // 3. Serialised units.
  //    Any unit at all blocks deletion — the database refuses to drop a product
  //    that units still point at, and the single-delete endpoint has always
  //    rejected this case. Deployed units get the more specific message.
  const [totalUnits, deployedCount] = await Promise.all([
    (prisma as any).productItem.count({ where: { categoryId, tenantId } }),
    (prisma as any).productItem.count({
      where: {
        categoryId,
        tenantId,
        OR: [{ stockStatus: 'DEPLOYED' }, { inventoryStatus: 'IN_USE' }],
      },
    }),
  ]);

  if (deployedCount > 0) {
    deps.push({
      module: 'Inventory',
      description: `${deployedCount} unit(s) are currently deployed or in use on projects`,
      count: deployedCount,
      action: 'Return them first',
    });
  } else if (totalUnits > 0) {
    deps.push({
      module: 'Inventory',
      description: `${totalUnits} serialised unit(s) are recorded against this product`,
      count: totalUnits,
      action: 'Delete those units first',
    });
  }

  // 4. Sold on retail or wholesale sales.
  //    A sale line points at this product, so deleting it would break the sale
  //    record (and the database's foreign key refuses it outright). The sale has
  //    to be cancelled or deleted before the product can go.
  const soldLines = await (prisma as any).saleItem.findMany({
    where: { categoryId, sale: { tenantId } },
    select: {
      quantity: true,
      sale: { select: { id: true, saleNumber: true, mode: true } },
    },
    orderBy: { id: 'desc' },
    take: 5,
  });

  if (soldLines.length > 0) {
    const [saleCount, unitsSold] = await Promise.all([
      (prisma as any).saleItem
        .groupBy({ by: ['saleId'], where: { categoryId, sale: { tenantId } }, _count: true })
        .then((rows: any[]) => rows.length),
      (prisma as any).saleItem
        .aggregate({ where: { categoryId, sale: { tenantId } }, _sum: { quantity: true } })
        .then((r: any) => Number(r._sum?.quantity ?? 0)),
    ]);

    deps.push({
      module: 'Sales',
      description: `Sold on ${saleCount} sale(s) — ${unitsSold} unit(s) in total`,
      count: saleCount,
      action: 'Delete or cancel those sales before removing this product',
      links: soldLines
        .filter((line: any) => line.sale)
        .slice(0, 5)
        .map((line: any) => ({
          id: line.sale.id,
          label: line.sale.saleNumber,
          route: `/${line.sale.mode === 'RETAIL' ? 'retail-sales' : 'wholesale-sales'}/${line.sale.id}`,
        })),
    });
  }

  // 5. Referenced by wholesale price lists
  const priceRuleCount = await (prisma as any).priceRule.count({
    where: { categoryId, priceList: { tenantId } },
  });
  if (priceRuleCount > 0) {
    deps.push({
      module: 'Price Lists',
      description: `Priced on ${priceRuleCount} price list rule(s)`,
      count: priceRuleCount,
      action: 'Remove it from those price lists first',
    });
  }

  // 6. Recorded against a customer's purchase history
  const purchaseCount = await (prisma as any).customerPurchase.count({
    where: { inventoryCategoryId: categoryId, tenantId },
  });
  if (purchaseCount > 0) {
    deps.push({
      module: 'Customers',
      description: `Appears in ${purchaseCount} customer purchase record(s)`,
      count: purchaseCount,
      action: 'Remove those purchase records first',
    });
  }

  return { canDelete: !isBlocked(deps), dependencies: deps };
}

/**
 * Runs the same check over many products at once, for the bulk-delete preview.
 * Kept sequential-per-id on purpose: each report is a handful of small counts and
 * a selection is capped well below the point where this matters.
 */
export async function checkInventoryCategoriesDependencies(
  categoryIds: string[],
  tenantId: string,
): Promise<Map<string, DependencyReport>> {
  const reports = new Map<string, DependencyReport>();
  const results = await Promise.all(
    categoryIds.map(async (id) => ({
      id,
      report: await checkInventoryCategoryDependencies(id, tenantId),
    })),
  );
  for (const { id, report } of results) reports.set(id, report);
  return reports;
}

// ── Inventory Product Item ────────────────────────────────────────────────────

export async function checkProductItemDependencies(
  itemId: string,
  tenantId: string,
): Promise<DependencyReport> {
  const deps: DependencyItem[] = [];

  const item = await (prisma as any).productItem.findFirst({
    where: { id: itemId, tenantId },
    select: { stockStatus: true, inventoryStatus: true, projectId: true },
  });

  if (!item) return { canDelete: false, dependencies: [] };

  const isDeployed = item.stockStatus === 'DEPLOYED' || item.inventoryStatus === 'IN_USE';
  const isUnderMaintenance = item.stockStatus === 'UNDER_MAINTENANCE' || item.inventoryStatus === 'UNDER_MAINTENANCE';

  if (isDeployed && item.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: item.projectId, tenantId },
      select: { id: true, name: true },
    });
    deps.push({
      module: 'Projects',
      description: 'This unit is currently deployed on a project',
      count: 1,
      action: 'Return it from the project first',
      links: project ? [{ id: project.id, label: project.name, route: `/projects/${project.id}` }] : [],
    });
  } else if (isUnderMaintenance) {
    deps.push({
      module: 'Maintenance',
      description: 'This unit is currently under maintenance',
      count: 1,
      action: 'Complete or cancel the maintenance first',
    });
  }

  return { canDelete: !isBlocked(deps), dependencies: deps };
}

// ── Project ───────────────────────────────────────────────────────────────────

export async function checkProjectDependencies(
  projectId: string,
  tenantId: string,
): Promise<DependencyReport> {
  const deps: DependencyItem[] = [];

  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId },
    select: { status: true, name: true },
  });

  if (!project) return { canDelete: false, dependencies: [] };

  // Blocker: only CANCELLED projects can be hard-deleted
  if (project.status !== 'CANCELLED') {
    const statusLabel =
      project.status === 'COMPLETED'   ? 'Completed' :
      project.status === 'IN_PROGRESS' ? 'In Progress' :
      project.status === 'TESTING'     ? 'Testing' :
      project.status === 'PENDING'     ? 'Pending' : String(project.status);
    deps.push({
      module: 'Project Status',
      description: `This project is currently "${statusLabel}" and cannot be deleted`,
      count: 1,
      action: 'Change the project status to Cancelled before deleting',
    });
  }

  // Warning: approved invoice payments (not a hard blocker)
  const approvedInvoices = await (prisma as any).invoice.findMany({
    where: {
      projectId,
      tenantId,
      type: 'PROJECT',
      status: 'APPROVED',
      totalApproved: { gt: 0 },
    },
    select: { id: true, invoiceNumber: true, totalApproved: true },
  });

  if (approvedInvoices.length > 0) {
    const total = approvedInvoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.totalApproved ?? 0),
      0,
    );
    deps.push({
      module: 'Finance',
      description: `This project has ${approvedInvoices.length} approved payment(s) totalling ${fmtAmount(total)} XAF`,
      count: approvedInvoices.length,
      action: 'Deleting will not reverse those finance transactions — they will be preserved in the audit trail',
      isWarning: true,
    });
  }

  return { canDelete: !isBlocked(deps), dependencies: deps };
}

// ── Customer ──────────────────────────────────────────────────────────────────

export async function checkCustomerDependencies(
  customerId: string,
  tenantId: string,
): Promise<DependencyReport> {
  const deps: DependencyItem[] = [];

  // Blocker: active projects
  const activeProjects = await prisma.project.findMany({
    where: {
      customerId,
      tenantId,
      status: { notIn: ['COMPLETED', 'CANCELLED'] },
    },
    select: { id: true, name: true },
    take: 5,
  });

  if (activeProjects.length > 0) {
    const totalCount = await prisma.project.count({
      where: { customerId, tenantId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
    });
    deps.push({
      module: 'Projects',
      description: `This customer has ${totalCount} active project(s)`,
      count: totalCount,
      action: 'Complete or cancel those projects first',
      links: activeProjects.map(p => ({
        id: p.id,
        label: p.name,
        route: `/projects/${p.id}`,
      })),
    });
  }

  // Warning: payment invoices (preserved, not deleted)
  const paymentInvoiceCount = await (prisma as any).invoice.count({
    where: { customerId, tenantId, type: 'PAYMENT' },
  });
  if (paymentInvoiceCount > 0) {
    deps.push({
      module: 'Finance',
      description: `Has ${paymentInvoiceCount} payment invoice(s) recorded`,
      count: paymentInvoiceCount,
      action: 'Deleting this customer will not remove those financial records — they will be preserved',
      isWarning: true,
    });
  }

  return { canDelete: !isBlocked(deps), dependencies: deps };
}

// ── Transaction ───────────────────────────────────────────────────────────────

export async function checkTransactionDependencies(
  transactionId: string,
  tenantId: string,
): Promise<DependencyReport> {
  const deps: DependencyItem[] = [];

  const transaction = await prisma.transaction.findFirst({
    where: { id: transactionId, tenantId },
    select: { isAutomatic: true },
  });

  if (!transaction) return { canDelete: false, dependencies: [] };

  if (transaction.isAutomatic) {
    deps.push({
      module: 'System',
      description: 'This transaction was automatically generated by the system and cannot be deleted',
      count: 1,
      action: 'It is part of the financial audit trail',
    });
  }

  const linkedPayment = await (prisma as any).invoicePayment.findFirst({
    where: { transactionId, tenantId },
    select: { id: true },
  });
  if (linkedPayment) {
    deps.push({
      module: 'Invoices',
      description: 'This transaction is linked to an approved invoice payment',
      count: 1,
      action: 'Deleting it will create inconsistency in the financial records',
    });
  }

  return { canDelete: !isBlocked(deps), dependencies: deps };
}

// ── Invoice ───────────────────────────────────────────────────────────────────

export async function checkInvoiceDependencies(
  invoiceId: string,
  tenantId: string,
): Promise<DependencyReport> {
  const deps: DependencyItem[] = [];

  const invoice = await (prisma as any).invoice.findFirst({
    where: { id: invoiceId, tenantId },
    select: { status: true },
  });

  if (!invoice) return { canDelete: false, dependencies: [] };

  if (['APPROVED', 'PAID'].includes(invoice.status)) {
    deps.push({
      module: 'Finance',
      description: "This invoice has been approved and affects the company's financial balance",
      count: 1,
      action: 'Approved and paid invoices cannot be deleted',
    });
  } else {
    const hasPayments = await (prisma as any).invoicePayment.findFirst({
      where: { invoiceId, tenantId },
      select: { id: true },
    });
    if (hasPayments) {
      deps.push({
        module: 'Finance',
        description: 'This invoice has payment records linked to it',
        count: 1,
        action: 'Remove linked payments first',
      });
    }
  }

  return { canDelete: !isBlocked(deps), dependencies: deps };
}

// ── Document ──────────────────────────────────────────────────────────────────

export async function checkDocumentDependencies(
  _documentId: string,
  _tenantId: string,
): Promise<DependencyReport> {
  // Documents have no downstream dependencies
  return { canDelete: true, dependencies: [] };
}

// ── Employee ──────────────────────────────────────────────────────────────────

export async function checkEmployeeDependencies(
  employeeId: string,
  tenantId: string,
): Promise<DependencyReport> {
  const deps: DependencyItem[] = [];

  // Blocker: assigned to active projects
  const activeAssignments = await prisma.projectAssignment.findMany({
    where: {
      employeeId,
      tenantId,
      project: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
    },
    include: { project: { select: { id: true, name: true } } },
    take: 5,
  });

  if (activeAssignments.length > 0) {
    const totalCount = await prisma.projectAssignment.count({
      where: {
        employeeId,
        tenantId,
        project: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      },
    });
    deps.push({
      module: 'Projects',
      description: `Assigned as technician on ${totalCount} active project(s)`,
      count: totalCount,
      action: 'Reassign those projects first',
      links: activeAssignments.map(a => ({
        id: a.project.id,
        label: a.project.name,
        route: `/projects/${a.project.id}`,
      })),
    });
  }

  // Warning: audit log entries
  const auditCount = await (prisma as any).auditLog.count({
    where: { tenantId, actorId: employeeId },
  });
  if (auditCount > 0) {
    deps.push({
      module: 'Audit',
      description: `This employee has ${auditCount} entries in the audit log. Their audit history will be preserved`,
      count: auditCount,
      action: '',
      isWarning: true,
    });
  }

  return { canDelete: !isBlocked(deps), dependencies: deps };
}

// ── Role ──────────────────────────────────────────────────────────────────────

export async function checkRoleDependencies(
  roleId: string,
  tenantId: string,
): Promise<DependencyReport> {
  const deps: DependencyItem[] = [];

  const employees = await prisma.employee.findMany({
    where: { roleId, tenantId },
    select: { id: true, firstName: true, lastName: true },
    take: 5,
  });

  if (employees.length > 0) {
    const totalCount = await prisma.employee.count({ where: { roleId, tenantId } });
    deps.push({
      module: 'Employees',
      description: `This role is assigned to ${totalCount} employee(s)`,
      count: totalCount,
      action: 'Reassign those employees to a different role first',
      links: employees.map(e => ({
        id: e.id,
        label: `${e.firstName} ${e.lastName}`,
        route: `/settings/employees/${e.id}`,
      })),
    });
  }

  return { canDelete: !isBlocked(deps), dependencies: deps };
}
