import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, sum } from 'drizzle-orm';
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
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { audit } from '../services/audit.js';
import { mirrorClientPostComment } from '../services/client-discussion.js';
import { requireAuth } from '../middleware/auth.js';
import { requireClientAuth, getClientCtx } from '../middleware/client.js';
import { signDocumentUpload } from '../services/storage.js';
import { uploadOrigin } from '../services/local-storage.js';

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

/** The logged-in client's display name (used to attribute approvals/comments —
 * no manual name entry, unlike the magic-link portal). */
async function clientDisplayName(userId: string): Promise<string> {
  const [u] = await db
    .select({ name: users.fullName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.name?.trim() || 'Client';
}

/**
 * Client-portal API for a logged-in `client` user. Every route is scoped to the
 * client's brand + their allowed project set (requireClientAuth). Fields are
 * deliberately TRIMMED — no contract values, internal notes, or staff emails.
 */
export const clientPortalRouter = Router();
clientPortalRouter.use(requireAuth);
clientPortalRouter.use(requireClientAuth);

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
    .where(
      and(
        eq(projectTasks.agencyId, agencyId),
        inArray(projectTasks.projectId, projectIds),
      ),
    )
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
clientPortalRouter.get('/me', async (req, res) => {
  const ctx = getClientCtx(req);
  const [me] = await db
    .select({ id: users.id, email: users.email, fullName: users.fullName })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);
  const [client] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.id, ctx.clientId))
    .limit(1);
  const [agency] = await db
    .select({
      name: agencies.name,
      logoUrl: agencies.logoUrl,
      brandColor: agencies.brandColor,
    })
    .from(agencies)
    .where(eq(agencies.id, ctx.agencyId))
    .limit(1);

  ok(res, {
    user: me ?? null,
    client: client ?? null,
    agency: agency ?? null,
    scope: { allProjects: ctx.allProjects, projectCount: ctx.projectIds.length },
  });
});

// ── GET /client/projects — the client's projects (scoped, trimmed) ──────────
clientPortalRouter.get('/projects', async (req, res) => {
  const ctx = getClientCtx(req);
  if (ctx.projectIds.length === 0) return ok(res, []);

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
        eq(projects.agencyId, ctx.agencyId),
        inArray(projects.id, ctx.projectIds),
      ),
    )
    .orderBy(desc(projects.createdAt));

  const counts = await taskCountsByProject(ctx.agencyId, ctx.projectIds);
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

/** Guard: the project must be in the client's scope, else 404. */
function assertProjectInScope(req: import('express').Request): string {
  const ctx = getClientCtx(req);
  const projectId = param(req, 'id');
  if (!ctx.projectIds.includes(projectId)) throw notFound('Project not found.');
  return projectId;
}

// ── GET /client/projects/:id — overview (counts, milestones, progress) ──────
clientPortalRouter.get('/projects/:id', async (req, res) => {
  const ctx = getClientCtx(req);
  const projectId = assertProjectInScope(req);

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
    .where(and(eq(projects.id, projectId), eq(projects.agencyId, ctx.agencyId)))
    .limit(1);
  if (!p) throw notFound('Project not found.');

  const statusRows = await db
    .select({ status: projectTasks.status, n: sql<number>`count(*)` })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.projectId, projectId),
      ),
    )
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
    .where(
      and(
        eq(projectMilestones.agencyId, ctx.agencyId),
        eq(projectMilestones.projectId, projectId),
      ),
    )
    .orderBy(projectMilestones.position);

  // Tasks + the team member(s) assigned to each (name only — no internal
  // fields). Lets the client see what's being worked on and by whom.
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
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.projectId, projectId),
      ),
    )
    .orderBy(projectTasks.position, projectTasks.createdAt);

  const taskIds = taskRows.map((t) => t.id);
  const assigneesByTask = new Map<string, { id: string; name: string }[]>();
  if (taskIds.length) {
    const arows = await db
      .select({
        taskId: taskAssignees.taskId,
        userId: users.id,
        name: users.fullName,
      })
      .from(taskAssignees)
      .innerJoin(users, eq(users.id, taskAssignees.userId))
      .where(
        and(
          eq(taskAssignees.agencyId, ctx.agencyId),
          inArray(taskAssignees.taskId, taskIds),
        ),
      );
    for (const a of arows) {
      const list = assigneesByTask.get(a.taskId) ?? [];
      list.push({ id: a.userId, name: a.name ?? 'Team member' });
      assigneesByTask.set(a.taskId, list);
    }
  }
  const tasks = taskRows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueDate: toIso(t.dueDate),
    done: t.status === 'done',
    assignees: assigneesByTask.get(t.id) ?? [],
  }));

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
    tasks,
    tasksByStatus,
    milestones: milestones.map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      dueDate: toIso(m.dueDate),
    })),
  });
});

