/**
 * People & ops tools: team directory, attendance, leave, regularizations,
 * messages, notifications, documents (metadata only) and the client content
 * calendar (posts + staff-side approval actions).
 *
 * Every tool calls the REST API through ctx.api; the API enforces permissions
 * and scopes. Deliberately NOT exposed (README out-of-scope / security):
 * role/grant/override changes, enabling/disabling accounts (revokes sessions),
 * password resets, session revocation, client portal accounts, binary uploads,
 * AI generation and social publishing.
 */
import { z } from 'zod';
import { defineTool, seg, compact, id, isoDate, limit, type SanctumTool } from '../tool-kit.js';

// ============================================================
//  Helpers
// ============================================================

/** List endpoints return an array, or `{ items, ... }` when the envelope carries extras. */
function rowsOf<T>(res: T[] | { items?: T[] } | null | undefined): T[] {
  if (Array.isArray(res)) return res;
  return res?.items ?? [];
}

/** ISO date or timestamp → the YYYY-MM-DD day key the attendance/leave APIs expect. */
function dayKey(value: string): string;
function dayKey(value: string | undefined): string | undefined;
function dayKey(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim().slice(0, 10);
}

/** Any ISO timestamp (with offset) → UTC ISO string, as `z.string().datetime()` routes require. */
function utcIso(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date/time: ${value}`);
  return d.toISOString();
}

const thisMonth = (): string => new Date().toISOString().slice(0, 7);
const month = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .describe('Month as YYYY-MM (defaults to the current month)');
const year = z.number().int().min(2000).max(2100).optional().describe('Calendar year (defaults to this year)');
const userIdOpt = (who: string) =>
  z.string().min(1).optional().describe(`${who} user id from team_list (omit for yourself)`);
const clientId = id('Client').describe('Client id (from clients_list)');
const postId = id('Post').describe('Post id (from posts_list)');
const requestScope = z
  .enum(['me', 'all', 'pending'])
  .optional()
  .describe("'me' (default) = your own; 'all' = everyone you may see; 'pending' = awaiting a decision (approver queue)");

const POST_TYPES = ['reel', 'story', 'carousel', 'post'] as const;
const POST_STATUSES = ['draft', 'pending_approval', 'approved', 'changes_requested', 'scheduled', 'posted'] as const;
const DOCUMENT_CATEGORIES = [
  'contract',
  'nda',
  'proposal',
  'agreement',
  'deliverable',
  'invoice',
  'report',
  'design',
  'ai_generated',
  'misc',
] as const;

// ---- response shapes (only the fields the lean summaries read) ----
interface TeamMember {
  id: string;
  fullName: string | null;
  email: string;
  designation: string | null;
  department: string | null;
  status: string;
  roleName: string | null;
  presence?: 'in' | 'out' | null;
  checkInAt?: string | null;
  activeTaskCount?: number;
  utilizationPct?: number;
}

interface RequestRow {
  id: string;
  userId: string;
  userName: string | null;
  status: string;
  reason: string | null;
  decisionNote: string | null;
  createdAt: string | null;
  capabilities?: unknown;
  [k: string]: unknown;
}

interface ThreadSummary {
  id: string;
  subject: string;
  status: string;
  clientId: string | null;
  clientName: string | null;
  projectName: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  participants: Array<{ userId: string; name: string | null }>;
}

interface MessageRow {
  id: string;
  senderId: string | null;
  senderName: string | null;
  body: string;
  attachments: Array<{ name: string; url: string; type: string }>;
  createdAt: string | null;
  editedAt: string | null;
  pinnedAt: string | null;
}

interface DocumentRow {
  id: string;
  name: string;
  category: string;
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
  projectName: string | null;
  folderId: string | null;
  mimeType: string | null;
  sizeBytes: number;
  clientVisible: boolean;
  hideFromTeam: boolean;
  archived: boolean;
  uploadedByName: string | null;
  createdAt: string | null;
}

interface PostRow {
  id: string;
  clientId: string;
  postType: string;
  caption: string | null;
  platforms: string[];
  scheduledAt: string | null;
  status: string;
  archivedMonth: string | null;
  media?: unknown[];
}

/** Drop the per-viewer UI `capabilities` map from a response row (noise for the model). */
const stripCaps = <T extends { capabilities?: unknown }>(row: T): Omit<T, 'capabilities'> => {
  const out = { ...row } as Record<string, unknown>;
  delete out['capabilities'];
  return out as unknown as Omit<T, 'capabilities'>;
};

const threadSummary = (t: ThreadSummary) => ({
  id: t.id,
  subject: t.subject,
  status: t.status,
  clientId: t.clientId,
  clientName: t.clientName,
  projectName: t.projectName,
  lastMessageAt: t.lastMessageAt,
  lastMessagePreview: t.lastMessagePreview,
  unreadCount: t.unreadCount,
  participants: t.participants.map((p) => ({ userId: p.userId, name: p.name })),
});

const postSummary = (p: PostRow) => ({
  id: p.id,
  postType: p.postType,
  status: p.status,
  scheduledAt: p.scheduledAt,
  platforms: p.platforms,
  captionPreview: p.caption ? (p.caption.length > 140 ? `${p.caption.slice(0, 140)}…` : p.caption) : null,
  hasMedia: (p.media?.length ?? 0) > 0,
  archivedMonth: p.archivedMonth,
});

const documentSummary = (d: DocumentRow) => ({
  id: d.id,
  name: d.name,
  category: d.category,
  clientName: d.clientName,
  projectName: d.projectName,
  folderId: d.folderId,
  mimeType: d.mimeType,
  sizeBytes: d.sizeBytes,
  clientVisible: d.clientVisible,
  uploadedBy: d.uploadedByName,
  createdAt: d.createdAt,
});

// ============================================================
//  TEAM (/team)
// ============================================================
const teamTools: SanctumTool[] = [
  defineTool({
    name: 'team_list',
    title: 'List team members',
    description:
      "Lists the agency's staff with designation, department, role name, today's presence (in/out, when the caller may see attendance) and workload. Use it to find a colleague's user id for messages, attendance or leave tools.",
    anyOf: ['users.view'],
    kind: 'read',
    input: {
      search: z.string().optional().describe('Match name, email or designation'),
      activeOnly: z.boolean().optional().describe('Only active (not disabled) members'),
    },
    run: async ({ search, activeOnly }, { api }) => {
      const rows = rowsOf(await api.get<TeamMember[]>('/team', { search, activeOnly }));
      return rows.map((u) => ({
        id: u.id,
        name: u.fullName,
        email: u.email,
        designation: u.designation,
        department: u.department,
        role: u.roleName,
        status: u.status,
        presence: u.presence ?? null,
        checkInAt: u.checkInAt ?? null,
        activeTaskCount: u.activeTaskCount,
        utilizationPct: u.utilizationPct,
      }));
    },
  }),
  defineTool({
    name: 'team_get',
    title: 'Get a team member',
    description:
      "Full profile of one staff member: contact details, roles, skills, capacity, today's check-in, projects, active tasks and recent time logs (sections the caller may not see come back empty). Get the id from team_list.",
    anyOf: ['users.view'],
    kind: 'read',
    input: { userId: id('User').describe('User id (from team_list)') },
    run: ({ userId }, { api }) => api.get(`/team/${seg(userId)}`),
  }),
  defineTool({
    name: 'team_invite',
    title: 'Invite a team member',
    description:
      'Invites a new STAFF member with the default employee role (roles are changed in the Sanctum app, not here). Creates the account and emails them an invitation link valid for 7 days. Fails if the email already belongs to a member.',
    anyOf: ['users.invite'],
    kind: 'write',
    input: {
      fullName: z.string().trim().min(1).max(120),
      email: z.string().email(),
      phone: z.string().trim().max(40).optional(),
      designation: z.string().trim().max(120).optional().describe('Job title, e.g. "Video Editor"'),
      department: z.string().trim().max(120).optional(),
      weeklyCapacityHrs: z.number().int().min(0).max(168).optional().describe('Working hours per week'),
      skills: z.array(z.string()).optional(),
    },
    run: async (args, { api }) => {
      const res = await api.post<{ member: TeamMember }>('/team/invite', compact({ ...args, kind: 'staff' as const }));
      // The activation link is a credential for the new account — never hand it to the model.
      const m = res.member;
      return {
        invited: true,
        emailSent: true,
        member: { id: m.id, name: m.fullName, email: m.email, designation: m.designation, department: m.department, role: m.roleName },
      };
    },
  }),
  defineTool({
    name: 'team_update_profile',
    title: "Update a member's profile",
    description:
      "Changes a staff member's profile fields (name, designation, department, phone, weekly capacity, skills). Only fields you pass change; pass null to clear designation/department/phone. Does not change roles, status or pay. Get the id from team_list.",
    anyOf: ['users.update'],
    kind: 'write',
    input: {
      userId: id('User').describe('User id (from team_list)'),
      fullName: z.string().trim().min(1).max(120).optional(),
      designation: z.string().trim().max(120).nullable().optional(),
      department: z.string().trim().max(120).nullable().optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      weeklyCapacityHrs: z.number().int().min(0).max(168).optional(),
      skills: z.array(z.string()).optional().describe('Replaces the whole skills list'),
    },
    run: ({ userId, ...fields }, { api }) => api.patch(`/team/${seg(userId)}`, compact(fields)),
  }),
  defineTool({
    name: 'team_activity',
    title: "A member's recent activity",
    description:
      "Recent audit-log actions performed by a team member (what they created/changed and when), newest first. Without organization access you can only see your own. Get the id from team_list or whoami.",
    anyOf: ['users.view_activity'],
    kind: 'read',
    input: {
      userId: id('User').describe('User id (from team_list or whoami)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max entries (default 40)'),
    },
    run: ({ userId, limit: max }, { api }) => api.get(`/team/${seg(userId)}/activity`, { limit: max }),
  }),
];

// ============================================================
//  ATTENDANCE (/attendance)
// ============================================================
const attendanceTools: SanctumTool[] = [
  defineTool({
    name: 'attendance_today',
    title: 'My attendance today',
    description:
      "Your own attendance for today: whether you've checked in/out, worked minutes, late flag, plus the shift hours and timezone.",
    anyOf: ['attendance.check_in', 'attendance.view'],
    kind: 'read',
    input: {},
    run: (_args, { api }) => api.get('/attendance/today'),
  }),
  defineTool({
    name: 'attendance_check_in',
    title: 'Check in',
    description:
      "Checks YOU in for today (re-opens the day if you checked out by mistake). The server applies the agency's IP allowlist / office geofence: through an AI assistant the request comes from the assistant's network, so check-in can be refused when the agency enforces office IPs; pass lat/lng when location is required.",
    anyOf: ['attendance.check_in'],
    kind: 'write',
    input: {
      lat: z.number().min(-90).max(90).optional().describe('Current latitude'),
      lng: z.number().min(-180).max(180).optional().describe('Current longitude'),
      location: z.string().max(200).optional().describe('Human-readable place, e.g. "Andheri office"'),
    },
    run: (args, { api }) => api.post('/attendance/check-in', compact(args)),
  }),
  defineTool({
    name: 'attendance_check_out',
    title: 'Check out',
    description:
      "Checks YOU out for today and stops your running task timers. If the agency has an office geofence, lat/lng are required; checking out from outside the office creates an out-of-office checkout request instead (response has pending: true) and notifies approvers — give a reason in that case.",
    anyOf: ['attendance.check_in'],
    kind: 'write',
    input: {
      lat: z.number().min(-90).max(90).optional().describe('Current latitude'),
      lng: z.number().min(-180).max(180).optional().describe('Current longitude'),
      location: z.string().max(200).optional().describe('Human-readable place'),
      reason: z.string().trim().max(500).optional().describe('Why you are checking out away from the office (e.g. client shoot)'),
    },
    run: (args, { api }) => api.post('/attendance/check-out', compact(args)),
  }),
  defineTool({
    name: 'attendance_whos_in',
    title: "Who's in today",
    description:
      "Live view of today for every active staff member: in / checked out / absent / on leave / holiday / weekly off, with check-in and check-out times. Includes counts per status.",
    anyOf: ['attendance.view_live'],
    kind: 'read',
    input: {},
    run: async (_args, { api }) => {
      const res = await api.get<{
        day: string;
        members: Array<{
          userId: string;
          name: string;
          status: string;
          checkInAt: string | null;
          checkOutAt: string | null;
          workedMinutes: number;
          isLate: boolean;
          checkInLocation: string | null;
        }>;
      }>('/attendance/whos-in');
      const members = res.members.map((m) => ({
        userId: m.userId,
        name: m.name,
        status: m.status,
        presence: m.checkInAt ? (m.checkOutAt ? 'checked_out' : 'in') : 'not_in',
        checkInAt: m.checkInAt,
        checkOutAt: m.checkOutAt,
        workedMinutes: m.workedMinutes,
        isLate: m.isLate,
        location: m.checkInLocation,
      }));
      const counts: Record<string, number> = {};
      for (const m of members) {
        const key = m.presence === 'not_in' ? m.status : m.presence;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return { day: res.day, counts, members };
    },
  }),
  defineTool({
    name: 'attendance_month',
    title: 'Monthly attendance',
    description:
      "Attendance summary for one person and month (present, late, half days, absences, leave, holidays, worked/overtime minutes). Set includeDays for the day-by-day calendar. Defaults to yourself; someone else's needs organization-wide attendance access (ids from team_list).",
    anyOf: ['attendance.view'],
    kind: 'read',
    input: {
      month: month.optional(),
      userId: userIdOpt('Team member'),
      includeDays: z.boolean().optional().describe('Also return each day (status, check-in/out, worked minutes)'),
    },
    run: async ({ month: m, userId, includeDays }, { api }) => {
      const q = { month: m ?? thisMonth(), userId };
      const summary = await api.get<{ month: string; userId: string; summary: unknown }>('/attendance/summary', q);
      if (!includeDays) return summary;
      const cal = await api.get<{
        timezone: string;
        days: Array<{
          day: string;
          status: string;
          checkInAt: string | null;
          checkOutAt: string | null;
          workedMinutes: number;
          isLate: boolean;
          note: string | null;
          holidayName?: string | null;
        }>;
      }>('/attendance/calendar', q);
      return {
        ...summary,
        timezone: cal.timezone,
        days: cal.days.map((d) =>
          compact({
            day: d.day,
            status: d.status,
            checkInAt: d.checkInAt ?? undefined,
            checkOutAt: d.checkOutAt ?? undefined,
            workedMinutes: d.workedMinutes || undefined,
            isLate: d.isLate || undefined,
            note: d.note ?? undefined,
            holidayName: d.holidayName ?? undefined,
          }),
        ),
      };
    },
  }),
  defineTool({
    name: 'attendance_team_report',
    title: 'Team attendance report',
    description:
      'Per-employee report over a date range (max 366 days; defaults to this month so far): attendance counts, late days, worked time, plus logged time, utilization and task counts when you may see them.',
    anyOf: ['attendance.view_reports'],
    kind: 'read',
    input: {
      from: isoDate('First day of the range').optional(),
      to: isoDate('Last day of the range').optional(),
    },
    run: ({ from, to }, { api }) => api.get('/attendance/team-report', { from: dayKey(from), to: dayKey(to) }),
  }),
  defineTool({
    name: 'attendance_email_reports',
    title: 'Email attendance reports',
    description:
      'EMAILS every employee their own attendance report for the range (max 31 days; defaults to this month so far) and sends a combined overview to report holders. Confirm with the user before running.',
    anyOf: ['attendance.email_reports'],
    kind: 'write',
    input: {
      from: isoDate('First day of the range').optional(),
      to: isoDate('Last day of the range').optional(),
    },
    run: ({ from, to }, { api }) => api.post('/attendance/email-reports', compact({ from: dayKey(from), to: dayKey(to) })),
  }),
  defineTool({
    name: 'attendance_mark',
    title: "Mark someone's attendance",
    description:
      "Sets or overrides ANOTHER member's attendance for a day (never your own): status and/or check-in/out times. Omitted fields keep their current values; status is derived from times when not given. Get the user id from team_list.",
    anyOf: ['attendance.mark'],
    kind: 'write',
    input: {
      userId: id('User').describe('User id (from team_list)'),
      day: isoDate('Day to mark'),
      status: z.enum(['present', 'late', 'half_day', 'absent', 'on_leave', 'holiday', 'weekly_off']).optional(),
      checkInAt: isoDate('Check-in time (full timestamp with offset)').optional(),
      checkOutAt: isoDate('Check-out time (full timestamp with offset)').optional(),
      note: z.string().trim().max(500).optional(),
    },
    run: ({ day, ...rest }, { api }) => api.post('/attendance/mark', compact({ ...rest, day: dayKey(day) })),
  }),
  defineTool({
    name: 'attendance_holidays_list',
    title: 'List holidays',
    description: "The agency's holidays for a year (date, name, recurring).",
    anyOf: ['attendance.check_in', 'attendance.view', 'leaves.request', 'holidays.manage'],
    kind: 'read',
    input: { year },
    run: ({ year: y }, { api }) => api.get('/attendance/holidays', { year: y }),
  }),
  defineTool({
    name: 'attendance_holiday_create',
    title: 'Add a holiday',
    description: 'Adds an agency holiday (affects everyone\'s attendance and leave day counts). One holiday per date.',
    anyOf: ['holidays.manage'],
    kind: 'write',
    input: {
      day: isoDate('Holiday date'),
      name: z.string().trim().min(1).max(120).describe('e.g. "Diwali"'),
      recurring: z.boolean().optional().describe('Repeats on the same date every year'),
    },
    run: ({ day, ...rest }, { api }) => api.post('/attendance/holidays', compact({ ...rest, day: dayKey(day) })),
  }),
  defineTool({
    name: 'attendance_holiday_delete',
    title: 'Remove a holiday',
    description: 'Permanently deletes an agency holiday. Get the id from attendance_holidays_list.',
    anyOf: ['holidays.manage'],
    kind: 'delete',
    input: { holidayId: id('Holiday').describe('Holiday id (from attendance_holidays_list)') },
    run: ({ holidayId }, { api }) => api.delete(`/attendance/holidays/${seg(holidayId)}`),
  }),
  defineTool({
    name: 'attendance_checkout_requests_list',
    title: 'Out-of-office checkout requests',
    description:
      "Out-of-office checkout requests (check-outs made outside the office geofence that need approval). scope 'pending' is the approver queue.",
    anyOf: ['checkout_requests.view'],
    kind: 'read',
    input: { scope: requestScope, userId: z.string().min(1).optional().describe('Filter to one member (team_list id); with scope all/pending') },
    run: async ({ scope, userId }, { api }) => {
      const rows = rowsOf(await api.get<RequestRow[]>('/attendance/checkout-requests', { scope, userId }));
      return rows.map((r) => ({
        id: r.id,
        userName: r.userName,
        day: r.day,
        requestedCheckOutAt: r.requestedCheckOutAt,
        distanceM: r.distanceM,
        location: r.checkOutLocation,
        reason: r.reason,
        status: r.status,
        decisionNote: r.decisionNote,
      }));
    },
  }),
  defineTool({
    name: 'attendance_checkout_request_decide',
    title: 'Approve/reject an out-of-office checkout',
    description:
      "Approves (finalizes the member's check-out; by default credits a full day) or rejects a pending out-of-office checkout. Notifies the member. Get the id from attendance_checkout_requests_list with scope 'pending'.",
    anyOf: ['checkout_requests.approve'],
    kind: 'write',
    input: {
      requestId: id('Checkout request'),
      decision: z.enum(['approved', 'rejected']),
      note: z.string().trim().max(500).optional(),
      creditFullDay: z.boolean().optional().describe('When approving, count the whole shift as worked (default true)'),
    },
    run: ({ requestId, ...body }, { api }) =>
      api.post(`/attendance/checkout-requests/${seg(requestId)}/decide`, compact(body)),
  }),
  defineTool({
    name: 'attendance_checkout_request_cancel',
    title: 'Withdraw an out-of-office checkout request',
    description: 'Cancels a pending out-of-office checkout request (your own, or a manageable member\'s with organization access).',
    anyOf: ['checkout_requests.cancel'],
    kind: 'write',
    input: { requestId: id('Checkout request').describe('Id from attendance_checkout_requests_list') },
    run: ({ requestId }, { api }) => api.post(`/attendance/checkout-requests/${seg(requestId)}/cancel`),
  }),
];

// ============================================================
//  LEAVES (/attendance/leaves)
// ============================================================
const leaveSummary = (r: RequestRow) => ({
  id: r.id,
  userId: r.userId,
  userName: r.userName,
  leaveType: r.leaveTypeName,
  startDay: r.startDay,
  endDay: r.endDay,
  days: r.days,
  halfDayStart: r.halfDayStart,
  halfDayEnd: r.halfDayEnd,
  reason: r.reason,
  status: r.status,
  decisionNote: r.decisionNote,
  createdAt: r.createdAt,
});

const leaveTools: SanctumTool[] = [
  defineTool({
    name: 'leaves_types_list',
    title: 'Leave types',
    description: 'Leave types the agency offers (e.g. Casual, Sick) with paid flag and annual quota. Use the id with leaves_apply.',
    anyOf: ['leaves.request', 'leaves.view', 'leave_types.manage'],
    kind: 'read',
    input: {},
    run: (_args, { api }) => api.get('/attendance/leaves/types'),
  }),
  defineTool({
    name: 'leaves_list',
    title: 'List leave requests',
    description:
      "Leave requests. Default is your own; scope 'pending' is a manager's approval queue, 'all' everyone you may see (optionally one userId from team_list).",
    anyOf: ['leaves.view'],
    kind: 'read',
    input: { scope: requestScope, userId: z.string().min(1).optional().describe('Filter to one member (team_list id); with scope all/pending') },
    run: async ({ scope, userId }, { api }) =>
      rowsOf(await api.get<RequestRow[]>('/attendance/leaves', { scope, userId })).map(leaveSummary),
  }),
  defineTool({
    name: 'leaves_balances',
    title: 'Leave balances',
    description:
      'Per leave type for a year: quota, days used (approved), pending, and remaining (null = unlimited). Defaults to yourself; another member needs organization access (id from team_list).',
    anyOf: ['leaves.view'],
    kind: 'read',
    input: { userId: userIdOpt('Team member'), year },
    run: ({ userId, year: y }, { api }) => api.get('/attendance/leaves/balances', { userId, year: y }),
  }),
  defineTool({
    name: 'leaves_apply',
    title: 'Apply for leave',
    description:
      'Requests leave for YOURSELF. Working days in the range are counted (weekends/holidays skipped) and checked against the quota. The request is pending until approved; approvers are notified. Get leaveTypeId from leaves_types_list.',
    anyOf: ['leaves.request'],
    kind: 'write',
    input: {
      leaveTypeId: id('Leave type').describe('Leave type id (from leaves_types_list)'),
      startDay: isoDate('First day of leave'),
      endDay: isoDate('Last day of leave (same as startDay for one day)'),
      halfDayStart: z.boolean().optional().describe('First day is a half day'),
      halfDayEnd: z.boolean().optional().describe('Last day is a half day'),
      reason: z.string().trim().max(500).optional(),
    },
    run: async ({ startDay, endDay, ...rest }, { api }) =>
      leaveSummary(
        await api.post<RequestRow>(
          '/attendance/leaves',
          compact({ ...rest, startDay: dayKey(startDay), endDay: dayKey(endDay) }),
        ),
      ),
  }),
  defineTool({
    name: 'leaves_decide',
    title: 'Approve/reject leave',
    description:
      "Approves or rejects someone else's pending leave request (never your own). The requester is notified. Find pending ids with leaves_list scope 'pending'.",
    anyOf: ['leaves.approve'],
    kind: 'write',
    input: {
      leaveId: id('Leave request').describe('Leave request id (from leaves_list)'),
      decision: z.enum(['approved', 'rejected']),
      note: z.string().trim().max(500).optional().describe('Message to the requester'),
    },
    run: async ({ leaveId, ...body }, { api }) =>
      leaveSummary(await api.post<RequestRow>(`/attendance/leaves/${seg(leaveId)}/decide`, compact(body))),
  }),
  defineTool({
    name: 'leaves_cancel',
    title: 'Cancel leave',
    description:
      "Cancels a leave request. Your own: only while pending. Someone else's (pending or approved) needs manager access; they are notified. Id from leaves_list.",
    anyOf: ['leaves.cancel'],
    kind: 'write',
    input: { leaveId: id('Leave request').describe('Leave request id (from leaves_list)') },
    run: ({ leaveId }, { api }) => api.post(`/attendance/leaves/${seg(leaveId)}/cancel`),
  }),
];

// ============================================================
//  REGULARIZATIONS (/attendance/regularizations)
// ============================================================
const regSummary = (r: RequestRow) => ({
  id: r.id,
  userId: r.userId,
  userName: r.userName,
  day: r.day,
  type: r.type,
  requestedCheckInAt: r.requestedCheckInAt,
  requestedCheckOutAt: r.requestedCheckOutAt,
  requestedStatus: r.requestedStatus,
  reason: r.reason,
  status: r.status,
  decisionNote: r.decisionNote,
  createdAt: r.createdAt,
});

const regularizationTools: SanctumTool[] = [
  defineTool({
    name: 'regularizations_list',
    title: 'List attendance fix requests',
    description:
      "Attendance regularization (fix) requests. Default is your own; scope 'pending' is the approver queue, 'all' everyone you may see.",
    anyOf: ['regularizations.view'],
    kind: 'read',
    input: { scope: requestScope, userId: z.string().min(1).optional().describe('Filter to one member (team_list id); with scope all/pending') },
    run: async ({ scope, userId }, { api }) =>
      rowsOf(await api.get<RequestRow[]>('/attendance/regularizations', { scope, userId })).map(regSummary),
  }),
  defineTool({
    name: 'regularizations_request',
    title: 'Request an attendance fix',
    description:
      'Asks to correct YOUR attendance for a past day or today (missed punch, marked late, short hours, etc.), with the corrected times/status. One pending request per day. Approvers are notified.',
    anyOf: ['regularizations.request'],
    kind: 'write',
    input: {
      day: isoDate('Day to fix'),
      type: z.enum(['missed_punch', 'late', 'short_hours', 'half_day', 'wrong_status']),
      requestedCheckInAt: isoDate('Correct check-in time (full timestamp with offset)').optional(),
      requestedCheckOutAt: isoDate('Correct check-out time (full timestamp with offset)').optional(),
      requestedStatus: z.enum(['present', 'half_day', 'on_leave']).optional(),
      reason: z.string().trim().min(3).max(500),
    },
    run: async ({ day, ...rest }, { api }) =>
      regSummary(await api.post<RequestRow>('/attendance/regularizations', compact({ ...rest, day: dayKey(day) }))),
  }),
  defineTool({
    name: 'regularizations_decide',
    title: 'Approve/reject an attendance fix',
    description:
      "Approves (applies the correction to the member's day) or rejects someone else's pending regularization. The member is notified. Ids from regularizations_list scope 'pending'.",
    anyOf: ['regularizations.approve'],
    kind: 'write',
    input: {
      regularizationId: id('Regularization'),
      decision: z.enum(['approved', 'rejected']),
      note: z.string().trim().max(500).optional(),
    },
    run: async ({ regularizationId, ...body }, { api }) =>
      regSummary(
        await api.post<RequestRow>(`/attendance/regularizations/${seg(regularizationId)}/decide`, compact(body)),
      ),
  }),
  defineTool({
    name: 'regularizations_cancel',
    title: 'Withdraw an attendance fix request',
    description: 'Cancels a pending regularization (your own, or a manageable member\'s with organization access). Id from regularizations_list.',
    anyOf: ['regularizations.cancel'],
    kind: 'write',
    input: { regularizationId: id('Regularization') },
    run: ({ regularizationId }, { api }) =>
      api.post(`/attendance/regularizations/${seg(regularizationId)}/cancel`),
  }),
];

// ============================================================
//  MESSAGES (/messages) — threads ("conversations") between staff
// ============================================================
const messageSummary = (m: MessageRow) => ({
  id: m.id,
  senderId: m.senderId,
  senderName: m.senderName,
  body: m.body,
  attachments: m.attachments.map((a) => ({ name: a.name, url: a.url, type: a.type })),
  createdAt: m.createdAt,
  edited: !!m.editedAt,
  pinned: !!m.pinnedAt,
});

const messageTools: SanctumTool[] = [
  defineTool({
    name: 'messages_conversations_list',
    title: 'List conversations',
    description:
      'Your message threads (conversations) with subject, participants, last message preview and unread count, newest activity first. Filter by status, search text or client (clientId from clients_list).',
    anyOf: ['messages.view'],
    kind: 'read',
    input: {
      status: z.enum(['open', 'awaiting', 'closed']).optional(),
      search: z.string().optional(),
      clientId: z.string().min(1).optional().describe('Only threads linked to this client (from clients_list)'),
      scope: z.enum(['mine', 'all']).optional().describe("'all' = every thread in the agency (moderators only)"),
    },
    run: async (args, { api }) => rowsOf(await api.get<ThreadSummary[]>('/messages/threads', args)).map(threadSummary),
  }),
  defineTool({
    name: 'messages_conversation_get',
    title: 'Get a conversation',
    description: 'One thread\'s details: subject, status, linked client/project, participants, unread count. Id from messages_conversations_list.',
    anyOf: ['messages.view'],
    kind: 'read',
    input: { threadId: id('Thread').describe('Thread id (from messages_conversations_list)') },
    run: ({ threadId }, { api }) => api.get(`/messages/threads/${seg(threadId)}`),
  }),
  defineTool({
    name: 'messages_read',
    title: 'Read messages',
    description:
      'Messages in a thread, oldest to newest (latest page by default). For older history pass `before` = the oldest message id you have. Does not mark the thread read — use messages_mark_read for that.',
    anyOf: ['messages.view'],
    kind: 'read',
    input: {
      threadId: id('Thread').describe('Thread id (from messages_conversations_list)'),
      before: z.string().min(1).optional().describe('Message id; return messages older than it'),
      limit: z.number().int().min(1).max(100).optional().describe('Max messages (default 50)'),
    },
    run: async ({ threadId, before, limit: max }, { api }) =>
      rowsOf(await api.get<MessageRow[]>(`/messages/threads/${seg(threadId)}/messages`, { before, limit: max })).map(
        messageSummary,
      ),
  }),
  defineTool({
    name: 'messages_send',
    title: 'Send a message',
    description:
      'Posts a message in a thread you participate in. Other participants see it in real time; @Name mentions notify those people. To message someone new, use messages_start_conversation.',
    anyOf: ['messages.send'],
    kind: 'write',
    input: {
      threadId: id('Thread').describe('Thread id (from messages_conversations_list)'),
      body: z.string().min(1).max(10000),
    },
    run: async ({ threadId, body }, { api }) =>
      messageSummary(await api.post<MessageRow>(`/messages/threads/${seg(threadId)}/messages`, { body })),
  }),
  defineTool({
    name: 'messages_start_conversation',
    title: 'Start a conversation',
    description:
      'Creates a new thread with colleagues (participant ids from team_list; you are added automatically) and optionally posts the first message. Optionally link it to a client (clients_list) or project (projects_list).',
    anyOf: ['threads.create'],
    kind: 'write',
    input: {
      subject: z.string().min(1).max(200),
      participantIds: z.array(z.string().min(1)).min(1).describe('Staff user ids (from team_list)'),
      body: z.string().max(10000).optional().describe('First message'),
      clientId: z.string().min(1).optional().describe('Link to a client (from clients_list)'),
      projectId: z.string().min(1).optional().describe('Link to a project (from projects_list)'),
    },
    run: async (args, { api }) => threadSummary(await api.post<ThreadSummary>('/messages/threads', compact(args))),
  }),
  defineTool({
    name: 'messages_update_conversation',
    title: 'Update a conversation',
    description:
      'Changes a thread: rename, set status (open / awaiting / closed), link/unlink client or project (null clears), add participants (team_list ids) or remove them. Removing only yourself = leaving the thread. Editing needs thread-owner rights; adding/removing others needs participant-management rights.',
    anyOf: ['messages.view'],
    kind: 'write',
    input: {
      threadId: id('Thread').describe('Thread id (from messages_conversations_list)'),
      subject: z.string().min(1).max(200).optional(),
      status: z.enum(['open', 'awaiting', 'closed']).optional(),
      clientId: z.string().min(1).nullable().optional(),
      projectId: z.string().min(1).nullable().optional(),
      addParticipantIds: z.array(z.string().min(1)).optional(),
      removeParticipantIds: z.array(z.string().min(1)).optional(),
    },
    run: async ({ threadId, ...body }, { api }) =>
      threadSummary(await api.patch<ThreadSummary>(`/messages/threads/${seg(threadId)}`, compact(body))),
  }),
  defineTool({
    name: 'messages_mark_read',
    title: 'Mark conversation read',
    description: 'Marks all messages in a thread as read for you (clears its unread count).',
    anyOf: ['messages.view'],
    kind: 'write',
    input: { threadId: id('Thread').describe('Thread id (from messages_conversations_list)') },
    run: ({ threadId }, { api }) => api.post(`/messages/threads/${seg(threadId)}/read`),
  }),
  defineTool({
    name: 'messages_edit',
    title: 'Edit a message',
    description: 'Replaces the text of one of YOUR messages (shown as edited). Ids from messages_read.',
    anyOf: ['messages.update'],
    kind: 'write',
    input: {
      threadId: id('Thread'),
      messageId: id('Message').describe('Message id (from messages_read)'),
      body: z.string().min(1).max(10000),
    },
    run: async ({ threadId, messageId, body }, { api }) =>
      messageSummary(
        await api.patch<MessageRow>(`/messages/threads/${seg(threadId)}/messages/${seg(messageId)}`, { body }),
      ),
  }),
  defineTool({
    name: 'messages_delete',
    title: 'Delete a message',
    description: 'Permanently deletes a message (normally your own; moderators can delete others, which is audited). Ids from messages_read.',
    anyOf: ['messages.delete'],
    kind: 'delete',
    input: {
      threadId: id('Thread'),
      messageId: id('Message').describe('Message id (from messages_read)'),
    },
    run: ({ threadId, messageId }, { api }) =>
      api.delete(`/messages/threads/${seg(threadId)}/messages/${seg(messageId)}`),
  }),
];

// ============================================================
//  NOTIFICATIONS (/notifications) — self-service
// ============================================================
const notificationTools: SanctumTool[] = [
  defineTool({
    name: 'notifications_list',
    title: 'My notifications',
    description:
      'Your in-app notifications, newest first (leave decisions, approvals, mentions, assignments…). `entityType`/`entityId` point at the related record.',
    anyOf: [],
    kind: 'read',
    input: {
      unreadOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Max items (default 30)'),
    },
    run: async ({ unreadOnly, limit: max }, { api }) => {
      const rows = rowsOf(
        await api.get<
          Array<{
            id: string;
            type: string;
            title: string;
            body: string | null;
            entityType: string | null;
            entityId: string | null;
            readAt: string | null;
            createdAt: string | null;
          }>
        >('/notifications', { unreadOnly: unreadOnly ? 'true' : undefined, limit: max }),
      );
      return rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        entityType: n.entityType,
        entityId: n.entityId,
        read: !!n.readAt,
        createdAt: n.createdAt,
      }));
    },
  }),
  defineTool({
    name: 'notifications_unread_count',
    title: 'Unread notification count',
    description: 'How many of your notifications are unread.',
    anyOf: [],
    kind: 'read',
    input: {},
    run: (_args, { api }) => api.get('/notifications/unread-count'),
  }),
  defineTool({
    name: 'notifications_mark_read',
    title: 'Mark notifications read',
    description: 'Marks one notification as read (id from notifications_list), or ALL your unread notifications when no id is given.',
    anyOf: [],
    kind: 'write',
    input: { notificationId: z.string().min(1).optional().describe('Notification id; omit to mark all read') },
    run: ({ notificationId }, { api }) =>
      notificationId
        ? api.post(`/notifications/${seg(notificationId)}/read`)
        : api.post('/notifications/read-all'),
  }),
];

// ============================================================
//  DOCUMENTS (/documents) — metadata only, no binary upload
// ============================================================
const documentTools: SanctumTool[] = [
  defineTool({
    name: 'documents_list',
    title: 'List documents',
    description:
      'Documents you can see, newest first. Filter by category, client (clients_list), project (projects_list), folder (documents_folders_list; "root" = not in a folder) or name search. Use documents_get for the file URL and full details.',
    anyOf: ['documents.view'],
    kind: 'read',
    input: {
      category: z.enum(DOCUMENT_CATEGORIES).optional(),
      clientId: z.string().optional(),
      projectId: z.string().optional(),
      folderId: z.string().optional().describe('Folder id, or "root" for documents not in any folder'),
      search: z.string().optional().describe('Match the document name'),
      limit,
    },
    run: async ({ limit: max, ...q }, { api }) => {
      const rows = rowsOf(await api.get<DocumentRow[]>('/documents', q)).map(documentSummary);
      return max ? rows.slice(0, max) : rows;
    },
  }),
  defineTool({
    name: 'documents_get',
    title: 'Get a document',
    description:
      'Full metadata for one document, including its file URL, size, visibility (client-visible / hidden from team) and uploader. Id from documents_list.',
    anyOf: ['documents.view'],
    kind: 'read',
    input: { documentId: id('Document').describe('Document id (from documents_list)') },
    run: async ({ documentId }, { api }) => {
      // The API has no single-document GET; read from the (permission-filtered) list.
      const doc = rowsOf(await api.get<Array<DocumentRow & { capabilities?: unknown }>>('/documents')).find(
        (d) => d.id === documentId,
      );
      if (!doc) throw new Error('Document not found (or you cannot see it).');
      return stripCaps(doc);
    },
  }),
  defineTool({
    name: 'documents_folders_list',
    title: 'List document folders',
    description: 'Document folders. parentId "root" = top level; omit for every folder. Filter by client or project.',
    anyOf: ['documents.view'],
    kind: 'read',
    input: {
      parentId: z.string().optional().describe('Parent folder id, or "root"'),
      clientId: z.string().optional(),
      projectId: z.string().optional(),
    },
    run: async (q, { api }) =>
      rowsOf(
        await api.get<
          Array<{ id: string; name: string; parentId: string | null; clientId: string | null; projectId: string | null; clientVisible: boolean }>
        >('/documents/folders', q),
      ).map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        clientId: f.clientId,
        projectId: f.projectId,
        clientVisible: f.clientVisible,
      })),
  }),
  defineTool({
    name: 'documents_add_link',
    title: 'Add a document link',
    description:
      'Saves an EXTERNAL link (e.g. a Google Drive/Figma URL) as a document — no file is uploaded. Category proposal, agreement/contract/nda (with a client) or invoice (with a client) also creates a matching draft Business record (status "sent" if clientVisible). clientVisible shows it in the client portal.',
    anyOf: ['documents.upload'],
    kind: 'write',
    input: {
      name: z.string().min(1).max(255),
      fileUrl: z.string().url().describe('The link'),
      category: z.enum(DOCUMENT_CATEGORIES).optional().describe('Default misc'),
      clientId: z.string().min(1).optional().describe('From clients_list'),
      projectId: z.string().min(1).optional().describe('From projects_list'),
      folderId: z.string().min(1).optional().describe('From documents_folders_list'),
      clientVisible: z.boolean().optional().describe('Share with the client in their portal'),
      hideFromTeam: z.boolean().optional().describe('Hide from team members without hidden-document access'),
    },
    run: async (args, { api }) => {
      const doc = await api.post<DocumentRow & { capabilities?: unknown; converted?: unknown }>('/documents', compact(args));
      return stripCaps(doc);
    },
  }),
  defineTool({
    name: 'documents_update',
    title: 'Update a document',
    description:
      "Renames, re-categorizes, moves (folderId; null = root) or re-links (clientId/projectId; null clears) a document, or changes visibility. Setting clientVisible true shares it in the client's portal. Only fields you pass change. Id from documents_list.",
    anyOf: ['documents.update'],
    kind: 'write',
    input: {
      documentId: id('Document').describe('Document id (from documents_list)'),
      name: z.string().min(1).max(255).optional(),
      category: z.enum(DOCUMENT_CATEGORIES).optional(),
      clientId: z.string().min(1).nullable().optional(),
      projectId: z.string().min(1).nullable().optional(),
      folderId: z.string().min(1).nullable().optional(),
      clientVisible: z.boolean().optional(),
      hideFromTeam: z.boolean().optional(),
    },
    run: async ({ documentId, ...fields }, { api }) =>
      stripCaps(await api.patch<DocumentRow & { capabilities?: unknown }>(`/documents/${seg(documentId)}`, compact(fields))),
  }),
  defineTool({
    name: 'documents_folder_create',
    title: 'Create a document folder',
    description: 'Creates a folder (optionally nested under parentId, linked to a client/project, or visible in the client portal).',
    anyOf: ['folders.create'],
    kind: 'write',
    input: {
      name: z.string().min(1).max(120),
      parentId: z.string().min(1).optional().describe('Parent folder id (from documents_folders_list)'),
      clientId: z.string().min(1).optional().describe('From clients_list'),
      projectId: z.string().min(1).optional().describe('From projects_list'),
      clientVisible: z.boolean().optional().describe('Show in the client portal'),
    },
    run: (args, { api }) => api.post('/documents/folders', compact(args)),
  }),
  defineTool({
    name: 'documents_delete',
    title: 'Delete a document',
    description: 'Permanently deletes a document and its stored file. Id from documents_list.',
    anyOf: ['documents.delete'],
    kind: 'delete',
    input: { documentId: id('Document').describe('Document id (from documents_list)') },
    run: ({ documentId }, { api }) => api.delete(`/documents/${seg(documentId)}`),
  }),
];

// ============================================================
//  CONTENT CALENDAR (/clients/:clientId/posts …)
// ============================================================
const postsPath = (c: string, p?: string) => `/clients/${seg(c)}/posts${p ? `/${seg(p)}` : ''}`;

const postTools: SanctumTool[] = [
  defineTool({
    name: 'posts_list',
    title: "List a client's posts",
    description:
      "A client's content calendar (clientId from clients_list), ordered by scheduled date. Filter by month (by scheduled date), status and post type. archived=true returns only the month-wise archive. Use posts_get for full caption and media.",
    anyOf: ['posts.view'],
    kind: 'read',
    input: {
      clientId,
      month: month.optional(),
      status: z.array(z.enum(POST_STATUSES)).optional(),
      type: z.array(z.enum(POST_TYPES)).optional(),
      archived: z.boolean().optional(),
    },
    run: async ({ clientId: c, month: m, status, type, archived }, { api }) => {
      const res = await api.get<PostRow[] | { items: PostRow[] }>(postsPath(c), {
        month: m,
        status: status?.join(','),
        type: type?.join(','),
        archived: archived === undefined ? undefined : String(archived),
      });
      return rowsOf(res).map(postSummary);
    },
  }),
  defineTool({
    name: 'posts_get',
    title: 'Get a post',
    description: 'Full post: caption, platforms, schedule, status and media (URLs). Ids from posts_list.',
    anyOf: ['posts.view'],
    kind: 'read',
    input: { clientId, postId },
    run: async ({ clientId: c, postId: p }, { api }) =>
      stripCaps(await api.get<PostRow & { capabilities?: unknown }>(postsPath(c, p))),
  }),
  defineTool({
    name: 'posts_create',
    title: 'Create a post',
    description:
      'Adds a DRAFT post to a client\'s content calendar (clientId from clients_list). Media is attached in the Sanctum app. Next step: posts_send_for_approval; it can only be scheduled after the client approves.',
    anyOf: ['posts.create'],
    kind: 'write',
    input: {
      clientId,
      postType: z.enum(POST_TYPES),
      caption: z.string().max(5000).optional(),
      platforms: z.array(z.string()).optional().describe('e.g. ["instagram","facebook"]'),
      scheduledAt: isoDate('Planned publish time (include time and offset)').optional(),
    },
    run: async ({ clientId: c, scheduledAt, ...rest }, { api }) =>
      postSummary(
        await api.post<PostRow>(postsPath(c), compact({ ...rest, platforms: rest.platforms ?? [], scheduledAt: utcIso(scheduledAt) ?? undefined })),
      ),
  }),
  defineTool({
    name: 'posts_update',
    title: 'Update a post',
    description:
      'Edits a post. Only fields you pass change (null clears caption/scheduledAt). Changing caption, type or platforms of an approved/scheduled/posted post RESETS it to draft — it must be re-approved by the client (response approvalReset: true). Moving the date of an approved post needs scheduling rights.',
    anyOf: ['posts.update'],
    kind: 'write',
    input: {
      clientId,
      postId,
      postType: z.enum(POST_TYPES).optional(),
      caption: z.string().max(5000).nullable().optional(),
      platforms: z.array(z.string()).optional(),
      scheduledAt: isoDate('Planned publish time (include time and offset)').nullable().optional(),
    },
    run: async ({ clientId: c, postId: p, scheduledAt, ...rest }, { api }) => {
      const res = await api.patch<PostRow & { approvalReset: boolean }>(
        postsPath(c, p),
        compact({ ...rest, scheduledAt: utcIso(scheduledAt) }),
      );
      return { ...postSummary(res), approvalReset: res.approvalReset };
    },
  }),
  defineTool({
    name: 'posts_delete',
    title: 'Delete a post',
    description: "Permanently deletes a post from the client's calendar. Ids from posts_list.",
    anyOf: ['posts.delete'],
    kind: 'delete',
    input: { clientId, postId },
    run: ({ clientId: c, postId: p }, { api }) => api.delete(postsPath(c, p)),
  }),
  defineTool({
    name: 'posts_send_for_approval',
    title: 'Send a post for client approval',
    description:
      'Moves a draft (or changes-requested) post to pending_approval so the client can approve it in their portal. EMAILS the client (once per batch for new posts; always for revisions after requested changes).',
    anyOf: ['posts.submit_for_approval'],
    kind: 'write',
    input: { clientId, postId },
    run: async ({ clientId: c, postId: p }, { api }) =>
      postSummary(await api.post<PostRow>(`${postsPath(c, p)}/transition`, { to: 'pending_approval' })),
  }),
  defineTool({
    name: 'posts_schedule',
    title: 'Schedule an approved post',
    description:
      'Marks a CLIENT-APPROVED post as scheduled, optionally setting the publish time first. This updates the calendar only; it does not publish to social networks.',
    anyOf: ['posts.schedule'],
    kind: 'write',
    input: {
      clientId,
      postId,
      scheduledAt: isoDate('Publish time (include time and offset); omit to keep the current one').optional(),
    },
    run: async ({ clientId: c, postId: p, scheduledAt }, { api }) => {
      if (scheduledAt) await api.patch(postsPath(c, p), { scheduledAt: utcIso(scheduledAt) });
      return postSummary(await api.post<PostRow>(`${postsPath(c, p)}/transition`, { to: 'scheduled' }));
    },
  }),
  defineTool({
    name: 'posts_set_status',
    title: 'Change post status',
    description:
      "Moves a post through the workflow. Allowed: draft→pending_approval; pending_approval→draft (recall); approved→scheduled|pending_approval|posted|draft; changes_requested→draft|pending_approval; scheduled→posted|draft. 'approved' and 'changes_requested' are client decisions and can't be set here. 'posted' only records that it went live (no social publishing). Sending to pending_approval may email the client.",
    anyOf: ['posts.update', 'posts.submit_for_approval', 'posts.schedule', 'posts.publish'],
    kind: 'write',
    input: {
      clientId,
      postId,
      to: z.enum(['draft', 'pending_approval', 'scheduled', 'posted']),
    },
    run: async ({ clientId: c, postId: p, to }, { api }) =>
      postSummary(await api.post<PostRow>(`${postsPath(c, p)}/transition`, { to })),
  }),
  defineTool({
    name: 'posts_unarchive',
    title: 'Restore an archived post',
    description: 'Moves an archived post back to the active calendar. Find it with posts_list archived=true.',
    anyOf: ['posts.restore'],
    kind: 'write',
    input: { clientId, postId },
    run: async ({ clientId: c, postId: p }, { api }) =>
      postSummary(await api.post<PostRow>(`${postsPath(c, p)}/unarchive`)),
  }),
  defineTool({
    name: 'posts_comments_list',
    title: 'Post comments',
    description: 'Comment thread on a post between the agency and the client (feedback, change requests).',
    anyOf: ['post_comments.view'],
    kind: 'read',
    input: { clientId, postId },
    run: ({ clientId: c, postId: p }, { api }) => api.get(`${postsPath(c, p)}/comments`),
  }),
  defineTool({
    name: 'posts_comment',
    title: 'Comment on a post',
    description: 'Adds a staff comment to a post. The CLIENT can see it in their portal.',
    anyOf: ['post_comments.create'],
    kind: 'write',
    input: { clientId, postId, body: z.string().min(1).max(2000) },
    run: ({ clientId: c, postId: p, body }, { api }) => api.post(`${postsPath(c, p)}/comments`, { body }),
  }),
  defineTool({
    name: 'posts_approval_history',
    title: 'Post approval history',
    description: "The client's approve / request-changes decisions on a post, with notes, oldest first.",
    anyOf: ['posts.view'],
    kind: 'read',
    input: { clientId, postId },
    run: ({ clientId: c, postId: p }, { api }) => api.get(`${postsPath(c, p)}/approvals`),
  }),
];

export const peopleTools: SanctumTool[] = [
  ...teamTools,
  ...attendanceTools,
  ...leaveTools,
  ...regularizationTools,
  ...messageTools,
  ...notificationTools,
  ...documentTools,
  ...postTools,
];
