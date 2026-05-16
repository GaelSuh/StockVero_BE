import { prisma } from '../db.js';
export async function getProjectAccessRecipients(tenantId) {
    const [owner, employees] = await Promise.all([
        prisma.user.findFirst({
            where: { tenantId, role: 'CLIENT_OWNER', isActive: true },
            select: { id: true },
        }),
        prisma.employee.findMany({
            where: {
                tenantId,
                isActive: true,
                role: {
                    permissions: {
                        some: { moduleKey: 'projects', canRead: true },
                    },
                },
            },
            select: { id: true },
        }),
    ]);
    return [
        ...(owner ? [{ id: owner.id, type: 'OWNER' }] : []),
        ...employees.map((e) => ({ id: e.id, type: 'EMPLOYEE' })),
    ];
}
/**
 * Returns recipients specifically assigned to a project via ProjectAssignment records.
 * Falls back to all project-module users if no explicit assignments exist.
 */
export async function getProjectSpecificRecipients(projectId) {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { tenantId: true, id: true },
    });
    if (!project)
        return [];
    // Get explicitly assigned employees
    const assignments = await prisma.projectAssignment.findMany({
        where: { projectId },
        select: { employeeId: true },
    });
    // If no explicit assignments, fall back to all users with project module access
    if (assignments.length === 0) {
        return getProjectAccessRecipients(project.tenantId);
    }
    const owner = await prisma.user.findFirst({
        where: { tenantId: project.tenantId, role: 'CLIENT_OWNER', isActive: true },
        select: { id: true },
    });
    const assignedEmployeeIds = assignments.map((a) => a.employeeId);
    return [
        ...(owner ? [{ id: owner.id, type: 'OWNER' }] : []),
        ...assignedEmployeeIds.map((id) => ({ id, type: 'EMPLOYEE' })),
    ];
}