// ── GET /client/projects/:id/team — trimmed overview (NO emails) ────────────
clientPortalRouter.get('/projects/:id/team', async (req, res) => {
  const ctx = getClientCtx(req);
  const projectId = assertProjectInScope(req);

  const rows = await db
    .select({
      userId: projectMembers.userId,
      projectRole: projectMembers.role,
      fullName: users.fullName,
      designation: users.designation,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.agencyId, ctx.agencyId),
        eq(projectMembers.projectId, projectId),
      ),
    );

  // Trimmed: name + what they do only. No email / rate / internal fields.
  ok(
    res,
    rows.map((r) => ({
      id: r.userId,
      name: r.fullName ?? 'Team member',
      role: r.designation || r.projectRole || 'Contributor',
    })),
  );
});

// ── GET /client/files — client-facing documents (scoped) ────────────────────
clientPortalRouter.get('/files', async (req, res) => {
  const ctx = getClientCtx(req);

  // Files shared with the client: clientVisible AND (attached to the client
  // directly OR to one of the client's in-scope projects).
  const scopeConds = [eq(documents.clientId, ctx.clientId)];
  if (ctx.projectIds.length > 0) {
    scopeConds.push(inArray(documents.projectId, ctx.projectIds));
  }

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
        eq(documents.agencyId, ctx.agencyId),
        eq(documents.clientVisible, true),
        or(...scopeConds),
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
      folderId: d.folderId,
      isLink: !d.format
        ? false
        : ['gdrive', 'onedrive', 'dropbox', 'link'].includes(d.format),
      createdAt: toIso(d.createdAt),
    })),
  );
});

// ── GET /client/folders?parentId= — client-VISIBLE folders (scoped) ──────────
// Mirrors /client/files scope (agencyId + clientId OR an in-scope project) and
// keeps clientVisible as the authoritative gate. parentId omitted = every
// visible folder; 'root'|'' = top level (parentId IS NULL); else that folder.
clientPortalRouter.get('/folders', async (req, res) => {
  const ctx = getClientCtx(req);
  const parentId =
    typeof req.query.parentId === 'string' ? req.query.parentId : undefined;

  const scopeConds = [eq(documentFolders.clientId, ctx.clientId)];
  if (ctx.projectIds.length > 0) {
    scopeConds.push(inArray(documentFolders.projectId, ctx.projectIds));
  }

  const filters = [
    eq(documentFolders.agencyId, ctx.agencyId),
    eq(documentFolders.clientVisible, true),
    or(...scopeConds),
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
    })),
  );
});

// ── Client WRITE: upload files / attach links / create folders ───────────────
// A client can add to THEIR OWN space. Everything they create is forced
// clientVisible=true and scoped to their brand (clientId) — and, when created
// inside a project folder, inherits that folder's project. The agency sees it
// too (it's a shared space), so this is genuine two-way file sharing.

const CLIENT_RESOURCE_TYPES = ['image', 'raw', 'video'] as const;
const LINK_FORMATS = ['gdrive', 'onedrive', 'dropbox', 'link'];

/** Assert a project id is within the client's scope, else 403. */
function assertClientProject(
  ctx: ReturnType<typeof getClientCtx>,
  projectId: string,
): void {
  if (!ctx.projectIds.includes(projectId)) {
    throw forbidden('That project is not in your portal.');
  }
}

