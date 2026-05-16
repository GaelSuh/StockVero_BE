import { prisma } from '../db.js';
import { sendNotification } from '../services/notificationService.js';
import { getProjectSpecificRecipients } from '../utils/projectRecipients.js';
import { logAudit, AuditActorType } from '../services/auditService.js';
export async function runProjectDueDateCheck() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    let projectCount = 0;
    let phaseCount = 0;
    let totalNotified = 0;
    // ── Projects due today or overdue ─────────────────────────────────────────
    const projects = await prisma.project.findMany({
        where: {
            dueDate: { not: null, lt: tomorrowStart },
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
            isLocked: false,
        },
        select: {
            id: true,
            name: true,
            tenantId: true,
            dueDate: true,
        },
    });
    for (const project of projects) {
        projectCount++;
        try {
            const daysOverdue = Math.floor((todayStart.getTime() - project.dueDate.getTime()) / (1000 * 60 * 60 * 24));
            let type;
            let title;
            let message;
            if (daysOverdue === 0) {
                type = 'project.due_today';
                title = 'Project Due Today';
                message = `Project '${project.name}' is due today. Please ensure all work is completed and update the project status.`;
            }
            else if (daysOverdue === 1) {
                type = 'project.overdue';
                title = 'Project Overdue — 1 Day';
                message = `Project '${project.name}' was due yesterday and is not yet completed. Please update the project status or contact your project manager.`;
            }
            else {
                type = 'project.overdue';
                title = `Project Overdue — ${daysOverdue} Days`;
                message = `Project '${project.name}' is ${daysOverdue} days overdue and has not been completed or cancelled. Immediate attention is required.`;
            }
            const recipients = await getProjectSpecificRecipients(project.id);
            await Promise.all(recipients.map((r) => sendNotification({
                tenantId: project.tenantId,
                userId: r.id,
                userType: r.type,
                type,
                title,
                message,
                link: `/projects/${project.id}`,
            })));
            totalNotified += recipients.length;
            console.log(`[ProjectDueDates] Project '${project.name}' (${project.tenantId}): ${daysOverdue === 0 ? 'due today' : `${daysOverdue} days overdue`} — notified ${recipients.length} users.`);
        }
        catch (err) {
            console.error(`[ProjectDueDates] Failed to process project '${project.name}':`, err);
        }
    }
    // ── Phases due today or overdue ───────────────────────────────────────────
    const phases = await prisma.projectMilestone.findMany({
        where: {
            endDate: { not: null, lt: tomorrowStart },
            status: { notIn: ['COMPLETED', 'SKIPPED'] },
            project: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        },
        select: {
            id: true,
            name: true,
            endDate: true,
            status: true,
            project: { select: { id: true, name: true, tenantId: true } },
        },
    });
    for (const phase of phases) {
        phaseCount++;
        try {
            const daysOverdue = Math.floor((todayStart.getTime() - phase.endDate.getTime()) / (1000 * 60 * 60 * 24));
            let type;
            let title;
            let message;
            if (daysOverdue === 0) {
                type = 'project.phase.due_today';
                title = 'Phase Due Today';
                message = `Phase '${phase.name}' in project '${phase.project.name}' is due today and is not yet completed.`;
            }
            else {
                type = 'project.phase.overdue';
                title = `Phase Overdue — ${daysOverdue} Day(s)`;
                message = `Phase '${phase.name}' in project '${phase.project.name}' is ${daysOverdue} day(s) overdue. Current status: ${phase.status}.`;
            }
            const recipients = await getProjectSpecificRecipients(phase.project.id);
            await Promise.all(recipients.map((r) => sendNotification({
                tenantId: phase.project.tenantId,
                userId: r.id,
                userType: r.type,
                type,
                title,
                message,
                link: `/projects/${phase.project.id}`,
            })));
            totalNotified += recipients.length;
            console.log(`[ProjectDueDates] Phase '${phase.name}' in '${phase.project.name}': ${daysOverdue === 0 ? 'due today' : `${daysOverdue}d overdue`} — notified ${recipients.length} users.`);
        }
        catch (err) {
            console.error(`[ProjectDueDates] Failed to process phase '${phase.name}' in '${phase.project.name}':`, err);
        }
    }
    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`[ProjectDueDates] Job complete. Projects checked: ${projectCount}. Phases checked: ${phaseCount}. Total notifications sent: ${totalNotified}.`);
    // Collect unique tenantIds from processed projects and phases to write one audit entry per tenant
    const tenantIds = [
        ...new Set([
            ...projects.map((p) => p.tenantId),
        ]),
    ];
    for (const tenantId of tenantIds) {
        void logAudit({
            tenantId,
            actorType: AuditActorType.SYSTEM,
            action: 'DUE_DATE_NOTIFICATIONS_SENT',
            module: 'system',
            details: { projectsChecked: projectCount, phasesChecked: phaseCount, notificationsSent: totalNotified },
        });
    }
}
