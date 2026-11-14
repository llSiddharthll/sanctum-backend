/**
 * Work tools: projects (members, milestones, labels, activity, time), tasks
 * (create/assign/update, labels, dependencies, comments), "my" views, timers
 * and timesheets. Every tool maps to a route in src/routes/projects.ts,
 * src/routes/me.ts or src/routes/timers.ts and goes through ctx.api only.
 */
import { z } from 'zod';
import { defineTool, paise, seg, compact, id, isoDate, limit, type SanctumTool } from '../tool-kit.js';

// ---- Shared enums (mirror src/routes/projects.ts) ---------------------------

const PROJECT_TYPES = ['fixed_price', 'retainer', 'hourly', 'milestone_based'] as const;
const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'cancelled'] as const;
const PROJECT_HEALTH = ['on_track', 'at_risk', 'off_track'] as const;
const BILLING_TYPES = ['one_time', 'retainer'] as const;
const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const;
const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
const MILESTONE_STATUSES = ['pending', 'completed'] as const;
const LABEL_COLORS = ['pine', 'brass', 'sky', 'rose', 'amber', 'violet', 'slate'] as const;
const MEMBER_ROLES = ['lead', 'member'] as const;
const DUE_FILTERS = ['overdue', 'today', 'week', 'none'] as const;
const TASK_SORTS = ['manual', 'priority', 'due', 'created', 'updated', 'title'] as const;

// ---- Shared input fragments ---------------------------------------------------

const projectId = id('Project').describe('Project id (from projects_list)');
const taskId = id('Task').describe('Task id (from tasks_list, tasks_list_project or my_tasks)');
const dayKey = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.')
    .describe(`${what} (YYYY-MM-DD)`);
const clock = (what: string) =>
  z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h).')
    .describe(`${what} (HH:MM, 24h, agency timezone)`);

// ---- Response shapes we map to lean summaries ---------------------------------

interface ProjectRow {
  id: string;
  name: string;
  clientId: string;
  clientName: string | null;
  type: string;
  status: string;
  health: string;
  billingType: string | null;
  contractValue: number | null;
  recurringPaise: number | null;
  currency: string;
  startDate: string | null;
  deadline: string | null;
  tasksTotal: number;
  tasksDone: number;
  milestonesTotal: number;
  milestonesDone: number;
  memberCount: number;
}

interface AllTasksRow {
  id: string;
  projectId: string;
  projectName: string | null;
  clientName: string | null;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  parentTaskId: string | null;
  archivedMonth: string | null;
}

interface BoardTaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  milestoneId: string | null;
  parentTaskId: string | null;
  assignees?: Array<{ userId: string; name: string }>;
  labels?: Array<{ id: string; name: string }>;
  subtaskCount?: number;
  subtaskDoneCount?: number;
  blockedByCount?: number;
  commentCount?: number;
}

interface MyTaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  projectId: string;
  projectName: string;
  clientName: string | null;
  archivedMonth: string | null;
}

interface MemberRow {
  id: string;
  userId: string;
  role: string | null;
  userName: string | null;
  userEmail: string | null;
}

interface TimeLogRow {
  id: string;
  userId: string;
  userName: string | null;
  projectId: string | null;
  projectName: string | null;
  clientName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  minutes: number;
  workDate: string | null;
  day: string;
  note: string | null;
}

const take = <T>(rows: T[], n: number | undefined): T[] => (n ? rows.slice(0, n) : rows);

const leanProject = (p: ProjectRow) => ({
  id: p.id,
  name: p.name,
  clientId: p.clientId,
  clientName: p.clientName,
  type: p.type,
  status: p.status,
  health: p.health,
  billingType: p.billingType,
  contractValuePaise: p.contractValue,
  recurringPaise: p.recurringPaise,
  startDate: p.startDate,
  deadline: p.deadline,
  tasks: `${p.tasksDone}/${p.tasksTotal} done`,
  milestones: `${p.milestonesDone}/${p.milestonesTotal} done`,
  memberCount: p.memberCount,
});

const leanBoardTask = (t: BoardTaskRow) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority,
  startDate: t.startDate,
  dueDate: t.dueDate,
  estimateMinutes: t.estimateMinutes,
  milestoneId: t.milestoneId,
  parentTaskId: t.parentTaskId,
  assignees: (t.assignees ?? []).map((a) => ({ userId: a.userId, name: a.name })),
  labels: (t.labels ?? []).map((l) => l.name),
  subtasks: t.subtaskCount ? `${t.subtaskDoneCount ?? 0}/${t.subtaskCount} done` : undefined,
  blockedByCount: t.blockedByCount || undefined,
  commentCount: t.commentCount || undefined,
});

const leanLog = (l: TimeLogRow) => ({
  id: l.id,
  day: l.day,
  minutes: l.minutes,
  userId: l.userId,
  userName: l.userName,
  projectId: l.projectId,
  projectName: l.projectName,
  clientName: l.clientName,
  taskId: l.taskId,
  taskTitle: l.taskTitle,
  note: l.note,
});

/** Same "today" boundaries the API uses for due buckets (server-local midnight). */
function dueBucket(dueIso: string | null, now = new Date()): (typeof DUE_FILTERS)[number] | 'later' {
  if (!dueIso) return 'none';
  const due = new Date(dueIso).getTime();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const endOfWeek = new Date(startOfToday);
  endOfWeek.setDate(endOfWeek.getDate() + 7);
  if (due < startOfToday.getTime()) return 'overdue';
  if (due < startOfTomorrow.getTime()) return 'today';
  if (due < endOfWeek.getTime()) return 'week';
  return 'later';
}