/** Load a client-visible folder that belongs to the client's scope, or 404. */
async function loadClientFolder(
  ctx: ReturnType<typeof getClientCtx>,
  folderId: string,
) {
  const [f] = await db
    .select({
      id: documentFolders.id,
      projectId: documentFolders.projectId,
      clientId: documentFolders.clientId,
    })
    .from(documentFolders)
    .where(
      and(
        eq(documentFolders.id, folderId),
        eq(documentFolders.agencyId, ctx.agencyId),
        eq(documentFolders.clientVisible, true),
      ),
    )
    .limit(1);
  if (!f) throw notFound('Folder not found.');
  const inScope =
    f.clientId === ctx.clientId ||
    (f.projectId != null && ctx.projectIds.includes(f.projectId));
  if (!inScope) throw notFound('Folder not found.');
  return f;
}

// POST /client/documents/sign — signed direct-upload params (Cloudinary or R2).
const clientDocSignSchema = z.object({
  filename: z.string().optional(),
  contentType: z.string().optional(),
});
clientPortalRouter.post('/documents/sign', async (req, res) => {
  const ctx = getClientCtx(req);
  const body = clientDocSignSchema.parse(req.body ?? {});
  const folder = `sanctum/${ctx.agencyId}/documents`;
  ok(
    res,
    await signDocumentUpload({
      agencyId: ctx.agencyId,
      folder,
      filename: body.filename,
      contentType: body.contentType,
      uploadBase: uploadOrigin(req),
    }),
  );
});

// POST /client/documents — persist an uploaded file OR an external link.
const clientCreateDocSchema = z.object({
  name: z.string().min(1).max(255),
  projectId: z.string().min(1).optional(),
  folderId: z.string().min(1).nullable().optional(),
  fileUrl: z.string().url(),
  publicId: z.string().optional(),
  resourceType: z.enum(CLIENT_RESOURCE_TYPES).optional(),
  format: z.string().max(40).optional(),
  mimeType: z.string().max(160).optional(),
  sizeBytes: z.number().int().min(0).optional(),
});

clientPortalRouter.post('/documents', async (req, res) => {
  const ctx = getClientCtx(req);
  const body = clientCreateDocSchema.parse(req.body);

  let projectId = body.projectId ?? null;
  if (projectId) assertClientProject(ctx, projectId);
  if (body.folderId) {
    const folder = await loadClientFolder(ctx, body.folderId);
    // A doc created inside a project folder belongs to that project.
    if (folder.projectId) projectId = folder.projectId;
  }

  const id = newId('doc');
  await db.insert(documents).values({
    id,
    agencyId: ctx.agencyId,
    name: body.name,
    clientId: ctx.clientId,
    projectId,
    folderId: body.folderId ?? null,
    fileUrl: body.fileUrl,
    publicId: body.publicId ?? null,
    ...(body.resourceType !== undefined
      ? { resourceType: body.resourceType }
      : {}),
    format: body.format ?? null,
    mimeType: body.mimeType ?? null,
    ...(body.sizeBytes !== undefined ? { sizeBytes: body.sizeBytes } : {}),
    clientVisible: true, // forced — clients can only create shared items
    uploadedBy: ctx.userId,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: 'client',
    actorId: ctx.userId,
    action: 'client.document.upload',
    entityType: 'document',
    entityId: id,
    ip: req.ip,
  });

  const [d] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, id))
    .limit(1);
  created(res, {
    id: d!.id,
    name: d!.name,
    category: d!.category,
    fileUrl: d!.fileUrl,
    resourceType: d!.resourceType,
    format: d!.format,
    sizeBytes: d!.sizeBytes,
    folderId: d!.folderId,
    isLink: d!.format ? LINK_FORMATS.includes(d!.format) : false,
    createdAt: toIso(d!.createdAt),
  });
});

// POST /client/folders — create a client folder (shared with the agency).
const clientCreateFolderSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).optional(),
});

clientPortalRouter.post('/folders', async (req, res) => {
  const ctx = getClientCtx(req);
  const body = clientCreateFolderSchema.parse(req.body);

  let projectId = body.projectId ?? null;
  if (projectId) assertClientProject(ctx, projectId);
  if (body.parentId) {
    const parent = await loadClientFolder(ctx, body.parentId);
    if (parent.projectId) projectId = parent.projectId;
  }

  const id = newId('folder');
  await db.insert(documentFolders).values({
    id,
    agencyId: ctx.agencyId,
    name: body.name,
    parentId: body.parentId ?? null,
    clientId: ctx.clientId,
    projectId,
    clientVisible: true,
    createdBy: ctx.userId,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: 'client',
    actorId: ctx.userId,
    action: 'client.folder.create',
    entityType: 'document_folder',
    entityId: id,
    ip: req.ip,
  });

  const [f] = await db
    .select()
    .from(documentFolders)
    .where(eq(documentFolders.id, id))
    .limit(1);
  created(res, {
    id: f!.id,
    name: f!.name,
    parentId: f!.parentId,
    projectId: f!.projectId,
    createdAt: toIso(f!.createdAt),
  });
});

