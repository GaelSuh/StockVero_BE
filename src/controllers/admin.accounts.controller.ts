/**
 * Account management for Digisol staff: account owner, notes log, follow-ups.
 * Every create, assign, edit and delete is written to the per-tenant admin audit log
 * (tenant_audit_logs via logAuditAction).
 *
 * TODO(admin-roles): restrict assigning account owners (single and bulk) to the owner role;
 * notes and follow-ups stay open to every admin who can see the tenant.
 */
import { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AdminRequest } from '../types/index.js';
import { logAuditAction } from '../services/audit.service.js';
import { doualaToday, isDay } from '../services/tenantMetrics.service.js';

const adminSelect = { id: true, firstName: true, lastName: true, email: true } as const;
const fail = (res: Response, status: number, message: string) => res.status(status).json({ success: false, message });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function tenantExists(id: string) {
  return prisma.tenant.findUnique({ where: { id }, select: { id: true, accountOwnerId: true } });
}

// ── account owner ───────────────────────────────────────────────────────────

const OwnerSchema = z.object({ adminId: z.string().min(1).nullable() });
const BulkOwnerSchema = z.object({ tenantIds: z.array(z.string().min(1)).min(1).max(200), adminId: z.string().min(1).nullable() });

async function adminExists(id: string | null) {
  return id === null || Boolean(await prisma.superAdmin.findUnique({ where: { id }, select: { id: true } }));
}

/** PATCH /tenants/:id/account-owner  { adminId | null } */
export const setAccountOwner = async (req: AdminRequest, res: Response) => {
  const parsed = OwnerSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');
  try {
    const tenant = await tenantExists(req.params.id);
    if (!tenant) return fail(res, 404, 'Tenant not found');
    if (!(await adminExists(parsed.data.adminId))) return fail(res, 400, 'Admin not found');
    const updated = await prisma.tenant.update({
      where: { id: tenant.id }, data: { accountOwnerId: parsed.data.adminId }, select: { id: true, accountOwner: { select: adminSelect } },
    });
    await logAuditAction(req.admin!.id, tenant.id, 'ACCOUNT_OWNER_ASSIGNED', { from: tenant.accountOwnerId, to: parsed.data.adminId, bulk: false });
    return res.status(200).json({ success: true, data: updated });
  } catch (e) {
    console.error('setAccountOwner error:', e);
    return fail(res, 500, `Failed to assign account owner: ${errMsg(e)}`);
  }
};

/** POST /tenants/account-owner/bulk  { tenantIds, adminId | null } */
export const bulkSetAccountOwner = async (req: AdminRequest, res: Response) => {
  const parsed = BulkOwnerSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');
  try {
    if (!(await adminExists(parsed.data.adminId))) return fail(res, 400, 'Admin not found');
    const tenants = await prisma.tenant.findMany({ where: { id: { in: parsed.data.tenantIds } }, select: { id: true, accountOwnerId: true } });
    if (tenants.length !== new Set(parsed.data.tenantIds).size) return fail(res, 404, 'One or more tenants were not found');
    await prisma.$transaction([
      prisma.tenant.updateMany({ where: { id: { in: tenants.map((t) => t.id) } }, data: { accountOwnerId: parsed.data.adminId } }),
      ...tenants.map((t) => prisma.tenantAuditLog.create({
        data: { adminId: req.admin!.id, tenantId: t.id, action: 'ACCOUNT_OWNER_ASSIGNED', details: { from: t.accountOwnerId, to: parsed.data.adminId, bulk: true, batchSize: tenants.length } },
      })),
    ]);
    return res.status(200).json({ success: true, data: { updated: tenants.length, adminId: parsed.data.adminId } });
  } catch (e) {
    console.error('bulkSetAccountOwner error:', e);
    return fail(res, 500, `Failed to assign account owner: ${errMsg(e)}`);
  }
};

// ── notes ───────────────────────────────────────────────────────────────────

const NoteSchema = z.object({ body: z.string().trim().min(1, 'Note cannot be empty').max(5000) });

const noteOut = (n: { id: string; body: string; createdAt: Date; migratedFromLegacy: boolean; author: { id: string; firstName: string; lastName: string; email: string } | null }, me: string) => ({
  id: n.id, body: n.body, createdAt: n.createdAt, migratedFromLegacy: n.migratedFromLegacy,
  author: n.author, canDelete: n.author?.id === me,
});

