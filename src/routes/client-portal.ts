import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, ne, sql, sum } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  calendarReservations,
  clients,
  contentPosts,
  documents,
  documentFolders,
  postComments,
  postMedia,
  projectMembers,
  projectMilestones,
  projectTasks,
  taskAssignees,
  projects,
  users,
  proposals,
  agreements,
  invoices,
  invoiceItems,
  invoicePayments,
  socialAccounts,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { badRequest, conflict, invalidState, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { audit } from '../services/audit.js';
import { notifyPermissionHolders } from '../services/notifications.js';
import { signDocumentUpload } from '../services/storage.js';
import { uploadOrigin } from '../services/local-storage.js';
import { authenticate, getActor, requires } from '../authz/http.js';
import { authorize, can, capabilities, check, type ObjectFacts } from '../authz/engine.js';
import { actorAuditId, type ClientSideActor } from '../authz/actor.js';
import { assertAgencyStorageKey } from '../authz/tenancy.js';
import {
  agreementSignable,
  allowedProjectIds,
  assertPostDecidable,
  clientFileFilter,
  clientPostFilter,
  clientProjectFacts,
  clientRowFilter,
  holdsClientPermission,
  loadClientAgreement,
  loadClientFolder,
  loadClientInvoice,
  loadClientPost,
  loadClientProposal,
  portalVisibleStatuses,
  postFactsFromRow,
  proposalRespondable,
  requireClientSide,
} from '../authz/policies/client-portal.js';
import {
  assertAgreementSignable,
  assertProposalRespondable,
  assertSignatureDataUrl,
  redactMoney,
} from '../authz/policies/business.js';
import {
  clientActorDisplayName,
  mirrorClientCommentAsSystem,
  notifyPortalActivity,
} from './portal.js';
import { broadcastPortalRefresh } from '../realtime/io.js';

/**
 * Client-portal API for CLIENT-SIDE actors only: logged-in client users
 * (actor.type 'client') and share-link sessions (actor.type 'portal_link',
 * minted by POST /portal/session). Staff → 403.
 *
 * Every route requires its client permission and evaluates objects with the
 * `client` scope (facts: agencyId, clientId, projectId, clientVisible — see
 * authz/policies/client-portal.ts). A share-link session only holds its link
 * role's grants (e.g. posts.view / post_comments.*), so finance, proposals,
 * agreements and files are 403 for it unless the link role grants them.
 */
export const clientPortalRouter = Router();
clientPortalRouter.use(authenticate);
clientPortalRouter.use((req, _res, next) => {
  try {
    requireClientSide(getActor(req));
    next();
  } catch (err) {
    next(err);
  }
});

function clientActor(req: Request): ClientSideActor {
  return requireClientSide(getActor(req));
}

/** Audit identity for a client-side actor. */
function auditBase(actor: ClientSideActor, req: Request) {
  return {
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    ip: req.ip,
  } as const;
}

/** Parse a stored platforms JSON string into a string[]. */
function safePlatforms(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function safeJson(json: string | null): Record<string, unknown> {
  try {
    const v = json ? JSON.parse(json) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Opaque, stable per-project handle for a staff member: the UI needs a key, but
 * clients never receive internal user ids.
 */
function staffHandle(projectId: string, userId: string): string {
  return `tm_${crypto.createHash('sha256').update(`${projectId}:${userId}`).digest('base64url').slice(0, 16)}`;
}

// 'backlog' was retired from the board (folded into To Do) — not surfaced here.
const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;

/** Map projectId -> { total, done } from a grouped task-status query. */
async function taskCountsByProject(agencyId: string, projectIds: string[]) {
  const map = new Map<string, { total: number; done: number }>();
  if (projectIds.length === 0) return map;
  const rows = await db
    .select({
      projectId: projectTasks.projectId,
      status: projectTasks.status,
      n: sql<number>`count(*)`,
    })
    .from(projectTasks)
    .where(and(eq(projectTasks.agencyId, agencyId), inArray(projectTasks.projectId, projectIds)))
    .groupBy(projectTasks.projectId, projectTasks.status);
  for (const r of rows) {
    const cur = map.get(r.projectId) ?? { total: 0, done: 0 };
    cur.total += Number(r.n);
    if (r.status === 'done') cur.done += Number(r.n);
    map.set(r.projectId, cur);
  }
  return map;
}

// ── GET /client/me — profile + brand + agency branding + scope ──────────────
// Authenticated only (any client-side actor): self-service identity.
clientPortalRouter.get('/me', async (req, res) => {
  const actor = clientActor(req);
  const me =
    actor.type === 'client'
      ? ((
          await db
            .select({ id: users.id, email: users.email, fullName: users.fullName })
            .from(users)
            .where(and(eq(users.id, actor.userId), eq(users.agencyId, actor.agencyId)))
            .limit(1)
        )[0] ?? null)
      : null;
  const [client] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.id, actor.clientId), eq(clients.agencyId, actor.agencyId)))
    .limit(1);
  const [agency] = await db
    .select({ name: agencies.name, logoUrl: agencies.logoUrl, brandColor: agencies.brandColor })
    .from(agencies)
    .where(eq(agencies.id, actor.agencyId))
    .limit(1);
  const allowed = await allowedProjectIds(actor);

  ok(res, {
    user: me,
    link: actor.type === 'portal_link' ? { id: actor.tokenId } : null,
    actorType: actor.type,
    client: client ?? null,
    agency: agency ?? null,
    scope: { allProjects: actor.projectAccess.mode === 'all', projectCount: allowed.length },
    grants: actor.grants.toJSON(),
  });
});

// ── GET /client/projects — projects.view ─────────────────────────────────────
clientPortalRouter.get('/projects', requires('projects.view'), async (req, res) => {
  const actor = clientActor(req);
  const allowed = holdsClientPermission(actor, 'projects.view') ? await allowedProjectIds(actor) : [];
  if (allowed.length === 0) return ok(res, []);

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      health: projects.health,
      deadline: projects.deadline,
      startDate: projects.startDate,
    })
    .from(projects)
    .where(
      and(
        eq(projects.agencyId, actor.agencyId),
        eq(projects.clientId, actor.clientId),
        inArray(projects.id, allowed),
      ),
    )
    .orderBy(desc(projects.createdAt));

  const counts = await taskCountsByProject(actor.agencyId, allowed);
  ok(
    res,
    rows.map((p) => {
      const c = counts.get(p.id) ?? { total: 0, done: 0 };
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        health: p.health,
        deadline: toIso(p.deadline),
        startDate: toIso(p.startDate),
        tasksTotal: c.total,
        tasksDone: c.done,
        progress: c.total === 0 ? 0 : Math.round((c.done / c.total) * 100),
      };
    }),
  );
});