// ── Content calendar (the client's brand's scheduled posts) ──────────────────
/** Load a post scoped to the client's brand (non-draft), else 404. */
async function scopedClientPost(
  ctx: { agencyId: string; clientId: string },
  postId: string,
) {
  const [post] = await db
    .select()
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.id, postId),
        eq(contentPosts.agencyId, ctx.agencyId),
        eq(contentPosts.clientId, ctx.clientId),
        ne(contentPosts.status, 'draft'),
      ),
    )
    .limit(1);
  if (!post) throw notFound('Post not found.');
  return post;
}

// GET /client/calendar — scheduled content for the client (non-draft), by date.
clientPortalRouter.get('/calendar', async (req, res) => {
  const ctx = getClientCtx(req);
  const [cli] = await db
    .select({
      visible: clients.portalVisibleStatuses,
      role: clients.portalRole,
    })
    .from(clients)
    .where(eq(clients.id, ctx.clientId))
    .limit(1);

  const visible = (cli?.visible ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Always keep 'changes_requested' visible so a "Request changes" action never
  // makes a post vanish from the client's own calendar.
  if (!visible.includes('changes_requested')) visible.push('changes_requested');

  const rows = await db
    .select()
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.agencyId, ctx.agencyId),
        eq(contentPosts.clientId, ctx.clientId),
        ne(contentPosts.status, 'draft'),
      ),
    )
    .orderBy(asc(contentPosts.scheduledAt));
  const filtered = visible.length
    ? rows.filter((p) => visible.includes(p.status))
    : rows;

  const ids = filtered.map((p) => p.id);
  const mediaByPost = new Map<
    string,
    {
      resourceType: string;
      secureUrl: string;
      width: number | null;
      height: number | null;
      position: number;
    }[]
  >();
  const commentCount = new Map<string, number>();
  if (ids.length) {
    const media = await db
      .select()
      .from(postMedia)
      .where(
        and(
          eq(postMedia.agencyId, ctx.agencyId),
          inArray(postMedia.postId, ids),
        ),
      )
      .orderBy(asc(postMedia.position));
    for (const m of media) {
      const list = mediaByPost.get(m.postId) ?? [];
      list.push({
        resourceType: m.resourceType,
        secureUrl: m.secureUrl,
        width: m.width,
        height: m.height,
        position: m.position,
      });
      mediaByPost.set(m.postId, list);
    }
    const cc = await db
      .select({ postId: postComments.postId, n: sql<number>`count(*)` })
      .from(postComments)
      .where(
        and(
          eq(postComments.agencyId, ctx.agencyId),
          inArray(postComments.postId, ids),
        ),
      )
      .groupBy(postComments.postId);
    for (const r of cc) commentCount.set(r.postId, Number(r.n));
  }

  // Reserved days (e.g. a shoot) — shown on the client's calendar so they can
  // see days the agency has blocked out.
  const reservations = await db
    .select()
    .from(calendarReservations)
    .where(
      and(
        eq(calendarReservations.agencyId, ctx.agencyId),
        eq(calendarReservations.clientId, ctx.clientId),
      ),
    );

  ok(res, {
    canApprove: cli?.role !== 'reviewer',
    reservations: reservations.map((r) => ({
      id: r.id,
      date: toIso(r.date),
      label: r.label,
    })),
    posts: filtered.map((p) => ({
      id: p.id,
      postType: p.postType,
      caption: p.caption,
      platforms: safePlatforms(p.platformsJson),
      scheduledAt: toIso(p.scheduledAt),
      status: p.status,
      media: mediaByPost.get(p.id) ?? [],
      commentCount: commentCount.get(p.id) ?? 0,
    })),
  });
});