/** GET /tenants/:id/notes (newest first) */
export const listNotes = async (req: AdminRequest, res: Response) => {
  try {
    const notes = await prisma.tenantNote.findMany({
      where: { tenantId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 200, include: { author: { select: adminSelect } },
    });
    return res.status(200).json({ success: true, data: notes.map((n) => noteOut(n, req.admin!.id)) });
  } catch (e) {
    console.error('listNotes error:', e);
    return fail(res, 500, `Failed to load notes: ${errMsg(e)}`);
  }
};

/** POST /tenants/:id/notes  { body } */
export const addNote = async (req: AdminRequest, res: Response) => {
  const parsed = NoteSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');
  try {
    if (!(await tenantExists(req.params.id))) return fail(res, 404, 'Tenant not found');
    const note = await prisma.tenantNote.create({
      data: { tenantId: req.params.id, authorId: req.admin!.id, body: parsed.data.body }, include: { author: { select: adminSelect } },
    });
    await logAuditAction(req.admin!.id, req.params.id, 'NOTE_ADDED', { noteId: note.id, length: note.body.length });
    return res.status(201).json({ success: true, data: noteOut(note, req.admin!.id) });
  } catch (e) {
    console.error('addNote error:', e);
    return fail(res, 500, `Failed to add note: ${errMsg(e)}`);
  }
};

/** DELETE /tenants/:id/notes/:noteId (own notes only) */
export const deleteNote = async (req: AdminRequest, res: Response) => {
  try {
    const note = await prisma.tenantNote.findFirst({ where: { id: req.params.noteId, tenantId: req.params.id } });
    if (!note) return fail(res, 404, 'Note not found');
    if (note.authorId !== req.admin!.id) return fail(res, 403, 'You can only delete your own notes');
    await prisma.tenantNote.delete({ where: { id: note.id } });
    await logAuditAction(req.admin!.id, req.params.id, 'NOTE_DELETED', { noteId: note.id, length: note.body.length });
    return res.status(200).json({ success: true, data: { id: note.id } });
  } catch (e) {
    console.error('deleteNote error:', e);
    return fail(res, 500, `Failed to delete note: ${errMsg(e)}`);
  }
};

// ── follow-ups ──────────────────────────────────────────────────────────────

const day = z.string().refine(isDay, 'Expected a date as YYYY-MM-DD');
const CreateFollowUpSchema = z.object({ title: z.string().trim().min(1).max(200), dueDay: day, assigneeId: z.string().min(1).optional() });
const UpdateFollowUpSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(), dueDay: day.optional(), assigneeId: z.string().min(1).optional(),
  status: z.enum(['OPEN', 'DONE']).optional(),
}).refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const followUpInclude = { assignee: { select: adminSelect }, createdBy: { select: adminSelect }, tenant: { select: { id: true, name: true } } } as const;
type FollowUpRow = Awaited<ReturnType<typeof prisma.tenantFollowUp.findFirstOrThrow<{ include: typeof followUpInclude }>>>;
const followUpOut = (f: FollowUpRow, today: string) => {
  const due = f.dueDay.toISOString().slice(0, 10);
  return {
    id: f.id, title: f.title, dueDay: due, status: f.status, assignee: f.assignee, createdBy: f.createdBy, tenant: f.tenant,
    completedAt: f.completedAt, createdAt: f.createdAt,
    overdue: f.status === 'OPEN' && due < today, dueToday: f.status === 'OPEN' && due === today,
  };
};

/** GET /tenants/:id/follow-ups (open first, then by due day) */
export const listTenantFollowUps = async (req: AdminRequest, res: Response) => {
  try {
    const today = doualaToday();
    const rows = await prisma.tenantFollowUp.findMany({
      where: { tenantId: req.params.id }, include: followUpInclude, orderBy: [{ status: 'desc' }, { dueDay: 'asc' }], take: 200,
    });
    return res.status(200).json({ success: true, data: rows.map((f) => followUpOut(f, today)), meta: { today } });
  } catch (e) {
    console.error('listTenantFollowUps error:', e);
    return fail(res, 500, `Failed to load follow-ups: ${errMsg(e)}`);
  }
};