/** Authorize `permission` on the project in :id (404 when not visible). */
async function authorizeProject(req: Request, permission: string): Promise<{ actor: ClientSideActor; projectId: string; facts: ObjectFacts }> {
  const actor = clientActor(req);
  const facts = await clientProjectFacts(actor, param(req, 'id'));
  authorize(actor, permission, facts, permission === 'projects.view' ? {} : { view: 'projects.view' });
  return { actor, projectId: param(req, 'id'), facts: facts! };
}

// ── GET /client/projects/:id — projects.view (assignees need projects.view_team)
clientPortalRouter.get('/projects/:id', requires('projects.view'), async (req, res) => {
  const { actor, projectId, facts } = await authorizeProject(req, 'projects.view');

  const [p] = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      health: projects.health,
      deadline: projects.deadline,
      startDate: projects.startDate,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.agencyId, actor.agencyId)))
    .limit(1);
  if (!p) throw notFound('Project not found.');

  const statusRows = await db
    .select({ status: projectTasks.status, n: sql<number>`count(*)` })
    .from(projectTasks)
    .where(and(eq(projectTasks.agencyId, actor.agencyId), eq(projectTasks.projectId, projectId)))
    .groupBy(projectTasks.status);
  const tasksByStatus: Record<string, number> = {};
  for (const s of TASK_STATUSES) tasksByStatus[s] = 0;
  let total = 0;
  let done = 0;
  for (const r of statusRows) {
    tasksByStatus[r.status] = Number(r.n);
    total += Number(r.n);
    if (r.status === 'done') done += Number(r.n);
  }

  const milestones = await db
    .select({
      id: projectMilestones.id,
      title: projectMilestones.title,
      status: projectMilestones.status,
      dueDate: projectMilestones.dueDate,
    })
    .from(projectMilestones)
    .where(and(eq(projectMilestones.agencyId, actor.agencyId), eq(projectMilestones.projectId, projectId)))
    .orderBy(projectMilestones.position);

  const taskRows = await db
    .select({
      id: projectTasks.id,
      title: projectTasks.title,
      status: projectTasks.status,
      priority: projectTasks.priority,
      dueDate: projectTasks.dueDate,
      position: projectTasks.position,
    })
    .from(projectTasks)
    .where(and(eq(projectTasks.agencyId, actor.agencyId), eq(projectTasks.projectId, projectId)))
    .orderBy(projectTasks.position, projectTasks.createdAt);

  // Assignees (name only, opaque handle) only with projects.view_team.
  const canSeeTeam = check(actor, 'projects.view_team', facts);
  const taskIds = taskRows.map((t) => t.id);
  const assigneesByTask = new Map<string, { id: string; name: string }[]>();
  if (canSeeTeam && taskIds.length) {
    const arows = await db
      .select({ taskId: taskAssignees.taskId, userId: users.id, name: users.fullName })
      .from(taskAssignees)
      .innerJoin(users, eq(users.id, taskAssignees.userId))
      .where(and(eq(taskAssignees.agencyId, actor.agencyId), inArray(taskAssignees.taskId, taskIds)));
    for (const a of arows) {
      const list = assigneesByTask.get(a.taskId) ?? [];
      list.push({ id: staffHandle(projectId, a.userId), name: a.name ?? 'Team member' });
      assigneesByTask.set(a.taskId, list);
    }
  }

  ok(res, {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    health: p.health,
    deadline: toIso(p.deadline),
    startDate: toIso(p.startDate),
    tasksTotal: total,
    tasksDone: done,
    progress: total === 0 ? 0 : Math.round((done / total) * 100),
    tasks: taskRows.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: toIso(t.dueDate),
      done: t.status === 'done',
      assignees: assigneesByTask.get(t.id) ?? [],
    })),
    tasksByStatus,
    milestones: milestones.map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      dueDate: toIso(m.dueDate),
    })),
  });
});

// ── GET /client/projects/:id/team — projects.view_team (name + designation) ──
clientPortalRouter.get('/projects/:id/team', requires('projects.view_team'), async (req, res) => {
  const { actor, projectId } = await authorizeProject(req, 'projects.view_team');
  const rows = await db
    .select({
      userId: projectMembers.userId,
      fullName: users.fullName,
      designation: users.designation,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.agencyId, actor.agencyId),
        eq(projectMembers.projectId, projectId),
        eq(users.kind, 'staff'),
      ),
    );
  // Name + designation only. `id` is an opaque per-project handle (UI key),
  // never the staff user id. No email / rate / internal fields.
  ok(
    res,
    rows.map((r) => ({
      id: staffHandle(projectId, r.userId),
      name: r.fullName ?? 'Team member',
      role: r.designation || 'Contributor',
      designation: r.designation ?? null,
    })),
  );
});