// GET /client/posts/:postId/comments — the approval conversation.
clientPortalRouter.get('/posts/:postId/comments', async (req, res) => {
  const ctx = getClientCtx(req);
  const post = await scopedClientPost(ctx, param(req, 'postId'));
  const rows = await db
    .select({
      id: postComments.id,
      authorType: postComments.authorType,
      authorLabel: postComments.authorLabel,
      body: postComments.body,
      createdAt: postComments.createdAt,
    })
    .from(postComments)
    .where(
      and(
        eq(postComments.agencyId, ctx.agencyId),
        eq(postComments.postId, post.id),
      ),
    )
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

// POST /client/posts/:postId/comments — add a comment (authored as the client;
// their name is taken from the session, never typed in).
const clientCommentSchema = z.object({ body: z.string().trim().min(1).max(2000) });
clientPortalRouter.post('/posts/:postId/comments', async (req, res) => {
  const ctx = getClientCtx(req);
  const post = await scopedClientPost(ctx, param(req, 'postId'));
  const body = clientCommentSchema.parse(req.body);
  const name = await clientDisplayName(ctx.userId);
  const id = newId('cmt');
  await db.insert(postComments).values({
    id,
    agencyId: ctx.agencyId,
    clientId: ctx.clientId,
    postId: post.id,
    authorType: 'client',
    portalTokenId: null,
    authorLabel: name,
    body: body.body,
  });

  // Mirror into the team's internal Messages group + notify everyone working
  // on this client (same bridge the token portal uses).
  await mirrorClientPostComment({
    agencyId: ctx.agencyId,
    clientId: ctx.clientId,
    postId: post.id,
    authorName: name,
    body: body.body,
  });

  created(res, {
    id,
    authorType: 'client',
    author: name,
    body: body.body,
    createdAt: new Date().toISOString(),
  });
});

// POST /client/posts/:postId/decision — approve / request changes. The client's
// identity comes from their login (no manual name). Reviewers can't approve.
const clientDecisionSchema = z.object({
  decision: z.enum(['approved', 'changes_requested']),
  note: z.string().trim().max(2000).optional(),
});
clientPortalRouter.post('/posts/:postId/decision', async (req, res) => {
  const ctx = getClientCtx(req);
  const post = await scopedClientPost(ctx, param(req, 'postId'));
  const body = clientDecisionSchema.parse(req.body);

  const [cli] = await db
    .select({ role: clients.portalRole })
    .from(clients)
    .where(eq(clients.id, ctx.clientId))
    .limit(1);
  if (body.decision === 'approved' && cli?.role === 'reviewer') {
    throw forbidden(
      'Your access can review and request changes, but only a client admin can approve.',
    );
  }
  if (
    !['pending_approval', 'approved', 'changes_requested'].includes(post.status)
  ) {
    throw badRequest(`This post is '${post.status}' and cannot be decided.`);
  }

  const newStatus =
    body.decision === 'approved' ? 'approved' : 'changes_requested';
  await db
    .update(contentPosts)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(
      and(
        eq(contentPosts.id, post.id),
        eq(contentPosts.agencyId, ctx.agencyId),
        eq(contentPosts.clientId, ctx.clientId),
      ),
    );

  // Record the decision as an attributed comment (the approval trail the agency
  // sees) — postApprovals requires a portal token, which a login doesn't have.
  const name = await clientDisplayName(ctx.userId);
  const label =
    body.decision === 'approved'
      ? `✅ Approved${body.note ? `: ${body.note}` : ''}`
      : `↩️ Requested changes${body.note ? `: ${body.note}` : ''}`;
  await db.insert(postComments).values({
    id: newId('cmt'),
    agencyId: ctx.agencyId,
    clientId: ctx.clientId,
    postId: post.id,
    authorType: 'client',
    portalTokenId: null,
    authorLabel: name,
    body: label,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: 'client',
    actorId: ctx.userId,
    action: `post.${body.decision}`,
    entityType: 'post',
    entityId: post.id,
    ip: req.ip,
  });

  ok(res, { postId: post.id, decision: body.decision, newStatus });
});

// ============================================================
//  CLIENT PORTAL: PROPOSALS
// ============================================================
clientPortalRouter.get('/proposals', async (req, res) => {
  const ctx = getClientCtx(req);
  const rows = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.agencyId, ctx.agencyId),
        eq(proposals.clientId, ctx.clientId),
        ne(proposals.status, 'draft'),
      ),
    )
    .orderBy(desc(proposals.createdAt));

  ok(
    res,
    rows.map((p) => ({
      id: p.id,
      proposalNumber: p.proposalNumber,
      title: p.title,
      status: p.status,
      currency: p.currency,
      subtotalPaise: p.subtotalPaise,
      taxPaise: p.taxPaise,
      totalPaise: p.totalPaise,
      validUntil: toIso(p.validUntil),
      content: p.contentJson ? JSON.parse(p.contentJson) : {},
      token: p.token,
      sentAt: toIso(p.sentAt),
      viewedAt: toIso(p.viewedAt),
      acceptedAt: toIso(p.acceptedAt),
      rejectionReason: p.rejectionReason,
      createdAt: toIso(p.createdAt),
    })),
  );
});