export const workTools: SanctumTool[] = [
  // ==========================================================================
  //  PROJECTS
  // ==========================================================================
  defineTool({
    name: 'projects_list',
    title: 'List projects',
    description:
      'Lists the projects the person can see, with client, status, health, billing and task/milestone progress. Filter by status, health, client (id from clients_list) or a name search. Money fields are in paise and are null when the person cannot see project financials. Use projects_get or projects_overview for one project.',
    anyOf: ['projects.view'],
    kind: 'read',
    input: {
      status: z.enum(PROJECT_STATUSES).optional(),
      health: z.enum(PROJECT_HEALTH).optional(),
      clientId: z.string().min(1).optional().describe('Only projects for this client (id from clients_list)'),
      search: z.string().optional().describe('Text to match in the project name'),
      limit,
    },
    run: async ({ status, health, clientId, search, limit: n }, { api }) => {
      const rows = await api.get<ProjectRow[]>('/projects', { status, health, clientId, search });
      return take(rows, n).map(leanProject);
    },
  }),

  defineTool({
    name: 'projects_get',
    title: 'Get a project',
    description:
      'Full details of one project: client, scope of work, description, services, type, status, health, dates, billing (contractValue and recurringPaise are in paise; null without financial access), counts and what the person may do on it (capabilities). Find the id with projects_list.',
    anyOf: ['projects.view'],
    kind: 'read',
    input: { projectId },
    run: ({ projectId }, { api }) => api.get(`/projects/${seg(projectId)}`),
  }),

  defineTool({
    name: 'projects_overview',
    title: 'Project overview',
    description:
      'Dashboard numbers for one project: tasks by status, milestones done, member count, total logged minutes, running timers and the latest activity. Find the id with projects_list.',
    anyOf: ['projects.view'],
    kind: 'read',
    input: { projectId },
    run: ({ projectId }, { api }) => api.get(`/projects/${seg(projectId)}/overview`),
  }),

  defineTool({
    name: 'projects_milestone_templates',
    title: 'Milestone templates by service',
    description:
      'The standard milestone presets per service (e.g. what milestones a website or SEO project usually has) and which services are continuous (no milestones). Use it to suggest `services` and `milestones` for projects_create.',
    anyOf: ['projects.view'],
    kind: 'read',
    input: {},
    run: (_args, { api }) => api.get('/projects/milestone-templates'),
  }),

  defineTool({
    name: 'projects_create',
    title: 'Create a project',
    description:
      'Creates a project for a client (client id from clients_list). The creator becomes a project lead automatically. Billing: billingType "one_time" uses contractValueRupees (spread over startDate→deadline for revenue); "retainer" uses recurringRupees per month. Setting any money field needs the "update project financials" permission. Optional milestones are created with the project (see projects_milestone_templates for presets; needs milestone permission). Add more people with projects_members_add.',
    anyOf: ['projects.create'],
    kind: 'write',
    input: {
      name: z.string().min(1).max(160),
      clientId: id('Client').describe('Client id (from clients_list)'),
      scopeOfWork: z.string().max(5000).optional(),
      description: z.string().max(5000).optional(),
      services: z.array(z.string().max(60)).max(30).optional().describe('Service names, e.g. ["Website", "SEO"]'),
      type: z.enum(PROJECT_TYPES).optional().describe('Default fixed_price'),
      status: z.enum(PROJECT_STATUSES).optional().describe('Default planning'),
      health: z.enum(PROJECT_HEALTH).optional().describe('Default on_track'),
      billingType: z.enum(BILLING_TYPES).optional().describe('one_time (default) or retainer'),
      contractValueRupees: z.number().nonnegative().optional().describe('Total contract value in rupees'),
      recurringRupees: z.number().nonnegative().optional().describe('Monthly retainer fee in rupees (billingType retainer)'),
      currency: z.string().trim().max(8).optional().describe('Default INR'),
      startDate: isoDate('Start date').optional(),
      deadline: isoDate('Deadline').optional(),
      milestones: z
        .array(
          z.object({
            title: z.string().trim().min(1).max(200),
            description: z.string().trim().max(1000).optional(),
            dueDate: isoDate('Milestone due date').optional(),
          }),
        )
        .max(30)
        .optional()
        .describe('Milestones to create with the project, in order'),
    },
    run: ({ contractValueRupees, recurringRupees, ...rest }, { api }) =>
      api.post(
        '/projects',
        compact({
          ...rest,
          contractValue: paise(contractValueRupees),
          recurringPaise: paise(recurringRupees),
        }),
      ),
  }),

  defineTool({
    name: 'projects_update',
    title: 'Update a project',
    description:
      'Changes a project. Only the fields you pass are changed; pass null to clear scopeOfWork, description, startDate or deadline. Can move the project to another client (id from clients_list). Changing money fields (billingType, contractValueRupees, recurringRupees) needs the "update project financials" permission. Find the id with projects_list.',
    anyOf: ['projects.update'],
    kind: 'write',
    input: {
      projectId,
      name: z.string().min(1).max(160).optional(),
      clientId: z.string().min(1).optional().describe('Move to this client (id from clients_list)'),
      scopeOfWork: z.string().max(5000).nullable().optional(),
      description: z.string().max(5000).nullable().optional(),
      services: z.array(z.string().max(60)).max(30).optional().describe('Replaces the full services list'),
      type: z.enum(PROJECT_TYPES).optional(),
      status: z.enum(PROJECT_STATUSES).optional(),
      health: z.enum(PROJECT_HEALTH).optional(),
      billingType: z.enum(BILLING_TYPES).optional(),
      contractValueRupees: z.number().nonnegative().optional().describe('Total contract value in rupees'),
      recurringRupees: z.number().nonnegative().optional().describe('Monthly retainer fee in rupees'),
      currency: z.string().trim().max(8).optional(),
      startDate: isoDate('Start date').nullable().optional(),
      deadline: isoDate('Deadline').nullable().optional(),
    },
    run: ({ projectId, contractValueRupees, recurringRupees, ...rest }, { api }) =>
      api.patch(
        `/projects/${seg(projectId)}`,
        compact({
          ...rest,
          contractValue: paise(contractValueRupees),
          recurringPaise: paise(recurringRupees),
        }),
      ),
  }),

  defineTool({
    name: 'projects_delete',
    title: 'Delete a project',
    description:
      'Permanently deletes a project together with its tasks, milestones, labels, comments and memberships. To pause or close a project instead, use projects_update with status on_hold / completed / cancelled. Find the id with projects_list.',
    anyOf: ['projects.delete'],
    kind: 'delete',
    input: { projectId },
    run: ({ projectId }, { api }) => api.delete(`/projects/${seg(projectId)}`),
  }),

  defineTool({
    name: 'projects_activity',
    title: 'Project activity feed',
    description:
      'Recent activity in a project (task changes, comments, milestones, members, time), newest first, limited to what the person may see. Find the id with projects_list.',
    anyOf: ['projects.view'],
    kind: 'read',
    input: { projectId, limit: limit.describe('Max entries (default 50)') },
    run: ({ projectId, limit: n }, { api }) =>
      api.get(`/projects/${seg(projectId)}/activity`, { limit: n }),
  }),

  // ---- Members ----------------------------------------------------------------
  defineTool({
    name: 'projects_members_list',
    title: 'List project members',
    description:
      'People on a project with their role (lead / member). `id` is the membership id (used by projects_members_remove); `userId` is the person. Find the project id with projects_list.',
    anyOf: ['projects.view'],
    kind: 'read',
    input: { projectId },
    run: async ({ projectId }, { api }) => {
      const rows = await api.get<MemberRow[]>(`/projects/${seg(projectId)}/members`);
      return rows.map((m) => ({ id: m.id, userId: m.userId, name: m.userName, email: m.userEmail, role: m.role }));
    },
  }),

  defineTool({
    name: 'projects_members_add',
    title: 'Add a project member',
    description:
      'Adds an active team member to a project as lead or member (default member). The user id comes from team_list; the project id from projects_list. Adding someone already on the project is a no-op.',
    anyOf: ['projects.manage_members'],
    kind: 'write',
    input: {
      projectId,
      userId: id('User').describe('Team member user id (from team_list)'),
      role: z.enum(MEMBER_ROLES).optional().describe('lead or member (default member)'),
    },
    run: ({ projectId, userId, role }, { api }) =>
      api.post(`/projects/${seg(projectId)}/members`, compact({ userId, role })),
  }),

  defineTool({
    name: 'projects_members_remove',
    title: 'Remove a project member',
    description:
      'Removes a person from a project (they can be re-added with projects_members_add). Pass either the membership id (`id` from projects_members_list) or the person\'s userId (from team_list / projects_members_list). Their tasks are not reassigned.',
    anyOf: ['projects.manage_members'],
    kind: 'write',
    input: {
      projectId,
      memberId: z.string().min(1).optional().describe('Membership id (`id` from projects_members_list)'),
      userId: z.string().min(1).optional().describe('The person\'s user id, if you don\'t have the membership id'),
    },
    run: async ({ projectId, memberId, userId }, { api }) => {
      let mid = memberId;
      if (!mid) {
        if (!userId) throw new Error('Pass memberId or userId.');
        const rows = await api.get<MemberRow[]>(`/projects/${seg(projectId)}/members`);
        mid = rows.find((m) => m.userId === userId)?.id;
        if (!mid) throw new Error('That person is not a member of this project.');
      }
      return api.delete(`/projects/${seg(projectId)}/members/${seg(mid)}`);
    },
  }),

  // ---- Milestones ---------------------------------------------------------------
  defineTool({
    name: 'projects_milestones_list',
    title: 'List project milestones',
    description: 'Milestones of a project in order, with due date and status (pending / completed). Find the project id with projects_list.',
    anyOf: ['projects.view'],
    kind: 'read',
    input: { projectId },
    run: ({ projectId }, { api }) => api.get(`/projects/${seg(projectId)}/milestones`),
  }),

  defineTool({
    name: 'projects_milestones_create',
    title: 'Add a milestone',
    description: 'Adds a milestone to a project. Find the project id with projects_list.',
    anyOf: ['project_milestones.manage'],
    kind: 'write',
    input: {
      projectId,
      title: z.string().min(1).max(200),
      description: z.string().max(5000).optional(),
      dueDate: isoDate('Due date').optional(),
      status: z.enum(MILESTONE_STATUSES).optional().describe('Default pending'),
      position: z.number().int().min(0).optional().describe('Order within the project (0 = first)'),
    },
    run: ({ projectId, ...body }, { api }) =>
      api.post(`/projects/${seg(projectId)}/milestones`, compact(body)),
  }),

  defineTool({
    name: 'projects_milestones_update',
    title: 'Update a milestone',
    description:
      'Changes a milestone (title, description, due date, order) or marks it completed / pending. Only passed fields change; null clears description or dueDate. Milestone ids come from projects_milestones_list.',
    anyOf: ['project_milestones.manage'],
    kind: 'write',
    input: {
      projectId,
      milestoneId: id('Milestone').describe('Milestone id (from projects_milestones_list)'),
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(5000).nullable().optional(),
      dueDate: isoDate('Due date').nullable().optional(),
      status: z.enum(MILESTONE_STATUSES).optional(),
      position: z.number().int().min(0).optional(),
    },
    run: ({ projectId, milestoneId, ...body }, { api }) =>
      api.patch(`/projects/${seg(projectId)}/milestones/${seg(milestoneId)}`, compact(body)),
  }),

  defineTool({
    name: 'projects_milestones_delete',
    title: 'Delete a milestone',
    description:
      'Permanently deletes a milestone. Its tasks are kept but no longer belong to any milestone. Milestone ids come from projects_milestones_list.',
    anyOf: ['project_milestones.manage'],
    kind: 'delete',
    input: { projectId, milestoneId: id('Milestone').describe('Milestone id (from projects_milestones_list)') },
    run: ({ projectId, milestoneId }, { api }) =>
      api.delete(`/projects/${seg(projectId)}/milestones/${seg(milestoneId)}`),
  }),

  // ---- Labels -------------------------------------------------------------------
  defineTool({
    name: 'projects_labels_list',
    title: 'List task labels',
    description: 'The task labels defined in a project (id, name, color). Use the ids with tasks_set_labels or the label filter of tasks_list_project.',
    anyOf: ['projects.view'],
    kind: 'read',
    input: { projectId },
    run: ({ projectId }, { api }) => api.get(`/projects/${seg(projectId)}/labels`),
  }),

  defineTool({
    name: 'projects_labels_create',
    title: 'Create a task label',
    description: 'Creates a task label in a project. Names are unique per project. Find the project id with projects_list.',
    anyOf: ['project_labels.manage'],
    kind: 'write',
    input: {
      projectId,
      name: z.string().trim().min(1).max(60),
      color: z.enum(LABEL_COLORS).optional().describe('Default pine'),
    },
    run: ({ projectId, ...body }, { api }) =>
      api.post(`/projects/${seg(projectId)}/labels`, compact(body)),
  }),

  defineTool({
    name: 'projects_labels_update',
    title: 'Rename or recolor a label',
    description: 'Renames or recolors a project task label. Label ids come from projects_labels_list.',
    anyOf: ['project_labels.manage'],
    kind: 'write',
    input: {
      projectId,
      labelId: id('Label').describe('Label id (from projects_labels_list)'),
      name: z.string().trim().min(1).max(60).optional(),
      color: z.enum(LABEL_COLORS).optional(),
    },
    run: ({ projectId, labelId, ...body }, { api }) =>
      api.patch(`/projects/${seg(projectId)}/labels/${seg(labelId)}`, compact(body)),
  }),

  defineTool({
    name: 'projects_labels_delete',
    title: 'Delete a label',
    description: 'Permanently deletes a project task label and removes it from every task. Label ids come from projects_labels_list.',
    anyOf: ['project_labels.manage'],
    kind: 'delete',
    input: { projectId, labelId: id('Label').describe('Label id (from projects_labels_list)') },
    run: ({ projectId, labelId }, { api }) =>
      api.delete(`/projects/${seg(projectId)}/labels/${seg(labelId)}`),
  }),

  // ---- Project time -----------------------------------------------------------
  defineTool({
    name: 'projects_time_summary',
    title: 'Project time summary',
    description:
      'Time logged on a project: total minutes, minutes per person, top tasks by minutes and running timers (within what the person may see). Set includeLogs to also get the latest individual time entries. Find the project id with projects_list.',
    anyOf: ['time_logs.view'],
    kind: 'read',
    input: {
      projectId,
      includeLogs: z.boolean().optional().describe('Also return recent time entries'),
      logsLimit: limit.describe('Max time entries when includeLogs is true (default 50)'),
    },
    run: async ({ projectId, includeLogs, logsLimit }, { api }) => {
      const summary = await api.get<Record<string, unknown>>(`/projects/${seg(projectId)}/time-summary`);
      if (!includeLogs) return summary;
      const logs = await api.get(`/projects/${seg(projectId)}/time-logs`, { limit: logsLimit });
      return { ...summary, recentLogs: logs };
    },
  }),

  // ==========================================================================
  //  TASKS
  // ==========================================================================
  defineTool({
    name: 'tasks_list',
    title: 'List tasks (all projects)',
    description:
      'Tasks across every project the person can see, newest first (max 500). Filter by project (projects_list), client (clients_list), status, priority, primary assignee (user id from team_list) or a title search. Set archived=true to see the month-wise archive of unfinished past-month tasks (optionally one month, YYYY-MM). For richer filters within one project (due buckets, labels, several assignees, sorting) use tasks_list_project; for the person\'s own tasks use my_tasks.',
    anyOf: ['tasks.view'],
    kind: 'read',
    input: {
      projectId: z.string().min(1).optional().describe('Only this project (id from projects_list)'),
      clientId: z.string().min(1).optional().describe('Only this client (id from clients_list)'),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      assigneeId: z.string().min(1).optional().describe('Primary assignee user id (from team_list)'),
      search: z.string().optional().describe('Text to match in the task title'),
      archived: z.boolean().optional().describe('true = only archived tasks'),
      month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Archive month YYYY-MM (with archived=true)'),
      limit,
    },
    run: async ({ archived, limit: n, ...q }, { api }) => {
      const rows = await api.get<AllTasksRow[]>('/projects/all-tasks', {
        ...q,
        archived: archived ? 'true' : undefined,
      });
      return take(rows, n).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate,
        projectId: t.projectId,
        projectName: t.projectName,
        clientName: t.clientName,
        assigneeId: t.assigneeId,
        assigneeName: t.assigneeName,
        parentTaskId: t.parentTaskId,
        archivedMonth: t.archivedMonth ?? undefined,
      }));
    },
  }),

  defineTool({
    name: 'tasks_list_project',
    title: 'List a project\'s tasks',
    description:
      'The active tasks of one project with assignees, labels, subtask progress and comment counts. Filters combine: statuses, assignees (user ids from team_list, or "unassigned"), priorities, labels (projects_labels_list), milestones (projects_milestones_list), due bucket (overdue / today / week = next 7 days / none) and title search. Sort by manual (default), priority, due, created, updated or title.',
    anyOf: ['tasks.view'],
    kind: 'read',
    input: {
      projectId,
      status: z.array(z.enum(TASK_STATUSES)).optional(),
      assignee: z.array(z.string().min(1)).optional().describe('User ids (from team_list); "unassigned" matches tasks with nobody'),
      priority: z.array(z.enum(TASK_PRIORITIES)).optional(),
      label: z.array(z.string().min(1)).optional().describe('Label ids (from projects_labels_list)'),
      milestone: z.array(z.string().min(1)).optional().describe('Milestone ids (from projects_milestones_list)'),
      due: z.enum(DUE_FILTERS).optional(),
      q: z.string().trim().max(200).optional().describe('Text to match in the task title'),
      sort: z.enum(TASK_SORTS).optional(),
      dir: z.enum(['asc', 'desc']).optional(),
      includeSubtasks: z.boolean().optional().describe('Default true; false = top-level tasks only'),
      limit,
    },
    run: async ({ projectId, includeSubtasks, limit: n, ...q }, { api }) => {
      const rows = await api.get<BoardTaskRow[]>(`/projects/${seg(projectId)}/tasks`, {
        ...q,
        includeSubtasks: includeSubtasks === undefined ? undefined : String(includeSubtasks),
      });
      return take(rows, n).map(leanBoardTask);
    },
  }),

  defineTool({
    name: 'tasks_get',
    title: 'Get a task',
    description:
      'Full details of one task: fields, assignees, labels, subtasks, dependencies (blockedBy / blocks, each with a depId used by tasks_dependency_remove), comments and the change history. Needs the task id and its projectId (both from tasks_list, tasks_list_project or my_tasks).',
    anyOf: ['tasks.view'],
    kind: 'read',
    input: { projectId, taskId },
    run: async ({ projectId, taskId }, { api }) => {
      const d = await api.get<{
        task: unknown;
        subtasks?: BoardTaskRow[];
        dependencies?: unknown;
        comments?: unknown;
        activity?: unknown;
      }>(`/projects/${seg(projectId)}/tasks/${seg(taskId)}`);
      return {
        task: d.task,
        subtasks: (d.subtasks ?? []).map(leanBoardTask),
        dependencies: d.dependencies,
        comments: d.comments,
        activity: d.activity,
      };
    },
  }),

  defineTool({
    name: 'tasks_create',
    title: 'Create a task',
    description:
      'Creates a task (or a subtask, with parentTaskId) in a project (id from projects_list). Assignees are user ids from team_list; with no assignees the task is assigned to the person creating it. Assigning other people needs the "assign tasks" permission, and new assignees get a notification. Subtasks are one level deep and inherit the parent\'s milestone.',
    anyOf: ['tasks.create'],
    kind: 'write',
    input: {
      projectId,
      title: z.string().min(1).max(200),
      description: z.string().max(5000).optional(),
      status: z.enum(TASK_STATUSES).optional().describe('Default todo'),
      priority: z.enum(TASK_PRIORITIES).optional().describe('Default none'),
      assigneeIds: z.array(z.string().min(1)).max(20).optional().describe('User ids (from team_list); first is the primary assignee'),
      dueDate: isoDate('Due date').optional(),
      startDate: isoDate('Start date').optional(),
      estimateMinutes: z.number().int().min(0).optional().describe('Estimated effort in minutes'),
      milestoneId: z.string().min(1).optional().describe('Milestone id (from projects_milestones_list)'),
      parentTaskId: z.string().min(1).optional().describe('Make this a subtask of that top-level task'),
    },
    run: ({ projectId, ...body }, { api }) =>
      api.post(`/projects/${seg(projectId)}/tasks`, compact(body)),
  }),

  defineTool({
    name: 'tasks_create_bulk',
    title: 'Create many tasks',
    description:
      'Quickly creates up to 200 unassigned tasks in a project from a list of titles (added at the end of the board), optionally in one milestone and status. Use tasks_update afterwards to assign or date them.',
    anyOf: ['tasks.create'],
    kind: 'write',
    input: {
      projectId,
      titles: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
      milestoneId: z.string().min(1).optional().describe('Milestone id (from projects_milestones_list)'),
      status: z.enum(TASK_STATUSES).optional(),
    },
    run: async ({ projectId, ...body }, { api }) => {
      const rows = await api.post<BoardTaskRow[]>(`/projects/${seg(projectId)}/tasks/bulk`, compact(body));
      return rows.map((t) => ({ id: t.id, title: t.title, status: t.status }));
    },
  }),

  defineTool({
    name: 'tasks_update',
    title: 'Update a task',
    description:
      'Changes a task: title, description, status, priority, due/start date, estimate, milestone, parent, or assignees. Only passed fields change; null clears description, dates, estimate, milestone or parent. assigneeIds REPLACES the whole assignee list (pass [] to unassign; user ids from team_list); assigning anyone other than just yourself needs the "assign tasks" permission, and newly added assignees are notified. Setting status to done stops any running timers on the task (saving their time) and may mark a linked content post as posted. Needs projectId + taskId (from tasks_list, tasks_list_project or my_tasks).',
    anyOf: ['tasks.update'],
    kind: 'write',
    input: {
      projectId,
      taskId,
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(5000).nullable().optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      assigneeIds: z.array(z.string().min(1)).max(20).optional().describe('Full new assignee list (user ids from team_list)'),
      dueDate: isoDate('Due date').nullable().optional(),
      startDate: isoDate('Start date').nullable().optional(),
      estimateMinutes: z.number().int().min(0).nullable().optional().describe('Estimated effort in minutes'),
      milestoneId: z.string().min(1).nullable().optional().describe('Milestone id (from projects_milestones_list)'),
      parentTaskId: z.string().min(1).nullable().optional().describe('Top-level task to nest under; null = make top-level'),
    },
    run: ({ projectId, taskId, ...body }, { api }) =>
      api.patch(`/projects/${seg(projectId)}/tasks/${seg(taskId)}`, compact(body)),
  }),

  defineTool({
    name: 'tasks_delete',
    title: 'Delete a task',
    description:
      'Permanently deletes a task with its comments, labels and dependencies (logged time is kept, without the task). Being an assignee does not allow deleting. Needs projectId + taskId (from tasks_list or tasks_list_project).',
    anyOf: ['tasks.delete'],
    kind: 'delete',
    input: { projectId, taskId },
    run: ({ projectId, taskId }, { api }) =>
      api.delete(`/projects/${seg(projectId)}/tasks/${seg(taskId)}`),
  }),

  defineTool({
    name: 'tasks_unarchive',
    title: 'Restore an archived task',
    description:
      'Brings an archived task (an unfinished task swept into a past month\'s archive) back onto the active board. Find archived tasks with tasks_list (archived=true) or my_tasks (archived=true).',
    anyOf: ['tasks.restore'],
    kind: 'write',
    input: { taskId },
    run: ({ taskId }, { api }) => api.post(`/projects/tasks/${seg(taskId)}/unarchive`),
  }),

  defineTool({
    name: 'tasks_set_labels',
    title: 'Set a task\'s labels',
    description:
      'Replaces the full set of labels on a task (pass [] to remove all). Label ids must belong to the task\'s project (from projects_labels_list).',
    anyOf: ['tasks.update'],
    kind: 'write',
    input: {
      projectId,
      taskId,
      labelIds: z.array(z.string().min(1)).max(50).describe('Label ids (from projects_labels_list)'),
    },
    run: ({ projectId, taskId, labelIds }, { api }) =>
      api.put(`/projects/${seg(projectId)}/tasks/${seg(taskId)}/labels`, { labelIds }),
  }),

  defineTool({
    name: 'tasks_dependency_add',
    title: 'Add a task dependency',
    description:
      'Links two tasks in the same project: type "blocks" = this task blocks the other; "blocked_by" = this task waits on the other. Cycles and duplicates are rejected. Task ids from tasks_list_project.',
    anyOf: ['tasks.update'],
    kind: 'write',
    input: {
      projectId,
      taskId,
      type: z.enum(['blocks', 'blocked_by']),
      otherTaskId: id('Other task').describe('The other task in the same project'),
    },
    run: ({ projectId, taskId, type, otherTaskId }, { api }) =>
      api.post(`/projects/${seg(projectId)}/tasks/${seg(taskId)}/dependencies`, { type, otherTaskId }),
  }),

  defineTool({
    name: 'tasks_dependency_remove',
    title: 'Remove a task dependency',
    description:
      'Removes a blocks / blocked-by link from a task. The depId comes from tasks_get (dependencies.blockedBy[].depId or dependencies.blocks[].depId).',
    anyOf: ['tasks.update'],
    kind: 'write',
    input: { projectId, taskId, depId: id('Dependency').describe('depId from tasks_get') },
    run: ({ projectId, taskId, depId }, { api }) =>
      api.delete(`/projects/${seg(projectId)}/tasks/${seg(taskId)}/dependencies/${seg(depId)}`),
  }),

  // ---- Comments -----------------------------------------------------------------
  defineTool({
    name: 'tasks_comment_add',
    title: 'Comment on a task',
    description:
      'Posts a comment on a task as the signed-in person. Mention teammates by user id in `mentions` (from team_list) or by writing @name in the text. Existing comments are shown by tasks_get. Needs projectId + taskId (from tasks_list, tasks_list_project or my_tasks).',
    anyOf: ['task_comments.create'],
    kind: 'write',
    input: {
      projectId,
      taskId,
      body: z.string().trim().min(1).max(5000).describe('Comment text'),
      mentions: z.array(z.string().min(1)).max(50).optional().describe('User ids to mention (from team_list)'),
    },
    run: ({ projectId, taskId, body, mentions }, { api }) =>
      api.post(`/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments`, compact({ body, mentions })),
  }),

  defineTool({
    name: 'tasks_comment_update',
    title: 'Edit a task comment',
    description:
      'Replaces the text of a task comment (usually only your own). Comment ids come from tasks_get (comments[].id).',
    anyOf: ['task_comments.update'],
    kind: 'write',
    input: {
      projectId,
      taskId,
      commentId: id('Comment').describe('Comment id (from tasks_get)'),
      body: z.string().trim().min(1).max(5000),
      mentions: z.array(z.string().min(1)).max(50).optional().describe('User ids to mention (from team_list)'),
    },
    run: ({ projectId, taskId, commentId, body, mentions }, { api }) =>
      api.patch(
        `/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments/${seg(commentId)}`,
        compact({ body, mentions }),
      ),
  }),

  defineTool({
    name: 'tasks_comment_delete',
    title: 'Delete a task comment',
    description:
      'Deletes a task comment (usually only your own); it cannot be restored. Comment ids come from tasks_get (comments[].id).',
    anyOf: ['task_comments.delete'],
    kind: 'delete',
    input: { projectId, taskId, commentId: id('Comment').describe('Comment id (from tasks_get)') },
    run: ({ projectId, taskId, commentId }, { api }) =>
      api.delete(`/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments/${seg(commentId)}`),
  }),

  defineTool({
    name: 'tasks_time_logs',
    title: 'Time logged on a task',
    description:
      'Time entries on one task (who, when, minutes, note), total minutes and how many timers are running on it. Needs projectId + taskId (from tasks_list, tasks_list_project or my_tasks).',
    anyOf: ['time_logs.view'],
    kind: 'read',
    input: { projectId, taskId },
    run: ({ projectId, taskId }, { api }) =>
      api.get(`/projects/${seg(projectId)}/tasks/${seg(taskId)}/time-logs`),
  }),

  // ==========================================================================
  //  MY WORK
  // ==========================================================================
  defineTool({
    name: 'my_tasks',
    title: 'My tasks',
    description:
      'Tasks assigned to the signed-in person across all projects, nearest due date first. Done tasks are hidden unless status=done or includeDone=true. Use due="overdue" / "today" / "week" (next 7 days) / "none" (no due date) for "what\'s overdue / due today". archived=true shows their unfinished tasks from past months\' archive.',
    anyOf: ['tasks.view'],
    kind: 'read',
    input: {
      status: z.enum(TASK_STATUSES).optional(),
      includeDone: z.boolean().optional(),
      due: z.enum(DUE_FILTERS).optional().describe('overdue, today, week (next 7 days, incl. today) or none'),
      archived: z.boolean().optional().describe('true = only archived tasks'),
      limit,
    },
    run: async ({ status, includeDone, due, archived, limit: n }, { api }) => {
      const rows = await api.get<MyTaskRow[]>('/me/tasks', {
        status,
        includeDone: includeDone ? 'true' : undefined,
        archived: archived ? 'true' : undefined,
      });
      const now = new Date();
      const filtered = due
        ? rows.filter((t) => {
            const b = dueBucket(t.dueDate, now);
            return due === 'week' ? b === 'today' || b === 'week' : b === due;
          })
        : rows;
      return take(filtered, n).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate,
        projectId: t.projectId,
        projectName: t.projectName,
        clientName: t.clientName,
        archivedMonth: t.archivedMonth ?? undefined,
      }));
    },
  }),

  defineTool({
    name: 'my_overview',
    title: 'My day',
    description:
      'The signed-in person\'s headline numbers: open tasks, overdue tasks, tasks due today, and minutes logged today and this week (null if they cannot see time).',
    anyOf: ['tasks.view'],
    kind: 'read',
    input: {},
    run: (_args, { api }) => api.get('/me/overview'),
  }),

  // ==========================================================================
  //  TIMERS
  // ==========================================================================
  defineTool({
    name: 'timers_start',
    title: 'Start a timer',
    description:
      'Starts the signed-in person\'s timer on a project, optionally on a task in it. Only one timer runs per person: if one is already running it is stopped first and its time is saved. Ids come from my_tasks / tasks_list (both give projectId and task id) or projects_list.',
    anyOf: ['timers.use'],
    kind: 'write',
    input: {
      projectId,
      taskId: z.string().min(1).optional().describe('Task id in that project (from my_tasks or tasks_list)'),
      note: z.string().trim().max(2000).optional().describe('What you are working on'),
    },
    run: ({ projectId, taskId, note }, { api }) => api.post('/timers/start', compact({ projectId, taskId, note })),
  }),

  defineTool({
    name: 'timers_stop',
    title: 'Stop my timer',
    description:
      'Stops the signed-in person\'s running timer and saves the elapsed time as a time entry (returned, with minutes).',
    anyOf: ['timers.use'],
    kind: 'write',
    input: {},
    run: (_args, { api }) => api.post('/timers/stop'),
  }),

  defineTool({
    name: 'timers_active',
    title: 'My running timer',
    description:
      'The signed-in person\'s running timer (project, task, start time, elapsed minutes), or null if none is running.',
    anyOf: ['timers.use'],
    kind: 'read',
    input: {},
    run: async (_args, { api }) => (await api.get('/timers/active')) ?? { running: false },
  }),

  // ==========================================================================
  //  TIMESHEET
  // ==========================================================================
  defineTool({
    name: 'timesheet_log_time',
    title: 'Log time manually',
    description:
      'Adds a time entry for the signed-in person (e.g. they forgot to start the timer). Give either durationMinutes, or startTime + endTime on that date. The date cannot be in the future. Project and task ids come from projects_list / my_tasks / tasks_list.',
    anyOf: ['timers.use', 'time_logs.create'],
    kind: 'write',
    input: {
      projectId,
      taskId: z.string().min(1).optional().describe('Task id in that project (from my_tasks or tasks_list)'),
      date: dayKey('Day the work was done'),
      durationMinutes: z.number().int().min(1).max(1440).optional().describe('Time spent in minutes (e.g. 90 for 1.5 h)'),
      startTime: clock('Start time').optional(),
      endTime: clock('End time').optional(),
      note: z.string().trim().max(2000).optional(),
    },
    run: ({ projectId, taskId, date, durationMinutes, startTime, endTime, note }, { api }) =>
      api.post(
        '/timers/logs',
        compact({ projectId, taskId, date, minutes: durationMinutes, startTime, endTime, note }),
      ),
  }),

  defineTool({
    name: 'timesheet_entries',
    title: 'Timesheet entries',
    description:
      'A person\'s time entries over a date range (default: this Monday–Sunday week; max 92 days) across all projects, with per-day totals and the working-day target. Defaults to the signed-in person; another person\'s timesheet (userId from team_list) needs organization-wide time-log access. Entry ids are used by timesheet_update_entry / timesheet_delete_entry.',
    anyOf: ['timers.use', 'time_logs.view'],
    kind: 'read',
    input: {
      from: dayKey('First day').optional(),
      to: dayKey('Last day').optional(),
      userId: z.string().min(1).optional().describe('Team member user id (from team_list); default = me'),
    },
    run: async ({ from, to, userId }, { api }) => {
      const r = await api.get<Record<string, unknown> & { logs?: TimeLogRow[] }>('/timers/logs', {
        from,
        to,
        userId,
      });
      return { ...r, logs: (r.logs ?? []).map(leanLog) };
    },
  }),

  defineTool({
    name: 'timesheet_team_summary',
    title: 'Team timesheet',
    description:
      'Team view for managers: minutes logged per person and per day over a date range (default: this Monday–Sunday week; max 92 days), the working-day target, and who has a timer running. Needs organization-wide time-log access. Set includeDailyBreakdown for each person\'s per-day minutes.',
    anyOf: ['time_logs.view'],
    kind: 'read',
    input: {
      from: dayKey('First day').optional(),
      to: dayKey('Last day').optional(),
      includeDailyBreakdown: z.boolean().optional().describe('Include each person\'s minutes per day'),
    },
    run: async ({ from, to, includeDailyBreakdown }, { api }) => {
      const r = await api.get<Record<string, unknown> & { people?: Array<Record<string, unknown>> }>(
        '/timers/summary',
        { from, to },
      );
      if (includeDailyBreakdown) return r;
      return {
        ...r,
        people: (r.people ?? []).map((p) => {
          const lean: Record<string, unknown> = { ...p };
          delete lean.days;
          return lean;
        }),
      };
    },
  }),

  defineTool({
    name: 'timesheet_update_entry',
    title: 'Edit a time entry',
    description:
      'Changes a time entry: duration, date (not in the future), note (null clears), project or task (null removes the task). Moving to another project drops the task unless a new one is given. Usually only your own entries. Entry ids come from timesheet_entries, projects_time_summary (includeLogs) or tasks_time_logs.',
    anyOf: ['time_logs.update'],
    kind: 'write',
    input: {
      logId: id('Time entry').describe('Time entry id (from timesheet_entries)'),
      durationMinutes: z.number().int().min(1).max(1440).optional().describe('New time spent in minutes'),
      date: dayKey('New day').optional(),
      note: z.string().trim().max(2000).nullable().optional(),
      projectId: z.string().min(1).optional().describe('Move to this project (id from projects_list)'),
      taskId: z.string().min(1).nullable().optional().describe('Task in the (new) project; null = no task'),
    },
    run: ({ logId, durationMinutes, ...rest }, { api }) =>
      api.patch(`/timers/logs/${seg(logId)}`, compact({ ...rest, minutes: durationMinutes })),
  }),

  defineTool({
    name: 'timesheet_delete_entry',
    title: 'Delete a time entry',
    description:
      'Permanently deletes a time entry (usually only your own). Entry ids come from timesheet_entries, projects_time_summary (includeLogs) or tasks_time_logs.',
    anyOf: ['time_logs.delete'],
    kind: 'delete',
    input: { logId: id('Time entry').describe('Time entry id (from timesheet_entries)') },
    run: ({ logId }, { api }) => api.delete(`/timers/logs/${seg(logId)}`),
  }),
];