// ── Files & folders ─────────────────────────────────────────────────────────
const LINK_FORMATS = ['gdrive', 'onedrive', 'dropbox', 'link'];

/** documents.upload / folders.create capabilities for a file-space object. */
function fileCapabilities(actor: ClientSideActor, facts: ObjectFacts) {
  return capabilities(actor, facts, ['documents.upload', 'folders.create']);
}

function fileFacts(actor: ClientSideActor, row: { projectId: string | null }): ObjectFacts {
  // Rows here already passed clientFileFilter (brand + allowed project).
  return { agencyId: actor.agencyId, clientId: actor.clientId, projectId: row.projectId, clientVisible: true };
}

// GET /client/files — documents.view
clientPortalRouter.get('/files', requires('documents.view'), async (req, res) => {
  const actor = clientActor(req);
  const allowed = await allowedProjectIds(actor);
  const rows = await db
    .select({
      id: documents.id,
      name: documents.name,
      category: documents.category,
      fileUrl: documents.fileUrl,
      resourceType: documents.resourceType,
      format: documents.format,
      sizeBytes: documents.sizeBytes,
      projectId: documents.projectId,
      folderId: documents.folderId,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.agencyId, actor.agencyId),
        eq(documents.archived, false),
        clientFileFilter(
          actor,
          { clientId: documents.clientId, projectId: documents.projectId, clientVisible: documents.clientVisible },
          allowed,
        ),
      ),
    )
    .orderBy(desc(documents.createdAt));

  ok(
    res,
    rows.map((d) => ({
      id: d.id,
      name: d.name,
      category: d.category,
      fileUrl: d.fileUrl,
      resourceType: d.resourceType,
      format: d.format,
      sizeBytes: d.sizeBytes,
      projectId: d.projectId,
      folderId: d.folderId,
      isLink: d.format ? LINK_FORMATS.includes(d.format) : false,
      createdAt: toIso(d.createdAt),
      capabilities: fileCapabilities(actor, fileFacts(actor, d)),
    })),
  );
});

// GET /client/folders?parentId= — documents.view. parentId omitted = every
// visible folder; 'root'|'' = top level; else that folder's children.
clientPortalRouter.get('/folders', requires('documents.view'), async (req, res) => {
  const actor = clientActor(req);
  const parentId = typeof req.query.parentId === 'string' ? req.query.parentId : undefined;
  const allowed = await allowedProjectIds(actor);

  const filters = [
    eq(documentFolders.agencyId, actor.agencyId),
    clientFileFilter(
      actor,
      {
        clientId: documentFolders.clientId,
        projectId: documentFolders.projectId,
        clientVisible: documentFolders.clientVisible,
      },
      allowed,
    ),
  ];
  if (parentId !== undefined) {
    filters.push(
      parentId === '' || parentId === 'root'
        ? isNull(documentFolders.parentId)
        : eq(documentFolders.parentId, parentId),
    );
  }

  const rows = await db
    .select({
      id: documentFolders.id,
      name: documentFolders.name,
      parentId: documentFolders.parentId,
      projectId: documentFolders.projectId,
      createdAt: documentFolders.createdAt,
    })
    .from(documentFolders)
    .where(and(...filters))
    .orderBy(asc(documentFolders.name));

  ok(
    res,
    rows.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      projectId: f.projectId,
      createdAt: toIso(f.createdAt),
      capabilities: fileCapabilities(actor, fileFacts(actor, f)),
    })),
  );
});

/**
 * Resolve where a client-created item lands: an optional project (must be
 * visible to the actor, else 404) and an optional parent folder (must be
 * visible AND pass `permission` on the folder's own facts, which re-checks the
 * folder's project scope). Returns the effective projectId.
 */
async function resolveTarget(
  actor: ClientSideActor,
  permission: string,
  input: { projectId?: string | null; folderId?: string | null },
): Promise<string | null> {
  let projectId = input.projectId ?? null;
  if (projectId) {
    // The project must be one the actor may see (brand + selection), else 404.
    const allowed = await allowedProjectIds(actor);
    if (!allowed.includes(projectId)) throw notFound('Project not found.');
  }
  if (input.folderId) {
    const folder = await loadClientFolder(actor, input.folderId);
    authorize(actor, permission, folder?.facts, { view: 'documents.view' });
    const folderProject = folder!.row.projectId;
    if (folderProject) {
      if (projectId && projectId !== folderProject) {
        throw badRequest('The folder belongs to a different project.');
      }
      projectId = folderProject;
    }
  }
  // Final guard: the permission on the effective target (brand + project scope).
  if (projectId) {
    const allowed = await allowedProjectIds(actor);
    if (!allowed.includes(projectId)) throw notFound('Project not found.');
  }
  authorize(actor, permission, {
    agencyId: actor.agencyId,
    clientId: actor.clientId,
    projectId,
    clientVisible: true,
  });
  return projectId;
}

// POST /client/documents/sign — documents.upload. Signed direct-upload params.
const clientDocSignSchema = z.object({
  filename: z.string().optional(),
  contentType: z.string().optional(),
});
clientPortalRouter.post('/documents/sign', requires('documents.upload'), async (req, res) => {
  const actor = clientActor(req);
  const body = clientDocSignSchema.parse(req.body ?? {});
  ok(
    res,
    await signDocumentUpload({
      agencyId: actor.agencyId,
      folder: `sanctum/${actor.agencyId}/documents`,
      filename: body.filename,
      contentType: body.contentType,
      uploadBase: uploadOrigin(req),
    }),
  );
});