clientPortalRouter.get('/proposals/:id', async (req, res) => {
  const ctx = getClientCtx(req);
  const [p] = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.id, param(req, 'id')),
        eq(proposals.agencyId, ctx.agencyId),
        eq(proposals.clientId, ctx.clientId),
        ne(proposals.status, 'draft'),
      ),
    )
    .limit(1);

  if (!p) throw notFound('Proposal not found.');

  ok(res, {
    id: p.id,
    proposalNumber: p.proposalNumber,
    title: p.title,
    status: p.status,
    currency: p.currency,
    subtotalPaise: p.subtotalPaise,
    taxPaise: p.taxPaise,
    totalPaise: p.totalPaise,
    validUntil: toIso(p.validUntil),
    content: p.contentJson ? JSON.parse(p.contentJson) : {},
    token: p.token,
    sentAt: toIso(p.sentAt),
    viewedAt: toIso(p.viewedAt),
    acceptedAt: toIso(p.acceptedAt),
    createdAt: toIso(p.createdAt),
  });
});

clientPortalRouter.post('/proposals/:id/accept', async (req, res) => {
  const ctx = getClientCtx(req);
  const [p] = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.id, param(req, 'id')),
        eq(proposals.agencyId, ctx.agencyId),
        eq(proposals.clientId, ctx.clientId),
      ),
    )
    .limit(1);

  if (!p) throw notFound('Proposal not found.');
  const name = await clientDisplayName(ctx.userId);

  await db
    .update(proposals)
    .set({
      status: 'accepted',
      acceptedAt: new Date(),
      acceptedBy: name,
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, p.id));

  await audit({
    agencyId: ctx.agencyId,
    actorType: 'client',
    actorId: ctx.userId,
    action: 'proposal.accept',
    entityType: 'proposal',
    entityId: p.id,
    ip: req.ip,
  });

  ok(res, { accepted: true });
});

// ============================================================
//  CLIENT PORTAL: AGREEMENTS
// ============================================================
clientPortalRouter.get('/agreements', async (req, res) => {
  const ctx = getClientCtx(req);
  const rows = await db
    .select()
    .from(agreements)
    .where(
      and(
        eq(agreements.agencyId, ctx.agencyId),
        eq(agreements.clientId, ctx.clientId),
        ne(agreements.status, 'draft'),
      ),
    )
    .orderBy(desc(agreements.createdAt));

  ok(
    res,
    rows.map((a) => ({
      id: a.id,
      agreementNumber: a.agreementNumber,
      title: a.title,
      status: a.status,
      effectiveDate: toIso(a.effectiveDate),
      expirationDate: toIso(a.expirationDate),
      retainerPaise: a.retainerPaise,
      totalValuePaise: a.totalValuePaise,
      currency: a.currency,
      terms: a.termsJson ? JSON.parse(a.termsJson) : {},
      token: a.token,
      sentAt: toIso(a.sentAt),
      signedAt: toIso(a.signedAt),
      signerName: a.signerName,
      signerEmail: a.signerEmail,
      createdAt: toIso(a.createdAt),
    })),
  );
});

