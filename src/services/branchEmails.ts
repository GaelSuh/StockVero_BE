import { prismaUnscoped as db } from '../db.js';
import { appLink, sendEmail } from './emailService.js';
import { branchApproved, branchRejected, branchRequested } from '../emails/templates.js';

/**
 * Emails about a branch's approval go to the company's owners and to whoever
 * created the branch (read from its BRANCH_CREATED audit entry), once each.
 */
async function recipients(tenantId: string, branchId: string, creator?: { id: string; type: 'owner' | 'employee' }) {
  const [owners, created] = await Promise.all([
    db.user.findMany({ where: { tenantId, isActive: true }, select: { email: true, firstName: true } }),
    creator
      ? Promise.resolve(creator)
      : db.auditLog
          .findFirst({ where: { tenantId, action: 'BRANCH_CREATED', entityId: branchId }, select: { actorId: true, actorType: true } })
          .then((a) => (a?.actorId ? { id: a.actorId, type: a.actorType === 'EMPLOYEE' ? ('employee' as const) : ('owner' as const) } : null)),
  ]);
  const people = [...owners];
  if (created?.type === 'employee') {
    const e = await db.employee.findUnique({ where: { id: created.id }, select: { email: true, firstName: true } });
    if (e) people.push(e);
  }
  const seen = new Set<string>();
  return people.filter((p) => p.email && !seen.has(p.email.toLowerCase()) && seen.add(p.email.toLowerCase()));
}

type Event =
  | { kind: 'requested'; creator: { id: string; type: 'owner' | 'employee' } }
  | { kind: 'approved' }
  | { kind: 'rejected'; reason: string };

/** Fire and forget: an email that fails to send never blocks the branch change. */
export function emailBranchEvent(branchId: string, event: Event): void {
  void (async () => {
    const branch = await db.branch.findUnique({
      where: { id: branchId },
      select: { name: true, tenantId: true, tenant: { select: { name: true } } },
    });
    if (!branch) return;
    const who = await recipients(branch.tenantId, branchId, event.kind === 'requested' ? event.creator : undefined);
    const base = { orgName: branch.tenant.name, branchName: branch.name };
    await Promise.all(
      who.map((p) => {
        const name = p.firstName || 'there';
        if (event.kind === 'requested') {
          return sendEmail({ to: p.email, subject: `Your new branch ${branch.name} is waiting for approval`, html: branchRequested({ name, ...base }) });
        }
        if (event.kind === 'approved') {
          return sendEmail({ to: p.email, subject: `Your branch ${branch.name} has been approved`, html: branchApproved({ name, ...base, loginUrl: appLink('/login') }) });
        }
        return sendEmail({ to: p.email, subject: `Update on your branch ${branch.name}`, html: branchRejected({ name, ...base, reason: event.reason }) });
      }),
    );
  })().catch((error) => console.error('[branchEmails] failed:', error));
}