// POST /client/documents — documents.upload. Persist an upload OR a link.
const CLIENT_RESOURCE_TYPES = ['image', 'raw', 'video'] as const;
const clientCreateDocSchema = z.object({
  name: z.string().min(1).max(255),
  projectId: z.string().min(1).optional(),
  folderId: z.string().min(1).nullable().optional(),
  fileUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), { message: 'Only http(s) links are allowed.' }),
  publicId: z.string().optional(),
  resourceType: z.enum(CLIENT_RESOURCE_TYPES).optional(),
  format: z.string().max(40).optional(),
  mimeType: z.string().max(160).optional(),
  sizeBytes: z.number().int().min(0).optional(),
});

clientPortalRouter.post('/documents', requires('documents.upload'), async (req, res) => {
  const actor = clientActor(req);
  const body = clientCreateDocSchema.parse(req.body);
  if (body.publicId) assertAgencyStorageKey(actor.agencyId, body.publicId);
  const projectId = await resolveTarget(actor, 'documents.upload', body);

  const id = newId('doc');
  await db.insert(documents).values({
    id,
    agencyId: actor.agencyId,
    name: body.name,
    clientId: actor.clientId, // always the actor's brand
    projectId,
    folderId: body.folderId ?? null,
    fileUrl: body.fileUrl,
    publicId: body.publicId ?? null,
    ...(body.resourceType !== undefined ? { resourceType: body.resourceType } : {}),
    format: body.format ?? null,
    mimeType: body.mimeType ?? null,
    ...(body.sizeBytes !== undefined ? { sizeBytes: body.sizeBytes } : {}),
    clientVisible: true, // clients can only create shared items
    uploadedBy: actor.type === 'client' ? actor.userId : null,
  });

  await audit({
    ...auditBase(actor, req),
    action: 'client.document.upload',
    entityType: 'document',
    entityId: id,
    metadata: { projectId, folderId: body.folderId ?? null },
  });

  const [d] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  created(res, {
    id: d!.id,
    name: d!.name,
    category: d!.category,
    fileUrl: d!.fileUrl,
    resourceType: d!.resourceType,
    format: d!.format,
    sizeBytes: d!.sizeBytes,
    projectId: d!.projectId,
    folderId: d!.folderId,
    isLink: d!.format ? LINK_FORMATS.includes(d!.format) : false,
    createdAt: toIso(d!.createdAt),
    capabilities: fileCapabilities(actor, fileFacts(actor, d!)),
  });
});

// POST /client/folders — folders.create.
const clientCreateFolderSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).optional(),
});

clientPortalRouter.post('/folders', requires('folders.create'), async (req, res) => {
  const actor = clientActor(req);
  const body = clientCreateFolderSchema.parse(req.body);
  const projectId = await resolveTarget(actor, 'folders.create', {
    projectId: body.projectId,
    folderId: body.parentId,
  });

  const id = newId('folder');
  await db.insert(documentFolders).values({
    id,
    agencyId: actor.agencyId,
    name: body.name,
    parentId: body.parentId ?? null,
    clientId: actor.clientId,
    projectId,
    clientVisible: true,
    createdBy: actor.type === 'client' ? actor.userId : null,
  });

  await audit({
    ...auditBase(actor, req),
    action: 'client.folder.create',
    entityType: 'document_folder',
    entityId: id,
    metadata: { projectId, parentId: body.parentId ?? null },
  });

  const [f] = await db.select().from(documentFolders).where(eq(documentFolders.id, id)).limit(1);
  created(res, {
    id: f!.id,
    name: f!.name,
    parentId: f!.parentId,
    projectId: f!.projectId,
    createdAt: toIso(f!.createdAt),
    capabilities: fileCapabilities(actor, fileFacts(actor, f!)),
  });
});