/** POST /tenants/:id/follow-ups  { title, dueDay, assigneeId? (default: me) } */
export const createFollowUp = async (req: AdminRequest, res: Response) => {
  const parsed = CreateFollowUpSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');
  try {
    if (!(await tenantExists(req.params.id))) return fail(res, 404, 'Tenant not found');
    const assigneeId = parsed.data.assigneeId ?? req.admin!.id;
    if (!(await adminExists(assigneeId))) return fail(res, 400, 'Assignee not found');
    const f = await prisma.tenantFollowUp.create({
      data: { tenantId: req.params.id, title: parsed.data.title, dueDay: new Date(`${parsed.data.dueDay}T00:00:00Z`), assigneeId, createdById: req.admin!.id },
      include: followUpInclude,
    });
    await logAuditAction(req.admin!.id, req.params.id, 'FOLLOW_UP_CREATED', { followUpId: f.id, title: f.title, dueDay: parsed.data.dueDay, assigneeId });
    return res.status(201).json({ success: true, data: followUpOut(f, doualaToday()) });
  } catch (e) {
    console.error('createFollowUp error:', e);
    return fail(res, 500, `Failed to create follow-up: ${errMsg(e)}`);
  }
};

/** PATCH /follow-ups/:id  { title?, dueDay?, assigneeId?, status? } */
export const updateFollowUp = async (req: AdminRequest, res: Response) => {
  const parsed = UpdateFollowUpSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');
  try {
    const existing = await prisma.tenantFollowUp.findUnique({ where: { id: req.params.id } });
    if (!existing) return fail(res, 404, 'Follow-up not found');
    const p = parsed.data;
    if (p.assigneeId && !(await adminExists(p.assigneeId))) return fail(res, 400, 'Assignee not found');
    const completing = p.status === 'DONE' && existing.status !== 'DONE';
    const reopening = p.status === 'OPEN' && existing.status === 'DONE';
    const f = await prisma.tenantFollowUp.update({
      where: { id: existing.id },
      data: {
        ...(p.title !== undefined && { title: p.title }),
        ...(p.dueDay !== undefined && { dueDay: new Date(`${p.dueDay}T00:00:00Z`) }),
        ...(p.assigneeId !== undefined && { assigneeId: p.assigneeId }),
        ...(p.status !== undefined && { status: p.status }),
        ...(completing && { completedAt: new Date(), completedById: req.admin!.id }),
        ...(reopening && { completedAt: null, completedById: null }),
      },
      include: followUpInclude,
    });
    const action = completing ? 'FOLLOW_UP_COMPLETED' : reopening ? 'FOLLOW_UP_REOPENED' : 'FOLLOW_UP_UPDATED';
    await logAuditAction(req.admin!.id, existing.tenantId, action, { followUpId: f.id, changes: p });
    return res.status(200).json({ success: true, data: followUpOut(f, doualaToday()) });
  } catch (e) {
    console.error('updateFollowUp error:', e);
    return fail(res, 500, `Failed to update follow-up: ${errMsg(e)}`);
  }
};

/** DELETE /follow-ups/:id */
export const deleteFollowUp = async (req: AdminRequest, res: Response) => {
  try {
    const existing = await prisma.tenantFollowUp.findUnique({ where: { id: req.params.id } });
    if (!existing) return fail(res, 404, 'Follow-up not found');
    await prisma.tenantFollowUp.delete({ where: { id: existing.id } });
    await logAuditAction(req.admin!.id, existing.tenantId, 'FOLLOW_UP_DELETED', { followUpId: existing.id, title: existing.title });
    return res.status(200).json({ success: true, data: { id: existing.id } });
  } catch (e) {
    console.error('deleteFollowUp error:', e);
    return fail(res, 500, `Failed to delete follow-up: ${errMsg(e)}`);
  }
};

/** GET /follow-ups/due?scope=mine|all : open follow-ups due today or overdue (Douala day). */
export const listDueFollowUps = async (req: AdminRequest, res: Response) => {
  const scope = req.query.scope === 'all' ? 'all' : 'mine';
  try {
    const today = doualaToday();
    const rows = await prisma.tenantFollowUp.findMany({
      where: { status: 'OPEN', dueDay: { lte: new Date(`${today}T00:00:00Z`) }, ...(scope === 'mine' && { assigneeId: req.admin!.id }) },
      include: followUpInclude, orderBy: { dueDay: 'asc' }, take: 100,
    });
    const data = rows.map((f) => followUpOut(f, today));
    return res.status(200).json({
      success: true, data, meta: { today, scope, overdue: data.filter((d) => d.overdue).length, dueToday: data.filter((d) => d.dueToday).length },
    });
  } catch (e) {
    console.error('listDueFollowUps error:', e);
    return fail(res, 500, `Failed to load due follow-ups: ${errMsg(e)}`);
  }
};