clientPortalRouter.get('/agreements/:id', async (req, res) => {
  const ctx = getClientCtx(req);
  const [a] = await db
    .select()
    .from(agreements)
    .where(
      and(
        eq(agreements.id, param(req, 'id')),
        eq(agreements.agencyId, ctx.agencyId),
        eq(agreements.clientId, ctx.clientId),
        ne(agreements.status, 'draft'),
      ),
    )
    .limit(1);

  if (!a) throw notFound('Agreement not found.');

  ok(res, {
    id: a.id,
    agreementNumber: a.agreementNumber,
    title: a.title,
    status: a.status,
    effectiveDate: toIso(a.effectiveDate),
    expirationDate: toIso(a.expirationDate),
    retainerPaise: a.retainerPaise,
    totalValuePaise: a.totalValuePaise,
    currency: a.currency,
    terms: a.termsJson ? JSON.parse(a.termsJson) : {},
    token: a.token,
    sentAt: toIso(a.sentAt),
    signedAt: toIso(a.signedAt),
    signerName: a.signerName,
    signerEmail: a.signerEmail,
    signatureDataUrl: a.signatureDataUrl,
    createdAt: toIso(a.createdAt),
  });
});

const clientSignAgreementSchema = z.object({
  signerName: z.string().trim().min(1).max(160),
  signerEmail: z.string().email(),
  signatureDataUrl: z.string().min(10),
});

clientPortalRouter.post('/agreements/:id/sign', async (req, res) => {
  const ctx = getClientCtx(req);
  const body = clientSignAgreementSchema.parse(req.body);

  const [a] = await db
    .select()
    .from(agreements)
    .where(
      and(
        eq(agreements.id, param(req, 'id')),
        eq(agreements.agencyId, ctx.agencyId),
        eq(agreements.clientId, ctx.clientId),
      ),
    )
    .limit(1);

  if (!a) throw notFound('Agreement not found.');

  await db
    .update(agreements)
    .set({
      status: 'signed',
      signedAt: new Date(),
      signerName: body.signerName,
      signerEmail: body.signerEmail,
      signerIp: req.ip ?? 'unknown',
      signatureDataUrl: body.signatureDataUrl,
      updatedAt: new Date(),
    })
    .where(eq(agreements.id, a.id));

  await audit({
    agencyId: ctx.agencyId,
    actorType: 'client',
    actorId: ctx.userId,
    action: 'agreement.sign',
    entityType: 'agreement',
    entityId: a.id,
    ip: req.ip,
  });

  ok(res, { signed: true, signedAt: new Date().toISOString() });
});

// ============================================================
//  CLIENT PORTAL: INVOICES
// ============================================================
const clientInvoiceSelection = {
  id: invoices.id,
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
  createdAt: invoices.createdAt,
  projectName: projects.name,
};

clientPortalRouter.get('/invoices', async (req, res) => {
  const ctx = getClientCtx(req);
  const rows = await db
    .select(clientInvoiceSelection)
    .from(invoices)
    .leftJoin(projects, eq(projects.id, invoices.projectId))
    .where(
      and(
        eq(invoices.agencyId, ctx.agencyId),
        eq(invoices.clientId, ctx.clientId),
        ne(invoices.status, 'draft'),
      ),
    )
    .orderBy(desc(invoices.issueDate), desc(invoices.createdAt));

  const invoiceIds = rows.map((r) => r.id);
  const paymentSums = new Map<string, number>();

  if (invoiceIds.length) {
    const payRows = await db
      .select({
        invoiceId: invoicePayments.invoiceId,
        totalPaid: sum(invoicePayments.amount),
      })
      .from(invoicePayments)
      .where(inArray(invoicePayments.invoiceId, invoiceIds))
      .groupBy(invoicePayments.invoiceId);

    for (const r of payRows) {
      paymentSums.set(r.invoiceId, Number(r.totalPaid ?? 0));
    }
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
        createdAt: toIso(r.createdAt),
      };
    }),
  );
});

clientPortalRouter.get('/invoices/:id', async (req, res) => {
  const ctx = getClientCtx(req);
  const [row] = await db
    .select(clientInvoiceSelection)
    .from(invoices)
    .leftJoin(projects, eq(projects.id, invoices.projectId))
    .where(
      and(
        eq(invoices.id, param(req, 'id')),
        eq(invoices.agencyId, ctx.agencyId),
        eq(invoices.clientId, ctx.clientId),
        ne(invoices.status, 'draft'),
      ),
    )
    .limit(1);

  if (!row) throw notFound('Invoice not found.');

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
    projectName: row.projectName,
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