// ── Content calendar ─────────────────────────────────────────────────────────
function parseHandles(json: string | null): Record<string, string> | null {
  try {
    const v = json ? JSON.parse(json) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function postCapabilities(actor: ClientSideActor, post: typeof contentPosts.$inferSelect, visible: string[]) {
  const caps = capabilities(actor, postFactsFromRow(post, visible), ['posts.approve', 'post_comments.create']);
  caps['posts.approve'] = caps['posts.approve'] === true && post.status === 'pending_approval';
  return caps;
}

// GET /client/calendar — posts.view (brand-level posts; visible statuses only).
clientPortalRouter.get('/calendar', requires('posts.view'), async (req, res) => {
  const actor = clientActor(req);
  const [cli] = await db
    .select({ logoUrl: clients.logoUrl, handlesJson: clients.handlesJson })
    .from(clients)
    .where(and(eq(clients.id, actor.clientId), eq(clients.agencyId, actor.agencyId)))
    .limit(1);
  const visible = await portalVisibleStatuses(actor.agencyId, actor.clientId);

  const rows = await db
    .select()
    .from(contentPosts)
    .where(clientPostFilter(actor, visible))
    .orderBy(asc(contentPosts.scheduledAt));

  const ids = rows.map((p) => p.id);
  const mediaByPost = new Map<
    string,
    { resourceType: string; secureUrl: string; width: number | null; height: number | null; position: number; archived: boolean }[]
  >();
  const commentCount = new Map<string, number>();
  if (ids.length) {
    const media = await db
      .select()
      .from(postMedia)
      .where(and(eq(postMedia.agencyId, actor.agencyId), inArray(postMedia.postId, ids)))
      .orderBy(asc(postMedia.position));
    for (const m of media) {
      const list = mediaByPost.get(m.postId) ?? [];
      list.push({
        resourceType: m.resourceType,
        secureUrl: m.secureUrl,
        width: m.width,
        height: m.height,
        position: m.position,
        archived: m.archived,
      });
      mediaByPost.set(m.postId, list);
    }
    if (can(actor, 'post_comments.view')) {
      const cc = await db
        .select({ postId: postComments.postId, n: sql<number>`count(*)` })
        .from(postComments)
        .where(and(eq(postComments.agencyId, actor.agencyId), inArray(postComments.postId, ids)))
        .groupBy(postComments.postId);
      for (const r of cc) commentCount.set(r.postId, Number(r.n));
    }
  }

  const reservations = await db
    .select()
    .from(calendarReservations)
    .where(
      and(eq(calendarReservations.agencyId, actor.agencyId), eq(calendarReservations.clientId, actor.clientId)),
    );

  const [ig] = await db
    .select({
      username: socialAccounts.username,
      avatarUrl: socialAccounts.avatarUrl,
      followers: socialAccounts.followersCount,
    })
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.agencyId, actor.agencyId),
        eq(socialAccounts.clientId, actor.clientId),
        eq(socialAccounts.platform, 'instagram'),
        eq(socialAccounts.status, 'active'),
      ),
    )
    .limit(1);

  ok(res, {
    canApprove: can(actor, 'posts.approve'),
    canComment: can(actor, 'post_comments.create'),
    brand: {
      logoUrl: cli?.logoUrl ?? null,
      handles: parseHandles(cli?.handlesJson ?? null),
      instagram: ig ?? null,
    },
    reservations: reservations.map((r) => ({ id: r.id, date: toIso(r.date), label: r.label })),
    posts: rows.map((p) => ({
      id: p.id,
      postType: p.postType,
      caption: p.caption,
      platforms: safePlatforms(p.platformsJson),
      scheduledAt: toIso(p.scheduledAt),
      status: p.status,
      media: mediaByPost.get(p.id) ?? [],
      commentCount: commentCount.get(p.id) ?? 0,
      capabilities: postCapabilities(actor, p, visible),
    })),
  });
});

// GET /client/posts/:postId/comments — post_comments.view.
clientPortalRouter.get('/posts/:postId/comments', requires('post_comments.view'), async (req, res) => {
  const actor = clientActor(req);
  const loaded = await loadClientPost(actor, param(req, 'postId'));
  authorize(actor, 'post_comments.view', loaded?.facts, { view: 'posts.view' });
  const rows = await db
    .select({
      id: postComments.id,
      authorType: postComments.authorType,
      authorLabel: postComments.authorLabel,
      body: postComments.body,
      createdAt: postComments.createdAt,
    })
    .from(postComments)
    .where(and(eq(postComments.agencyId, actor.agencyId), eq(postComments.postId, loaded!.row.id)))
    .orderBy(asc(postComments.createdAt));
  ok(
    res,
    rows.map((c) => ({
      id: c.id,
      authorType: c.authorType,
      author: c.authorLabel || (c.authorType === 'client' ? 'You' : 'Agency'),
      body: c.body,
      createdAt: toIso(c.createdAt),
    })),
  );
});

// POST /client/posts/:postId/comments — post_comments.create. The author name
// comes from the session (client user) or the brand (share-link session).
const clientCommentSchema = z.object({ body: z.string().trim().min(1).max(2000) });
clientPortalRouter.post('/posts/:postId/comments', requires('post_comments.create'), async (req, res) => {
  const actor = clientActor(req);
  const loaded = await loadClientPost(actor, param(req, 'postId'));
  authorize(actor, 'post_comments.create', loaded?.facts, { view: 'posts.view' });
  const post = loaded!.row;
  const body = clientCommentSchema.parse(req.body);
  const name = await clientActorDisplayName(actor);
  const id = newId('cmt');
  await db.insert(postComments).values({
    id,
    agencyId: actor.agencyId,
    clientId: actor.clientId,
    postId: post.id,
    authorType: 'client',
    portalTokenId: actor.type === 'portal_link' ? actor.tokenId : null,
    authorLabel: name,
    body: body.body,
  });

  await audit({
    ...auditBase(actor, req),
    action: 'post.comment',
    entityType: 'post',
    entityId: post.id,
    metadata: { commentId: id },
  });

  await notifyPortalActivity({
    agencyId: actor.agencyId,
    clientId: actor.clientId,
    type: 'post.comment',
    title: `${name} commented`,
    body: body.body.trim().slice(0, 120),
    postId: post.id,
  });
  // Mirrored into the team's Messages with SYSTEM attribution (no staff author).
  await mirrorClientCommentAsSystem({
    agencyId: actor.agencyId,
    clientId: actor.clientId,
    postId: post.id,
    authorName: name,
    body: body.body,
  });
  broadcastPortalRefresh(actor.clientId);

  created(res, {
    id,
    authorType: 'client',
    author: name,
    body: body.body,
    createdAt: new Date().toISOString(),
  });
});

// POST /client/posts/:postId/decision — posts.approve (approve OR request
// changes), only from pending_approval. Reviewers lack posts.approve → 403.
const clientDecisionSchema = z.object({
  decision: z.enum(['approved', 'changes_requested']),
  note: z.string().trim().max(2000).optional(),
});
clientPortalRouter.post('/posts/:postId/decision', requires('posts.approve'), async (req, res) => {
  const actor = clientActor(req);
  const loaded = await loadClientPost(actor, param(req, 'postId'));
  authorize(actor, 'posts.approve', loaded?.facts, {
    view: 'posts.view',
    message: 'Your access can review and comment, but only an approver can decide.',
  });
  const post = loaded!.row;
  const body = clientDecisionSchema.parse(req.body);
  assertPostDecidable(post);

  const newStatus = body.decision === 'approved' ? 'approved' : 'changes_requested';
  const updated = await db
    .update(contentPosts)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(
      and(
        eq(contentPosts.id, post.id),
        eq(contentPosts.agencyId, actor.agencyId),
        eq(contentPosts.clientId, actor.clientId),
        eq(contentPosts.status, 'pending_approval'),
      ),
    )
    .returning({ id: contentPosts.id });
  if (!updated.length) throw invalidState('This post was already decided.');

  // Approval trail as an attributed comment (postApprovals requires a link id).
  const name = await clientActorDisplayName(actor);
  const label =
    body.decision === 'approved'
      ? `✅ Approved${body.note ? `: ${body.note}` : ''}`
      : `↩️ Requested changes${body.note ? `: ${body.note}` : ''}`;
  await db.insert(postComments).values({
    id: newId('cmt'),
    agencyId: actor.agencyId,
    clientId: actor.clientId,
    postId: post.id,
    authorType: 'client',
    portalTokenId: actor.type === 'portal_link' ? actor.tokenId : null,
    authorLabel: name,
    body: label,
  });

  await audit({
    ...auditBase(actor, req),
    action: `post.${body.decision}`,
    entityType: 'post',
    entityId: post.id,
  });

  const captionSnippet = (post.caption ?? '').trim().slice(0, 80);
  await notifyPortalActivity({
    agencyId: actor.agencyId,
    clientId: actor.clientId,
    type: body.decision === 'approved' ? 'post.approved' : 'post.changes',
    title: body.decision === 'approved' ? `${name} approved a post` : `${name} requested changes`,
    body: body.note?.trim() || (captionSnippet ? `“${captionSnippet}”` : null),
    postId: post.id,
  });
  broadcastPortalRefresh(actor.clientId);

  ok(res, { postId: post.id, decision: body.decision, newStatus });
});

// ============================================================
//  PROPOSALS — proposals.view (+ proposals.view_pricing for money,
//  proposals.respond to accept/reject). Proposals are brand-level.
//  The public document `token` is NEVER returned here.
// ============================================================
function serializeProposal(actor: ClientSideActor, p: typeof proposals.$inferSelect, facts: ObjectFacts) {
  const pricing = check(actor, 'proposals.view_pricing', facts);
  const content = safeJson(p.contentJson);
  return {
    id: p.id,
    proposalNumber: p.proposalNumber,
    title: p.title,
    status: p.status,
    currency: p.currency,
    subtotalPaise: pricing ? p.subtotalPaise : null,
    taxPaise: pricing ? p.taxPaise : null,
    totalPaise: pricing ? p.totalPaise : null,
    validUntil: toIso(p.validUntil),
    content: pricing ? content : redactMoney(content),
    fileUrl: p.fileUrl,
    sentAt: toIso(p.sentAt),
    viewedAt: toIso(p.viewedAt),
    acceptedAt: toIso(p.acceptedAt),
    rejectionReason: p.rejectionReason,
    createdAt: toIso(p.createdAt),
    capabilities: {
      'proposals.view_pricing': pricing,
      'proposals.respond': check(actor, 'proposals.respond', facts) && proposalRespondable(p),
    },
  };
}

function proposalFactsFromRow(p: typeof proposals.$inferSelect): ObjectFacts {
  return { agencyId: p.agencyId, clientId: p.clientId, projectId: null, clientVisible: p.status !== 'draft' };
}

clientPortalRouter.get('/proposals', requires('proposals.view'), async (req, res) => {
  const actor = clientActor(req);
  const rows = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.agencyId, actor.agencyId),
        clientRowFilter(actor, 'proposals.view', { clientId: proposals.clientId }, []),
        ne(proposals.status, 'draft'),
      ),
    )
    .orderBy(desc(proposals.createdAt));
  ok(res, rows.map((p) => serializeProposal(actor, p, proposalFactsFromRow(p))));
});

clientPortalRouter.get('/proposals/:id', requires('proposals.view'), async (req, res) => {
  const actor = clientActor(req);
  const loaded = await loadClientProposal(actor, param(req, 'id'));
  authorize(actor, 'proposals.view', loaded?.facts);
  ok(res, serializeProposal(actor, loaded!.row, loaded!.facts));
});

async function respondToProposal(req: Request, decision: 'accepted' | 'rejected', reason?: string) {
  const actor = clientActor(req);
  const loaded = await loadClientProposal(actor, param(req, 'id'));
  authorize(actor, 'proposals.respond', loaded?.facts, { view: 'proposals.view' });
  const p = loaded!.row;
  assertProposalRespondable(p);
  const name = await clientActorDisplayName(actor);
  const now = new Date();

  const updated = await db
    .update(proposals)
    .set(
      decision === 'accepted'
        ? { status: 'accepted', acceptedAt: now, acceptedBy: name, updatedAt: now }
        : { status: 'rejected', rejectionReason: reason?.trim() || null, rejectedAt: now, updatedAt: now },
    )
    .where(
      and(
        eq(proposals.id, p.id),
        eq(proposals.agencyId, actor.agencyId),
        inArray(proposals.status, ['sent', 'viewed']),
      ),
    )
    .returning({ id: proposals.id });
  if (!updated.length) throw invalidState('This proposal was already responded to.');

  await audit({
    ...auditBase(actor, req),
    action: decision === 'accepted' ? 'proposal.accept' : 'proposal.reject',
    entityType: 'proposal',
    entityId: p.id,
  });

  try {
    await notifyPermissionHolders(actor.agencyId, 'proposals.view', {
      agencyId: actor.agencyId,
      type: decision === 'accepted' ? 'proposal.accepted' : 'proposal.changes_requested',
      title: decision === 'accepted' ? 'Proposal accepted' : 'Proposal — changes requested',
      body:
        decision === 'accepted'
          ? `${name} accepted “${p.title}”.`
          : `${name} requested changes on “${p.title}”${reason?.trim() ? `: ${reason.trim()}` : '.'}`,
      entityType: 'proposal',
      entityId: p.id,
      link: '/proposals',
    });
  } catch {
    /* best-effort — never fail the client's action */
  }
}

// POST /client/proposals/:id/accept — proposals.respond; only sent/viewed, before validUntil.
clientPortalRouter.post('/proposals/:id/accept', requires('proposals.respond'), async (req, res) => {
  await respondToProposal(req, 'accepted');
  ok(res, { accepted: true });
});

// POST /client/proposals/:id/reject — proposals.respond; same state guard.
const clientRejectSchema = z.object({ reason: z.string().trim().max(1000).optional() });
clientPortalRouter.post('/proposals/:id/reject', requires('proposals.respond'), async (req, res) => {
  const body = clientRejectSchema.parse(req.body ?? {});
  await respondToProposal(req, 'rejected', body.reason);
  ok(res, { rejected: true });
});

// ============================================================
//  AGREEMENTS — agreements.view (+ agreements.view_pricing, agreements.sign).
//  Project-bound agreements outside the actor's projects are hidden.
// ============================================================
function serializeAgreement(
  actor: ClientSideActor,
  a: typeof agreements.$inferSelect,
  facts: ObjectFacts,
  detail: boolean,
) {
  const pricing = check(actor, 'agreements.view_pricing', facts);
  return {
    id: a.id,
    agreementNumber: a.agreementNumber,
    title: a.title,
    status: a.status,
    projectId: a.projectId,
    effectiveDate: toIso(a.effectiveDate),
    expirationDate: toIso(a.expirationDate),
    retainerPaise: pricing ? a.retainerPaise : null,
    totalValuePaise: pricing ? a.totalValuePaise : null,
    currency: a.currency,
    terms: pricing ? safeJson(a.termsJson) : redactMoney(safeJson(a.termsJson)),
    fileUrl: a.fileUrl,
    sentAt: toIso(a.sentAt),
    signedAt: toIso(a.signedAt),
    signerName: a.signerName,
    signerEmail: a.signerEmail,
    ...(detail ? { signatureDataUrl: a.signatureDataUrl } : {}),
    createdAt: toIso(a.createdAt),
    capabilities: {
      'agreements.view_pricing': pricing,
      'agreements.sign': check(actor, 'agreements.sign', facts) && agreementSignable(a),
    },
  };
}

clientPortalRouter.get('/agreements', requires('agreements.view'), async (req, res) => {
  const actor = clientActor(req);
  const allowed = await allowedProjectIds(actor);
  const rows = await db
    .select()
    .from(agreements)
    .where(
      and(
        eq(agreements.agencyId, actor.agencyId),
        clientRowFilter(actor, 'agreements.view', { clientId: agreements.clientId, projectId: agreements.projectId }, allowed),
        ne(agreements.status, 'draft'),
      ),
    )
    .orderBy(desc(agreements.createdAt));
  ok(
    res,
    rows.map((a) =>
      serializeAgreement(
        actor,
        a,
        { agencyId: a.agencyId, clientId: a.clientId, projectId: a.projectId, clientVisible: true },
        false,
      ),
    ),
  );
});

clientPortalRouter.get('/agreements/:id', requires('agreements.view'), async (req, res) => {
  const actor = clientActor(req);
  const loaded = await loadClientAgreement(actor, param(req, 'id'));
  authorize(actor, 'agreements.view', loaded?.facts);
  ok(res, serializeAgreement(actor, loaded!.row, loaded!.facts, true));
});

const clientSignAgreementSchema = z.object({
  signerName: z.string().trim().min(1).max(160),
  signerEmail: z.string().email(),
  signatureDataUrl: z.string().min(10),
});

// POST /client/agreements/:id/sign — agreements.sign; only sent/viewed, once (409).
clientPortalRouter.post('/agreements/:id/sign', requires('agreements.sign'), async (req, res) => {
  const actor = clientActor(req);
  const loaded = await loadClientAgreement(actor, param(req, 'id'));
  authorize(actor, 'agreements.sign', loaded?.facts, { view: 'agreements.view' });
  const a = loaded!.row;
  const body = clientSignAgreementSchema.parse(req.body);
  assertAgreementSignable(a);
  assertSignatureDataUrl(body.signatureDataUrl);

  const signedAt = new Date();
  const updated = await db
    .update(agreements)
    .set({
      status: 'signed',
      signedAt,
      signerName: body.signerName,
      signerEmail: body.signerEmail,
      signerIp: req.ip ?? 'unknown',
      signatureDataUrl: body.signatureDataUrl,
      updatedAt: signedAt,
    })
    .where(
      and(
        eq(agreements.id, a.id),
        eq(agreements.agencyId, actor.agencyId),
        eq(agreements.status, 'sent'),
        isNull(agreements.signedAt),
      ),
    )
    .returning({ id: agreements.id });
  if (!updated.length) throw conflict('This agreement has already been signed.');

  await audit({
    ...auditBase(actor, req),
    action: 'agreement.sign',
    entityType: 'agreement',
    entityId: a.id,
    metadata: { signerName: body.signerName, signerEmail: body.signerEmail },
  });

  try {
    await notifyPermissionHolders(actor.agencyId, 'agreements.view', {
      agencyId: actor.agencyId,
      type: 'agreement.signed',
      title: 'Agreement signed',
      body: `${body.signerName} signed “${a.title}”.`,
      entityType: 'agreement',
      entityId: a.id,
      link: '/agreements',
    });
  } catch {
    /* best-effort */
  }

  ok(res, { signed: true, signedAt: signedAt.toISOString() });
});

// ============================================================
//  INVOICES — invoices.view. Project-bound invoices outside the actor's
//  projects are hidden (and their project names never leak).
// ============================================================
const clientInvoiceSelection = {
  id: invoices.id,
  agencyId: invoices.agencyId,
  clientId: invoices.clientId,
  projectId: invoices.projectId,
  invoiceNumber: invoices.invoiceNumber,
  status: invoices.status,
  issueDate: invoices.issueDate,
  dueDate: invoices.dueDate,
  isInterstate: invoices.isInterstate,
  currency: invoices.currency,
  subtotal: invoices.subtotal,
  taxTotal: invoices.taxTotal,
  cgst: invoices.cgst,
  sgst: invoices.sgst,
  igst: invoices.igst,
  total: invoices.total,
  notes: invoices.notes,
  terms: invoices.terms,
  bankDetails: invoices.bankDetails,
  fileUrl: invoices.fileUrl,
  createdAt: invoices.createdAt,
  projectName: projects.name,
};

clientPortalRouter.get('/invoices', requires('invoices.view'), async (req, res) => {
  const actor = clientActor(req);
  const allowed = await allowedProjectIds(actor);
  const rows = await db
    .select(clientInvoiceSelection)
    .from(invoices)
    .leftJoin(projects, eq(projects.id, invoices.projectId))
    .where(
      and(
        eq(invoices.agencyId, actor.agencyId),
        clientRowFilter(actor, 'invoices.view', { clientId: invoices.clientId, projectId: invoices.projectId }, allowed),
        ne(invoices.status, 'draft'),
      ),
    )
    .orderBy(desc(invoices.issueDate), desc(invoices.createdAt));

  const invoiceIds = rows.map((r) => r.id);
  const paymentSums = new Map<string, number>();
  if (invoiceIds.length) {
    const payRows = await db
      .select({ invoiceId: invoicePayments.invoiceId, totalPaid: sum(invoicePayments.amount) })
      .from(invoicePayments)
      .where(inArray(invoicePayments.invoiceId, invoiceIds))
      .groupBy(invoicePayments.invoiceId);
    for (const r of payRows) paymentSums.set(r.invoiceId, Number(r.totalPaid ?? 0));
  }

  ok(
    res,
    rows.map((r) => {
      const paid = paymentSums.get(r.id) ?? 0;
      const balance = Math.max(0, r.total - paid);
      const isOverdue =
        r.dueDate &&
        new Date(r.dueDate).getTime() < Date.now() &&
        r.status !== 'paid' &&
        r.status !== 'cancelled';
      return {
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        projectName: r.projectName,
        status: isOverdue ? 'overdue' : r.status,
        issueDate: toIso(r.issueDate),
        dueDate: toIso(r.dueDate),
        currency: r.currency,
        subtotal: r.subtotal,
        taxTotal: r.taxTotal,
        total: r.total,
        paidAmount: paid,
        balanceDue: balance,
        notes: r.notes,
        terms: r.terms,
        bankDetails: r.bankDetails,
        fileUrl: r.fileUrl,
        createdAt: toIso(r.createdAt),
      };
    }),
  );
});

clientPortalRouter.get('/invoices/:id', requires('invoices.view'), async (req, res) => {
  const actor = clientActor(req);
  const loaded = await loadClientInvoice(actor, param(req, 'id'));
  authorize(actor, 'invoices.view', loaded?.facts);
  const row = loaded!.row;
  const [proj] = row.projectId
    ? await db
        .select({ name: projects.name })
        .from(projects)
        .where(and(eq(projects.id, row.projectId), eq(projects.agencyId, actor.agencyId)))
        .limit(1)
    : [];

  const items = await db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, row.id))
    .orderBy(invoiceItems.position);
  const payments = await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, row.id))
    .orderBy(desc(invoicePayments.paidAt));

  const paidAmount = payments.reduce((acc, p) => acc + p.amount, 0);
  const balanceDue = Math.max(0, row.total - paidAmount);

  ok(res, {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    projectName: proj?.name ?? null,
    status: row.status,
    issueDate: toIso(row.issueDate),
    dueDate: toIso(row.dueDate),
    isInterstate: row.isInterstate,
    currency: row.currency,
    subtotal: row.subtotal,
    taxTotal: row.taxTotal,
    cgst: row.cgst,
    sgst: row.sgst,
    igst: row.igst,
    total: row.total,
    paidAmount,
    balanceDue,
    notes: row.notes,
    terms: row.terms,
    bankDetails: row.bankDetails,
    items: items.map((it) => ({
      id: it.id,
      description: it.description,
      quantity: it.quantity,
      unit: it.unit,
      rate: it.rate,
      gstRate: it.gstRate,
      amount: it.amount,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      paidAt: toIso(p.paidAt),
      method: p.method,
      reference: p.reference,
    })),
    createdAt: toIso(row.createdAt),
  });
});
