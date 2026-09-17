/**
 * Canonical authorization catalog — the SINGLE source of truth for every
 * permission, scope, category, role template and system role in Sanctum.
 *
 * Everything else derives from this file:
 *   - the engine validates grants against it (unknown permission/scope → deny),
 *   - GET /api/v1/authz/catalog serves it,
 *   - `pnpm authz:generate` emits docs/authorization/catalog.{md,json} and the
 *     typed client copies for sanctum-frontend and sanctum-flutter.
 *
 * Design: docs/authorization/README.md (§D catalog, §E scopes, §F roles).
 */

// ============================================================
//  Scopes & actor types
// ============================================================

export const SCOPES = [
  'own',
  'assigned',
  'project',
  'client',
  'organization',
] as const;
export type Scope = (typeof SCOPES)[number];

/** Which kind of principal a permission (or role) applies to. */
export const ACTOR_TYPES = ['staff', 'client'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const SCOPE_LABELS: Record<Scope, string> = {
  own: 'Own',
  assigned: 'Assigned',
  project: 'Project',
  client: 'Client (brand)',
  organization: 'Organization',
};

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  own: 'Items the person created, authored, or that are about them.',
  assigned:
    'Items the person is attached to: project member, task assignee, assigned client, thread participant.',
  project: 'Items inside projects the person is a member of.',
  client: "Client portal users: their own brand's items (and allowed projects).",
  organization: 'Everything in the agency.',
};

/** Broadest-first order used to pick default scopes and to compare breadth. */
const SCOPE_BREADTH: Record<Scope, number> = {
  own: 1,
  assigned: 2,
  project: 3,
  client: 3,
  organization: 4,
};

/**
 * Coverage for ceilings: a held grant (p, held) covers a requested (p, wanted)
 * iff equal, or held is `organization` and wanted is a staff sub-scope.
 * `client` is only covered by `client`.
 */
export function scopeCovers(held: Scope, wanted: Scope): boolean {
  if (held === wanted) return true;
  return (
    held === 'organization' &&
    (wanted === 'own' || wanted === 'assigned' || wanted === 'project')
  );
}

// ============================================================
//  Legacy model (used ONLY by the migration + compatibility shim)
// ============================================================

export const LEGACY_MODULES = [
  'dashboard',
  'clients',
  'projects',
  'team',
  'attendance',
  'calendar',
  'messages',
  'documents',
  'sheets',
  'ai',
  'finance',
  'business',
  'settings',
] as const;
export type LegacyModule = (typeof LEGACY_MODULES)[number];
export const LEGACY_LEVELS = ['none', 'view', 'edit', 'manage'] as const;
export type LegacyLevel = (typeof LEGACY_LEVELS)[number];
export type LegacyRole = 'owner' | 'admin' | 'member' | 'client';

const LEVEL_RANK: Record<LegacyLevel, number> = {
  none: 0,
  view: 1,
  edit: 2,
  manage: 3,
};
export const legacyMeets = (have: LegacyLevel, need: LegacyLevel) =>
  LEVEL_RANK[have] >= LEVEL_RANK[need];

/**
 * One way a legacy user obtained this capability.
 *   who: 'any'   — any staff role (subject to module requirements)
 *        'privileged' — owner/admin role (requireRole / isPrivileged)
 *        'owner' — owner only
 *        'client' — any client user;  'client_approver' — client of an approver brand
 */
export interface LegacyRule {
  who: 'any' | 'privileged' | 'owner' | 'client' | 'client_approver';
  modules: Array<[LegacyModule, LegacyLevel]>;
  scope: Scope;
}

/**
 * Compact DSL:  "[who] module:level[+module:level] >scope"
 *   who ∈ { *, P, O, C, CA }  (default *)
 *   e.g. "projects:view >assigned", "P team:edit >organization", "O >organization",
 *        "ai:edit+clients:edit >organization", "C >client"
 */
function parseLegacy(spec: string): LegacyRule {
  const m = /^\s*(\*|P|O|CA|C)?\s*([a-z:+]*)\s*>(\w+)\s*$/.exec(spec);
  if (!m) throw new Error(`authz catalog: bad legacy rule "${spec}"`);
  const whoMap = {
    '*': 'any',
    P: 'privileged',
    O: 'owner',
    C: 'client',
    CA: 'client_approver',
  } as const;
  const who = whoMap[(m[1] ?? '*') as keyof typeof whoMap];
  const modules: Array<[LegacyModule, LegacyLevel]> = [];
  if (m[2]) {
    for (const part of m[2].split('+')) {
      const [mod, lvl] = part.split(':') as [LegacyModule, LegacyLevel];
      if (
        !(LEGACY_MODULES as readonly string[]).includes(mod) ||
        !(LEGACY_LEVELS as readonly string[]).includes(lvl)
      ) {
        throw new Error(`authz catalog: bad legacy module "${part}" in "${spec}"`);
      }
      modules.push([mod, lvl]);
    }
  }
  const scope = m[3] as Scope;
  if (!(SCOPES as readonly string[]).includes(scope)) {
    throw new Error(`authz catalog: bad legacy scope "${scope}" in "${spec}"`);
  }
  return { who, modules, scope };
}

// ============================================================
//  Permission definitions
// ============================================================

export interface PermissionDef {
  key: string;
  resource: string;
  action: string;
  category: string;
  label: string;
  description: string;
  scopes: Scope[];
  actors: ActorType[];
  sensitive: boolean;
  /** Permissions that must also be granted (same or broader scope) when saving a role. */
  requires: string[];
  legacy: LegacyRule[];
}

export interface CategoryDef {
  key: string;
  label: string;
}

export const CATEGORIES: CategoryDef[] = [
  { key: 'organization', label: 'Organization & access' },
  { key: 'clients', label: 'Clients & CRM' },
  { key: 'content', label: 'Content calendar & social' },
  { key: 'ai', label: 'AI' },
  { key: 'projects', label: 'Projects, tasks & time' },
  { key: 'attendance', label: 'Attendance & leave' },
  { key: 'collaboration', label: 'Messages, documents & sheets' },
  { key: 'business', label: 'Business' },
  { key: 'finance', label: 'Finance' },
  { key: 'client_portal', label: 'Client portal' },
];

type Opts = {
  scopes: Scope[];
  actors?: ActorType[];
  sensitive?: boolean;
  requires?: string[];
  legacy?: string[];
};

const defs: PermissionDef[] = [];
function def(
  category: string,
  key: string,
  label: string,
  description: string,
  o: Opts,
): void {
  const [resource, action] = key.split('.');
  if (!resource || !action || key.split('.').length !== 2) {
    throw new Error(`authz catalog: bad key "${key}"`);
  }
  defs.push({
    key,
    resource,
    action,
    category,
    label,
    description,
    scopes: o.scopes,
    actors: o.actors ?? ['staff'],
    sensitive: o.sensitive ?? false,
    requires: o.requires ?? [],
    legacy: (o.legacy ?? []).map(parseLegacy),
  });
}

const SELF = ['own'] as Scope[];
const ORG = ['organization'] as Scope[];

// ---------------------------------------------------------------- Organization & access
{
  const c = 'organization';
  def(c, 'organization.view', 'View agency', 'View the agency profile and branding.', {
    scopes: ORG,
    legacy: ['* >organization'],
  });
  def(c, 'organization.update', 'Update agency', 'Change agency profile, branding and theme.', {
    scopes: ORG, sensitive: true, requires: ['organization.view'],
    legacy: ['P settings:manage >organization'],
  });
  def(c, 'organization.view_usage', 'View usage', 'View plan usage and limits.', {
    scopes: ORG, legacy: ['P >organization'],
  });
  def(c, 'organization.view_audit_log', 'View audit log', 'View the security and audit log.', {
    scopes: ORG, sensitive: true, legacy: ['P >organization'],
  });
  def(c, 'storage.view', 'View storage', 'View server storage status (platform agency only).', {
    scopes: ORG, sensitive: true, legacy: ['P settings:view >organization'],
  });
  def(c, 'storage.archive', 'Archive storage', 'Archive and delete old media (platform agency only).', {
    scopes: ORG, sensitive: true, requires: ['storage.view'],
    legacy: ['P settings:manage >organization'],
  });

  def(c, 'users.view', 'View members', 'View team members and their profiles.', {
    scopes: ORG, legacy: ['team:view >organization'],
  });
  def(c, 'users.invite', 'Invite members', 'Invite new staff members.', {
    scopes: ORG, sensitive: true, requires: ['users.view'],
    legacy: ['P team:edit >organization'],
  });
  def(c, 'users.update', 'Edit members', "Edit another member's profile details.", {
    scopes: ORG, requires: ['users.view'], legacy: ['P team:edit >organization'],
  });
  def(c, 'users.view_compensation', 'View compensation', 'View salaries and hourly rates.', {
    scopes: ORG, sensitive: true, requires: ['users.view'], legacy: ['O >organization'],
  });
  def(c, 'users.update_compensation', 'Edit compensation', 'Change salaries and hourly rates (never your own).', {
    scopes: ORG, sensitive: true, requires: ['users.view_compensation'],
    legacy: ['O >organization'],
  });
  def(c, 'users.disable', 'Disable members', 'Disable and re-enable member accounts.', {
    scopes: ORG, sensitive: true, requires: ['users.view'],
    legacy: ['P team:edit >organization'],
  });
  def(c, 'users.delete', 'Delete members', 'Permanently delete member accounts.', {
    scopes: ORG, sensitive: true, requires: ['users.view'],
    legacy: ['P team:manage >organization'],
  });
  def(c, 'users.reset_password', 'Reset passwords', 'Email a password reset link to a member.', {
    scopes: ORG, sensitive: true, requires: ['users.view'],
    legacy: ['P team:edit >organization'],
  });
  def(c, 'users.revoke_sessions', 'Sign members out', 'End all sessions of a member.', {
    scopes: ORG, sensitive: true, requires: ['users.view'],
    legacy: ['P team:edit >organization'],
  });
  def(c, 'users.view_activity', 'View member activity', "View a member's activity feed.", {
    scopes: ['own', 'organization'],
    legacy: ['team:view >own', 'P team:view >organization'],
  });
  def(c, 'users.assign_roles', 'Assign roles', 'Assign and remove roles on members.', {
    scopes: ORG, sensitive: true, requires: ['users.view', 'roles.view'],
    legacy: ['P team:edit >organization'],
  });
  def(c, 'users.manage_permissions', 'Manage member exceptions', 'Add per-member permission grants and denies.', {
    scopes: ORG, sensitive: true, requires: ['users.view', 'roles.view'],
    legacy: ['P team:edit >organization'],
  });

  def(c, 'roles.view', 'View roles', 'View roles and their permissions.', {
    scopes: ORG, legacy: ['P settings:view >organization'],
  });
  def(c, 'roles.create', 'Create roles', 'Create custom roles.', {
    scopes: ORG, sensitive: true, requires: ['roles.view'],
    legacy: ['P settings:manage >organization'],
  });
  def(c, 'roles.update', 'Edit roles', 'Edit custom roles and editable system roles.', {
    scopes: ORG, sensitive: true, requires: ['roles.view'],
    legacy: ['P settings:manage >organization'],
  });
  def(c, 'roles.archive', 'Archive roles', 'Archive custom roles.', {
    scopes: ORG, sensitive: true, requires: ['roles.view'],
    legacy: ['P settings:manage >organization'],
  });

  def(c, 'client_users.view', 'View client users', 'View client portal accounts.', {
    scopes: ['assigned', 'organization'], legacy: ['P team:view >organization'],
  });
  def(c, 'client_users.invite', 'Invite client users', 'Invite people to the client portal.', {
    scopes: ['assigned', 'organization'], sensitive: true, requires: ['client_users.view'],
    legacy: ['P team:edit >organization'],
  });
  def(c, 'client_users.update', 'Edit client users', 'Change client user details, role and project access.', {
    scopes: ['assigned', 'organization'], requires: ['client_users.view'],
    legacy: ['P team:edit >organization'],
  });
  def(c, 'client_users.disable', 'Disable client users', 'Disable or delete client portal accounts.', {
    scopes: ['assigned', 'organization'], sensitive: true, requires: ['client_users.view'],
    legacy: ['P team:edit >organization'],
  });
  def(c, 'client_users.reset_password', 'Reset client passwords', 'Email a reset link to a client user.', {
    scopes: ['assigned', 'organization'], sensitive: true, requires: ['client_users.view'],
    legacy: ['P team:edit >organization'],
  });
}

// ---------------------------------------------------------------- Clients & CRM
{
  const c = 'clients';
  const AO: Scope[] = ['assigned', 'organization'];
  def(c, 'clients.view', 'View clients', 'View clients, profiles and follow-ups.', {
    scopes: AO, legacy: ['clients:view >organization'],
  });
  def(c, 'clients.create', 'Create clients', 'Create new clients.', {
    scopes: ORG, requires: ['clients.view'], legacy: ['clients:edit >organization'],
  });
  def(c, 'clients.update', 'Edit clients', 'Edit client details.', {
    scopes: AO, requires: ['clients.view'], legacy: ['clients:edit >organization'],
  });
  def(c, 'clients.archive', 'Archive clients', 'Archive and restore clients.', {
    scopes: AO, requires: ['clients.view'], legacy: ['clients:manage >organization'],
  });
  def(c, 'clients.view_financials', 'View client financials', 'View billing details, outstanding amounts and invoice counts.', {
    scopes: AO, sensitive: true, requires: ['clients.view'], legacy: ['O >organization'],
  });
  def(c, 'clients.view_activity', 'View client activity', 'View the cross-module activity feed of a client.', {
    scopes: AO, requires: ['clients.view'],
    legacy: ['clients:view+projects:manage >organization'],
  });
  def(c, 'clients.manage_assignments', 'Manage client team', 'Set the account owner and assigned team.', {
    scopes: ORG, requires: ['clients.view', 'users.view'],
    legacy: ['P team:edit >organization'],
  });
  def(c, 'clients.manage_portal', 'Manage client portal', 'Create share links and change portal settings.', {
    scopes: AO, sensitive: true, requires: ['clients.view'],
    legacy: ['P clients:edit >organization'],
  });
  def(c, 'contacts.manage', 'Manage contacts', 'Create, edit and delete client contacts.', {
    scopes: AO, requires: ['clients.view'], legacy: ['clients:edit >organization'],
  });
  def(c, 'client_notes.create', 'Add notes', 'Add CRM notes and activities.', {
    scopes: AO, requires: ['clients.view'], legacy: ['clients:edit >organization'],
  });
  def(c, 'client_notes.update', 'Edit notes', 'Edit CRM notes.', {
    scopes: ['own', 'organization'], requires: ['clients.view'],
    legacy: ['clients:edit >own', 'clients:manage >organization'],
  });
  def(c, 'client_notes.delete', 'Delete notes', 'Delete CRM notes.', {
    scopes: ['own', 'organization'], requires: ['clients.view'],
    legacy: ['clients:edit >own', 'clients:manage >organization'],
  });
  def(c, 'tags.manage', 'Manage tags', 'Create and delete tag definitions.', {
    scopes: ORG, legacy: ['P clients:edit >organization'],
  });
  def(c, 'deals.view', 'View deals', 'View deals and the pipeline.', {
    scopes: AO, legacy: ['clients:view >organization'],
  });
  def(c, 'deals.create', 'Create deals', 'Create deals.', {
    scopes: AO, requires: ['deals.view'], legacy: ['clients:edit >organization'],
  });
  def(c, 'deals.update', 'Edit deals', 'Edit deals and move stages.', {
    scopes: AO, requires: ['deals.view'], legacy: ['clients:edit >organization'],
  });
  def(c, 'deals.delete', 'Delete deals', 'Delete deals.', {
    scopes: AO, requires: ['deals.view'], legacy: ['clients:manage >organization'],
  });
  def(c, 'deals.view_value', 'View deal values', 'See deal amounts.', {
    scopes: AO, sensitive: true, requires: ['deals.view'], legacy: ['O >organization'],
  });
  def(c, 'deals.update_value', 'Edit deal values', 'Set deal amounts.', {
    scopes: AO, sensitive: true, requires: ['deals.view_value', 'deals.update'],
    legacy: ['O >organization'],
  });
}

// ---------------------------------------------------------------- Content calendar & social
{
  const c = 'content';
  const AO: Scope[] = ['assigned', 'organization'];
  def(c, 'posts.view', 'View posts', 'View calendar posts and reservations.', {
    scopes: ['assigned', 'organization', 'client'], actors: ['staff', 'client'],
    legacy: ['clients:view >organization', 'C >client'],
  });
  def(c, 'posts.create', 'Create posts', 'Create posts and reservations.', {
    scopes: AO, requires: ['posts.view'], legacy: ['clients:edit >organization'],
  });
  def(c, 'posts.update', 'Edit posts', 'Edit posts and reservations (edits reset client approval).', {
    scopes: ['own', 'assigned', 'organization'], requires: ['posts.view'],
    legacy: ['clients:edit >organization'],
  });
  def(c, 'posts.delete', 'Delete posts', 'Delete posts and reservations.', {
    scopes: ['own', 'assigned', 'organization'], requires: ['posts.view'],
    legacy: ['clients:manage >organization'],
  });
  def(c, 'posts.submit_for_approval', 'Send for approval', 'Send posts to the client for approval.', {
    scopes: AO, requires: ['posts.view'], legacy: ['clients:edit >organization'],
  });
  def(c, 'posts.schedule', 'Schedule posts', 'Schedule approved posts.', {
    scopes: AO, requires: ['posts.view'], legacy: ['clients:edit >organization'],
  });
  def(c, 'posts.publish', 'Publish posts', 'Publish now, mark as posted and control auto-publishing.', {
    scopes: AO, sensitive: true, requires: ['posts.view'],
    legacy: ['clients:edit >organization'],
  });
  def(c, 'posts.archive', 'Archive month', 'Run the month-end archive sweep for posts.', {
    scopes: ORG, legacy: ['P projects:view >organization', 'projects:manage >organization'],
  });
  def(c, 'posts.restore', 'Restore posts', 'Restore archived posts.', {
    scopes: AO, requires: ['posts.view'], legacy: ['clients:edit >organization'],
  });
  def(c, 'post_comments.view', 'View comments', 'View post comments.', {
    scopes: ['assigned', 'organization', 'client'], actors: ['staff', 'client'],
    legacy: ['clients:view >organization', 'C >client'],
  });
  def(c, 'post_comments.create', 'Comment on posts', 'Comment on posts.', {
    scopes: ['assigned', 'organization', 'client'], actors: ['staff', 'client'],
    requires: ['post_comments.view'],
    legacy: ['clients:edit >organization', 'C >client'],
  });
  def(c, 'media.upload', 'Upload media', 'Attach media to posts.', {
    scopes: AO, requires: ['posts.view'], legacy: ['clients:edit >organization'],
  });
  def(c, 'media.delete', 'Remove media', 'Remove media from posts.', {
    scopes: ['own', 'assigned', 'organization'], requires: ['posts.view'],
    legacy: ['clients:manage >organization'],
  });
  def(c, 'social_accounts.view', 'View social accounts', 'View connected social accounts.', {
    scopes: AO, legacy: ['clients:view >organization'],
  });
  def(c, 'social_accounts.manage', 'Manage social accounts', 'Connect or disconnect accounts and change auto-publish.', {
    scopes: AO, sensitive: true, requires: ['social_accounts.view'],
    legacy: ['clients:edit >organization'],
  });
}

// ---------------------------------------------------------------- AI
{
  const c = 'ai';
  def(c, 'ai.generate_content', 'Generate content', 'Generate captions, ideas, month plans and repurposed content.', {
    scopes: ['assigned', 'organization'], requires: ['clients.view'],
    legacy: ['ai:edit+clients:edit >organization'],
  });
  def(c, 'ai.use_assistant', 'Use AI assistant', 'Chat assistant and document generation (limited to data you can view).', {
    scopes: ORG, legacy: ['ai:edit >organization'],
  });
  def(c, 'ai.task_breakdown', 'AI task breakdown', 'Generate tasks and milestones with AI (also needs task permissions).', {
    scopes: ['project', 'organization'], requires: ['tasks.create'],
    legacy: ['ai:edit+projects:view >project', 'ai:edit+projects:manage >organization', 'P ai:edit+projects:view >organization'],
  });
}

// ---------------------------------------------------------------- Projects, tasks & time
{
  const c = 'projects';
  const AO: Scope[] = ['assigned', 'organization'];
  const STRUCT = [
    'projects:edit >assigned',
    'projects:manage >organization',
    'P projects:edit >organization',
  ];
  def(c, 'projects.view', 'View projects', 'View projects, overview and activity.', {
    scopes: ['assigned', 'organization', 'client'], actors: ['staff', 'client'],
    legacy: ['projects:view >organization', 'C >client'],
  });
  def(c, 'projects.create', 'Create projects', 'Create projects.', {
    scopes: ORG, requires: ['projects.view'],
    legacy: ['projects:manage >organization', 'P projects:edit >organization'],
  });
  def(c, 'projects.update', 'Edit projects', 'Edit project details and status.', {
    scopes: AO, requires: ['projects.view'], legacy: STRUCT,
  });
  def(c, 'projects.delete', 'Delete projects', 'Delete projects and everything in them.', {
    scopes: ORG, sensitive: true, requires: ['projects.view'],
    legacy: ['projects:manage >organization'],
  });
  def(c, 'projects.view_financials', 'View project financials', 'See contract value and billing.', {
    scopes: AO, sensitive: true, requires: ['projects.view'], legacy: ['O >organization'],
  });
  def(c, 'projects.update_financials', 'Edit project financials', 'Set contract value and billing.', {
    scopes: AO, sensitive: true, requires: ['projects.view_financials', 'projects.update'],
    legacy: ['O >organization'],
  });
  def(c, 'projects.manage_members', 'Manage project members', 'Add and remove project members.', {
    scopes: AO, requires: ['projects.view'], legacy: STRUCT,
  });
  def(c, 'projects.view_team', 'View project team', 'See the project team in the client portal.', {
    scopes: ['client'], actors: ['client'], requires: ['projects.view'],
    legacy: ['C >client'],
  });
  def(c, 'project_milestones.manage', 'Manage milestones', 'Create, edit and delete milestones.', {
    scopes: AO, requires: ['projects.view'], legacy: STRUCT,
  });
  def(c, 'project_labels.manage', 'Manage labels', 'Create, edit and delete project task labels.', {
    scopes: AO, requires: ['projects.view'], legacy: STRUCT,
  });

  const WIDE = ['projects:manage >organization', 'P projects:view >organization'];
  def(c, 'tasks.view', 'View tasks', 'View tasks, subtasks, dependencies and history.', {
    scopes: ['own', 'assigned', 'project', 'organization'],
    legacy: ['projects:view >own', 'projects:view >assigned', 'projects:view >project', ...WIDE],
  });
  def(c, 'tasks.create', 'Create tasks', 'Create tasks and subtasks.', {
    scopes: ['project', 'organization'], requires: ['tasks.view'],
    legacy: ['projects:view >project', ...WIDE],
  });
  def(c, 'tasks.update', 'Edit tasks', 'Edit task fields, status, labels and dependencies.', {
    scopes: ['own', 'assigned', 'project', 'organization'], requires: ['tasks.view'],
    legacy: ['projects:view >own', 'projects:view >assigned', 'projects:edit >project', ...WIDE],
  });
  def(c, 'tasks.assign', 'Assign tasks', 'Assign tasks to other people.', {
    scopes: ['project', 'organization'], requires: ['tasks.update'],
    legacy: ['projects:edit >project', ...WIDE],
  });
  def(c, 'tasks.delete', 'Delete tasks', 'Delete tasks.', {
    scopes: ['own', 'project', 'organization'], requires: ['tasks.view'],
    legacy: ['projects:view >own', ...WIDE],
  });
  def(c, 'tasks.archive', 'Archive month', 'Run the month-end archive sweep for tasks.', {
    scopes: ORG, legacy: WIDE,
  });
  def(c, 'tasks.restore', 'Restore tasks', 'Restore archived tasks.', {
    scopes: ['project', 'organization'], requires: ['tasks.view'], legacy: WIDE,
  });
  def(c, 'task_comments.create', 'Comment on tasks', 'Comment on tasks.', {
    scopes: ['own', 'assigned', 'project', 'organization'], requires: ['tasks.view'],
    legacy: ['projects:view >own', 'projects:view >assigned', 'projects:view >project', ...WIDE],
  });
  def(c, 'task_comments.update', 'Edit task comments', 'Edit task comments.', {
    scopes: ['own', 'organization'], requires: ['tasks.view'],
    legacy: ['projects:view >own'],
  });
  def(c, 'task_comments.delete', 'Delete task comments', 'Delete task comments.', {
    scopes: ['own', 'organization'], requires: ['tasks.view'],
    legacy: ['projects:view >own'],
  });
  def(c, 'timers.use', 'Track time', 'Start and stop your own timers.', {
    scopes: SELF, legacy: ['projects:view >own'],
  });
  def(c, 'timers.view', 'See active timers', 'See who is tracking time.', {
    scopes: ['project', 'organization'],
    legacy: ['projects:view >project', ...WIDE],
  });
  def(c, 'time_logs.view', 'View time logs', 'View time logs.', {
    scopes: ['own', 'project', 'organization'],
    legacy: ['projects:view >own', 'projects:view >project', ...WIDE, 'P team:view >organization'],
  });
  def(c, 'time_logs.create', 'Log time', 'Log time manually.', {
    scopes: ['own', 'organization'], requires: ['time_logs.view'],
    legacy: ['team:edit >own', 'P team:edit >organization'],
  });
  def(c, 'time_logs.update', 'Edit time logs', 'Edit time log entries.', {
    scopes: ['own', 'organization'], requires: ['time_logs.view'],
    legacy: ['projects:edit >own', ...WIDE],
  });
  def(c, 'time_logs.delete', 'Delete time logs', 'Delete time log entries.', {
    scopes: ['own', 'organization'], requires: ['time_logs.view'],
    legacy: ['projects:edit >own', ...WIDE],
  });
  def(c, 'reports.view_dashboard', 'Agency dashboard', 'View agency dashboard analytics.', {
    scopes: ORG, legacy: ['dashboard:view >organization'],
  });
  def(c, 'reports.view_team_overview', 'Team overview', 'View team workload and utilization.', {
    scopes: ORG, legacy: ['projects:view >organization'],
  });
  def(c, 'reports.view_leaderboard', 'Leaderboard', 'View the performance leaderboard (includes attendance).', {
    scopes: ORG, sensitive: true, legacy: ['projects:manage >organization'],
  });
}

// ---------------------------------------------------------------- Attendance & leave
{
  const c = 'attendance';
  const APPROVER = ['P attendance:edit >organization', 'attendance:manage >organization'];
  const APPROVER_VIEW = ['P attendance:view >organization', 'attendance:manage >organization'];
  def(c, 'attendance.check_in', 'Check in/out', 'Check in and out, see your own day.', {
    scopes: SELF, legacy: ['attendance:edit >own'],
  });
  def(c, 'attendance.view', 'View attendance', 'View attendance calendars and summaries.', {
    scopes: ['own', 'organization'],
    legacy: ['attendance:view >own', 'P attendance:view >organization'],
  });
  def(c, 'attendance.view_live', "Who's in", 'See who is in right now.', {
    scopes: ORG, legacy: APPROVER_VIEW,
  });
  def(c, 'attendance.view_reports', 'Attendance reports', 'Team summaries and reports, including utilization.', {
    scopes: ORG, sensitive: true, legacy: APPROVER_VIEW,
  });
  def(c, 'attendance.email_reports', 'Email reports', 'Email attendance reports.', {
    scopes: ORG, sensitive: true, requires: ['attendance.view_reports'], legacy: APPROVER,
  });
  def(c, 'attendance.mark', 'Mark attendance', "Mark or override someone else's attendance.", {
    scopes: ORG, sensitive: true, requires: ['attendance.view'],
    legacy: ['P attendance:edit >organization'],
  });
  def(c, 'attendance.manage_policy', 'Attendance policy', 'Office hours, geofence and network policy.', {
    scopes: ORG, sensitive: true, legacy: ['P attendance:edit >organization'],
  });
  def(c, 'holidays.manage', 'Manage holidays', 'Add and remove holidays.', {
    scopes: ORG, legacy: ['P attendance:edit >organization'],
  });
  def(c, 'leave_types.manage', 'Manage leave types', 'Manage leave types and quotas.', {
    scopes: ORG, legacy: ['P attendance:edit >organization'],
  });
  def(c, 'leaves.request', 'Request leave', 'Request leave for yourself.', {
    scopes: SELF, legacy: ['attendance:edit >own'],
  });
  def(c, 'leaves.view', 'View leave', 'View leave requests and balances.', {
    scopes: ['own', 'organization'],
    legacy: ['attendance:view >own', 'P attendance:view >organization'],
  });
  def(c, 'leaves.approve', 'Approve leave', 'Approve or reject leave (never your own).', {
    scopes: ORG, sensitive: true, requires: ['leaves.view'],
    legacy: ['P attendance:edit >organization'],
  });
  def(c, 'leaves.cancel', 'Cancel leave', 'Cancel leave requests (own: pending or upcoming only).', {
    scopes: ['own', 'organization'],
    legacy: ['attendance:edit >own', 'P attendance:edit >organization'],
  });
  def(c, 'regularizations.request', 'Request regularization', 'Request an attendance correction.', {
    scopes: SELF, legacy: ['attendance:edit >own'],
  });
  def(c, 'regularizations.view', 'View regularizations', 'View attendance correction requests.', {
    scopes: ['own', 'organization'], legacy: ['attendance:view >own', ...APPROVER_VIEW],
  });
  def(c, 'regularizations.approve', 'Approve regularizations', 'Approve or reject corrections (never your own).', {
    scopes: ORG, sensitive: true, requires: ['regularizations.view'], legacy: APPROVER,
  });
  def(c, 'regularizations.cancel', 'Cancel regularizations', 'Cancel correction requests (own: pending only).', {
    scopes: ['own', 'organization'],
    legacy: ['attendance:edit >own', 'P attendance:edit >organization'],
  });
  def(c, 'checkout_requests.request', 'Request checkout', 'Request an out-of-office checkout.', {
    scopes: SELF, legacy: ['attendance:edit >own'],
  });
  def(c, 'checkout_requests.view', 'View checkout requests', 'View out-of-office checkout requests.', {
    scopes: ['own', 'organization'], legacy: ['attendance:view >own', ...APPROVER_VIEW],
  });
  def(c, 'checkout_requests.approve', 'Approve checkouts', 'Approve or reject checkouts (never your own).', {
    scopes: ORG, sensitive: true, requires: ['checkout_requests.view'], legacy: APPROVER,
  });
  def(c, 'checkout_requests.cancel', 'Cancel checkout requests', 'Cancel checkout requests (own: pending only).', {
    scopes: ['own', 'organization'],
    legacy: ['attendance:edit >own', 'P attendance:edit >organization'],
  });
}

// ---------------------------------------------------------------- Messages, documents & sheets
{
  const c = 'collaboration';
  def(c, 'messages.view', 'Read messages', 'Read threads you take part in (organization: moderation).', {
    scopes: ['assigned', 'organization'], legacy: ['messages:view >assigned'],
  });
  def(c, 'messages.send', 'Send messages', 'Send messages in your threads.', {
    scopes: ['assigned'], requires: ['messages.view'], legacy: ['messages:edit >assigned'],
  });
  def(c, 'messages.update', 'Edit messages', 'Edit your messages.', {
    scopes: SELF, requires: ['messages.view'], legacy: ['messages:edit >own'],
  });
  def(c, 'messages.delete', 'Delete messages', "Delete messages (assigned: anyone's message in your threads).", {
    scopes: ['own', 'assigned', 'organization'], requires: ['messages.view'],
    legacy: ['messages:manage >own', 'P messages:manage >assigned'],
  });
  def(c, 'messages.pin', 'Pin messages', 'Pin and unpin messages.', {
    scopes: ['assigned', 'organization'], requires: ['messages.view'],
    legacy: ['messages:edit >assigned'],
  });
  def(c, 'threads.create', 'Start threads', 'Start new threads.', {
    scopes: ORG, requires: ['messages.view'], legacy: ['messages:edit >organization'],
  });
  def(c, 'threads.update', 'Edit threads', 'Rename threads and change their client link.', {
    scopes: ['own', 'organization'], requires: ['messages.view'],
    legacy: ['messages:edit >own', 'P messages:edit >organization'],
  });
  def(c, 'threads.manage_participants', 'Manage participants', 'Add and remove thread participants.', {
    scopes: ['own', 'organization'], requires: ['messages.view', 'users.view'],
    legacy: ['messages:edit >own', 'P messages:edit >organization'],
  });
  def(c, 'threads.delete', 'Delete threads', 'Delete whole threads.', {
    scopes: ['own', 'organization'], requires: ['messages.view'],
    legacy: ['messages:manage >own', 'P messages:manage >organization'],
  });

  def(c, 'documents.view', 'View documents', 'View documents and folders.', {
    scopes: ['organization', 'client'], actors: ['staff', 'client'],
    legacy: ['documents:view >organization', 'C >client'],
  });
  def(c, 'documents.view_hidden', 'View hidden documents', 'View documents hidden from the team.', {
    scopes: ORG, sensitive: true, requires: ['documents.view'], legacy: ['O >organization'],
  });
  def(c, 'documents.upload', 'Upload documents', 'Upload documents.', {
    scopes: ['organization', 'client'], actors: ['staff', 'client'],
    requires: ['documents.view'],
    legacy: ['documents:edit >organization', 'C >client'],
  });
  def(c, 'documents.update', 'Edit documents', 'Rename, recategorize and move documents.', {
    scopes: ['own', 'organization'], requires: ['documents.view'],
    legacy: ['documents:edit >own', 'documents:manage >organization'],
  });
  def(c, 'documents.delete', 'Delete documents', 'Delete documents.', {
    scopes: ['own', 'organization'], requires: ['documents.view'],
    legacy: ['documents:manage >organization'],
  });
  def(c, 'documents.share_with_client', 'Share with client', 'Make documents visible in the client portal.', {
    scopes: ORG, requires: ['documents.view'], legacy: ['documents:edit >organization'],
  });
  def(c, 'documents.hide_from_team', 'Hide from team', 'Hide documents from the team.', {
    scopes: ORG, sensitive: true, requires: ['documents.view_hidden'],
    legacy: ['O >organization'],
  });
  def(c, 'folders.create', 'Create folders', 'Create folders.', {
    scopes: ['organization', 'client'], actors: ['staff', 'client'],
    requires: ['documents.view'],
    legacy: ['documents:edit >organization', 'C >client'],
  });
  def(c, 'folders.update', 'Edit folders', 'Rename and move folders.', {
    scopes: ORG, requires: ['documents.view'], legacy: ['documents:edit >organization'],
  });
  def(c, 'folders.delete', 'Delete folders', 'Delete folders.', {
    scopes: ORG, requires: ['documents.view'], legacy: ['documents:manage >organization'],
  });

  def(c, 'sheets.view', 'View sheets', 'View sheets.', {
    scopes: ORG, legacy: ['sheets:view >organization'],
  });
  def(c, 'sheets.create', 'Create sheets', 'Create and import sheets.', {
    scopes: ORG, requires: ['sheets.view'], legacy: ['sheets:edit >organization'],
  });
  def(c, 'sheets.update', 'Edit sheets', 'Edit sheets.', {
    scopes: ['own', 'organization'], requires: ['sheets.view'],
    legacy: ['sheets:edit >organization'],
  });
  def(c, 'sheets.delete', 'Delete sheets', 'Delete sheets.', {
    scopes: ['own', 'organization'], requires: ['sheets.view'],
    legacy: ['sheets:manage >organization'],
  });
  def(c, 'sheets.publish', 'Publish sheets', 'Publish sheet rows into projects, posts and tasks (needs those permissions too).', {
    scopes: ORG, requires: ['sheets.view'], legacy: ['sheets:edit >organization'],
  });
}

// ---------------------------------------------------------------- Business
{
  const c = 'business';
  const OWN_ORG: Scope[] = ['own', 'organization'];
  const O = ['O >organization'];
  def(c, 'leads.view', 'View leads', 'View leads and their activities.', { scopes: OWN_ORG, legacy: O });
  def(c, 'leads.create', 'Create leads', 'Create leads.', { scopes: ORG, requires: ['leads.view'], legacy: O });
  def(c, 'leads.update', 'Edit leads', 'Edit leads and activities.', { scopes: OWN_ORG, requires: ['leads.view'], legacy: O });
  def(c, 'leads.delete', 'Delete leads', 'Delete leads and activities.', { scopes: OWN_ORG, requires: ['leads.view'], legacy: O });
  def(c, 'leads.assign', 'Assign leads', 'Change the owner of a lead.', { scopes: ORG, requires: ['leads.update'], legacy: O });
  def(c, 'leads.convert', 'Convert leads', 'Convert a lead into a client.', {
    scopes: OWN_ORG, requires: ['leads.view', 'clients.create'], legacy: O,
  });
  def(c, 'leads.view_value', 'View lead values', 'See budgets and estimated values.', {
    scopes: OWN_ORG, sensitive: true, requires: ['leads.view'], legacy: O,
  });

  def(c, 'proposals.view', 'View proposals', 'View proposals.', {
    scopes: ['own', 'organization', 'client'], actors: ['staff', 'client'],
    legacy: ['O >organization', 'C >client'],
  });
  def(c, 'proposals.create', 'Create proposals', 'Create proposals.', { scopes: ORG, requires: ['proposals.view'], legacy: O });
  def(c, 'proposals.update', 'Edit proposals', 'Edit draft and sent proposals.', { scopes: OWN_ORG, requires: ['proposals.view'], legacy: O });
  def(c, 'proposals.send', 'Send proposals', 'Send proposals to clients.', {
    scopes: OWN_ORG, sensitive: true, requires: ['proposals.view'], legacy: O,
  });
  def(c, 'proposals.convert', 'Convert proposals', 'Convert an accepted proposal into an agreement.', {
    scopes: OWN_ORG, requires: ['proposals.view', 'agreements.create'], legacy: O,
  });
  def(c, 'proposals.manage_templates', 'Proposal templates', 'Manage proposal templates.', { scopes: ORG, legacy: O });
  def(c, 'proposals.view_pricing', 'View proposal pricing', 'See pricing and totals.', {
    scopes: ['own', 'organization', 'client'], actors: ['staff', 'client'], sensitive: true,
    requires: ['proposals.view'], legacy: ['O >organization', 'C >client'],
  });
  def(c, 'proposals.respond', 'Respond to proposals', 'Accept or reject proposals as the client.', {
    scopes: ['client'], actors: ['client'], requires: ['proposals.view'], legacy: ['C >client'],
  });

  def(c, 'agreements.view', 'View agreements', 'View agreements.', {
    scopes: ['own', 'organization', 'client'], actors: ['staff', 'client'],
    legacy: ['O >organization', 'C >client'],
  });
  def(c, 'agreements.create', 'Create agreements', 'Create agreements.', { scopes: ORG, requires: ['agreements.view'], legacy: O });
  def(c, 'agreements.update', 'Edit agreements', 'Edit unsigned agreements.', { scopes: OWN_ORG, requires: ['agreements.view'], legacy: O });
  def(c, 'agreements.delete', 'Delete agreements', 'Delete unsigned agreements.', {
    scopes: OWN_ORG, sensitive: true, requires: ['agreements.view'], legacy: O,
  });
  def(c, 'agreements.send', 'Send agreements', 'Send agreements for signature.', {
    scopes: OWN_ORG, sensitive: true, requires: ['agreements.view'], legacy: O,
  });
  def(c, 'agreements.manage_templates', 'Agreement templates', 'Manage agreement templates.', { scopes: ORG, legacy: O });
  def(c, 'agreements.view_pricing', 'View agreement value', 'See agreement value and retainer.', {
    scopes: ['own', 'organization', 'client'], actors: ['staff', 'client'], sensitive: true,
    requires: ['agreements.view'], legacy: ['O >organization', 'C >client'],
  });
  def(c, 'agreements.sign', 'Sign agreements', 'Sign agreements as the client.', {
    scopes: ['client'], actors: ['client'], requires: ['agreements.view'], legacy: ['C >client'],
  });
}

// ---------------------------------------------------------------- Finance
{
  const c = 'finance';
  const O = ['O >organization'];
  def(c, 'invoices.view', 'View invoices', 'View invoices and payments.', {
    scopes: ['organization', 'client'], actors: ['staff', 'client'],
    legacy: ['O >organization', 'C >client'],
  });
  def(c, 'invoices.create', 'Create invoices', 'Create invoices.', { scopes: ORG, requires: ['invoices.view'], legacy: O });
  def(c, 'invoices.update', 'Edit invoices', 'Edit unpaid invoices, including bank details.', {
    scopes: ORG, sensitive: true, requires: ['invoices.view'], legacy: O,
  });
  def(c, 'invoices.change_status', 'Change invoice status', 'Mark invoices sent, paid or cancelled.', {
    scopes: ORG, sensitive: true, requires: ['invoices.view'], legacy: O,
  });
  def(c, 'invoices.record_payment', 'Record payments', 'Record invoice payments.', {
    scopes: ORG, sensitive: true, requires: ['invoices.view'], legacy: O,
  });
  def(c, 'invoices.send', 'Send invoices', 'Email invoices to clients.', {
    scopes: ORG, sensitive: true, requires: ['invoices.view'], legacy: O,
  });
  def(c, 'invoices.sync', 'Sync invoices', 'Sync invoices with Refrens.', {
    scopes: ORG, sensitive: true, requires: ['invoices.view'], legacy: O,
  });
  def(c, 'expenses.view', 'View expenses', 'View expenses.', { scopes: ['own', 'organization'], legacy: O });
  def(c, 'expenses.create', 'Log expenses', 'Log expenses.', { scopes: ORG, requires: ['expenses.view'], legacy: O });
  def(c, 'expenses.update', 'Edit expenses', 'Edit expenses.', { scopes: ['own', 'organization'], requires: ['expenses.view'], legacy: O });
  def(c, 'expenses.delete', 'Delete expenses', 'Delete expenses.', { scopes: ['own', 'organization'], requires: ['expenses.view'], legacy: O });
  def(c, 'finance.view_overview', 'Finance overview', 'Profit & loss overview and receivables.', {
    scopes: ORG, sensitive: true, legacy: O,
  });
  def(c, 'finance.view_reports', 'Finance reports', 'Finance reports.', {
    scopes: ORG, sensitive: true, legacy: O,
  });
}

// ---------------------------------------------------------------- Client-portal-only
{
  const c = 'client_portal';
  def(c, 'posts.approve', 'Approve posts', 'Approve posts or request changes as the client.', {
    scopes: ['client'], actors: ['client'], requires: ['posts.view'],
    legacy: ['CA >client'],
  });
}

// ============================================================
//  Indexes & validation
// ============================================================

export const PERMISSIONS: readonly PermissionDef[] = Object.freeze(defs);
export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);
const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function getPermission(key: string): PermissionDef | undefined {
  return BY_KEY.get(key);
}
export function isPermissionKey(key: string): boolean {
  return BY_KEY.has(key);
}
export function isScope(s: unknown): s is Scope {
  return typeof s === 'string' && (SCOPES as readonly string[]).includes(s);
}
/** True when `scope` is a valid scope for `permission` (unknown → false). */
export function isValidGrant(permission: string, scope: string): boolean {
  const p = BY_KEY.get(permission);
  return !!p && isScope(scope) && p.scopes.includes(scope);
}
export function permissionsForActor(actor: ActorType): PermissionDef[] {
  return PERMISSIONS.filter((p) => p.actors.includes(actor));
}
/** Scopes of `p` usable by an actor type (client actors only use `client`). */
export function scopesForActor(p: PermissionDef, actor: ActorType): Scope[] {
  return actor === 'client'
    ? p.scopes.filter((s) => s === 'client')
    : p.scopes.filter((s) => s !== 'client');
}
export function broadestScope(p: PermissionDef, actor: ActorType): Scope | null {
  const s = scopesForActor(p, actor);
  if (!s.length) return null;
  return s.reduce((a, b) => (SCOPE_BREADTH[b] > SCOPE_BREADTH[a] ? b : a));
}

// Self-check at module load: keys unique, requires resolvable, categories known.
{
  const seen = new Set<string>();
  const cats = new Set(CATEGORIES.map((c) => c.key));
  for (const p of PERMISSIONS) {
    if (seen.has(p.key)) throw new Error(`authz catalog: duplicate ${p.key}`);
    seen.add(p.key);
    if (!cats.has(p.category)) throw new Error(`authz catalog: bad category ${p.category}`);
    if (!p.scopes.length) throw new Error(`authz catalog: ${p.key} has no scopes`);
    for (const a of p.actors) {
      if (!scopesForActor(p, a).length) {
        throw new Error(`authz catalog: ${p.key} has no scope usable by ${a}`);
      }
    }
  }
  for (const p of PERMISSIONS) {
    for (const r of p.requires) {
      if (!BY_KEY.has(r)) throw new Error(`authz catalog: ${p.key} requires unknown ${r}`);
    }
  }
}

// ============================================================
//  Grants, templates & system roles
// ============================================================

export interface Grant {
  permission: string;
  scope: Scope;
}

const g = (permission: string, scope: Scope): Grant => ({ permission, scope });

/** Every permission for an actor type at its broadest scope. */
export function fullGrants(actor: ActorType): Grant[] {
  return permissionsForActor(actor).map((p) => g(p.key, broadestScope(p, actor)!));
}

/**
 * Evaluate the legacy rules of the catalog for a legacy principal. This is how
 * (a) the backfill materializes today's effective access into explicit grants,
 * (b) system-role/template defaults are expressed in terms of the old presets.
 */
export function grantsFromLegacy(input: {
  role: LegacyRole;
  levels: Partial<Record<LegacyModule, LegacyLevel>>;
  clientApprover?: boolean;
}): Grant[] {
  const out: Grant[] = [];
  const seen = new Set<string>();
  const level = (m: LegacyModule): LegacyLevel => input.levels[m] ?? 'none';
  for (const p of PERMISSIONS) {
    for (const rule of p.legacy) {
      let who: boolean;
      switch (rule.who) {
        case 'any': who = input.role !== 'client'; break;
        case 'privileged': who = input.role === 'owner' || input.role === 'admin'; break;
        case 'owner': who = input.role === 'owner'; break;
        case 'client': who = input.role === 'client'; break;
        case 'client_approver': who = input.role === 'client' && !!input.clientApprover; break;
      }
      if (!who) continue;
      if (input.role !== 'client' && !rule.modules.every(([m, l]) => legacyMeets(level(m), l))) {
        continue;
      }
      const k = `${p.key}|${rule.scope}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(g(p.key, rule.scope));
      }
    }
  }
  return out;
}

const ALL_MANAGE = Object.fromEntries(
  LEGACY_MODULES.map((m) => [m, 'manage' as LegacyLevel]),
) as Record<LegacyModule, LegacyLevel>;

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  actorType: ActorType;
  colorToken: string;
  grants: Grant[];
}

const MANAGER_LEVELS: Partial<Record<LegacyModule, LegacyLevel>> = {
  dashboard: 'manage', clients: 'manage', projects: 'manage', team: 'view',
  attendance: 'manage', calendar: 'manage', messages: 'manage', documents: 'manage',
  sheets: 'manage', ai: 'manage',
};
const EMPLOYEE_LEVELS: Partial<Record<LegacyModule, LegacyLevel>> = {
  dashboard: 'view', clients: 'view', projects: 'edit', team: 'view',
  attendance: 'edit', calendar: 'edit', messages: 'edit', documents: 'edit',
  sheets: 'edit', ai: 'edit',
};

function pick(keys: string[], actor: ActorType = 'staff'): Grant[] {
  return keys.map((k) => {
    const p = BY_KEY.get(k);
    if (!p) throw new Error(`authz catalog: template references unknown ${k}`);
    return g(k, broadestScope(p, actor)!);
  });
}

const CLIENT_APPROVER_KEYS = [
  'projects.view', 'projects.view_team', 'documents.view', 'documents.upload',
  'folders.create', 'posts.view', 'post_comments.view', 'post_comments.create',
  'posts.approve', 'proposals.view', 'proposals.view_pricing', 'proposals.respond',
  'agreements.view', 'agreements.view_pricing', 'agreements.sign', 'invoices.view',
];

/** Templates pre-fill "Create role"; they are not stored. */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: 'manager', name: 'Manager', actorType: 'staff', colorToken: 'ocean',
    description: 'Runs delivery: clients, projects, content, attendance approvals and messages. No finance, business or agency settings.',
    grants: grantsFromLegacy({ role: 'member', levels: MANAGER_LEVELS }),
  },
  {
    key: 'employee', name: 'Employee', actorType: 'staff', colorToken: 'pine',
    description: 'Does the work: own and assigned tasks, time tracking, content, documents, attendance.',
    grants: grantsFromLegacy({ role: 'member', levels: EMPLOYEE_LEVELS }),
  },
  {
    key: 'accountant', name: 'Accountant', actorType: 'staff', colorToken: 'brass',
    description: 'Invoices, expenses and finance reports.',
    grants: pick([
      'organization.view', 'clients.view', 'clients.view_financials', 'projects.view',
      'projects.view_financials', 'invoices.view', 'invoices.create', 'invoices.update',
      'invoices.change_status', 'invoices.record_payment', 'invoices.send',
      'expenses.view', 'expenses.create', 'expenses.update', 'expenses.delete',
      'finance.view_overview', 'finance.view_reports', 'attendance.check_in',
      'leaves.request', 'leaves.view', 'messages.view', 'messages.send', 'threads.create',
    ]).map((x) => (['leaves.view'].includes(x.permission) ? g(x.permission, 'own') : x)),
  },
  {
    key: 'content_manager', name: 'Content Manager', actorType: 'staff', colorToken: 'rose',
    description: 'Content calendars, approvals, publishing and social accounts for all clients.',
    grants: pick([
      'organization.view', 'clients.view', 'posts.view', 'posts.create', 'posts.update',
      'posts.delete', 'posts.submit_for_approval', 'posts.schedule', 'posts.publish',
      'posts.restore', 'post_comments.view', 'post_comments.create', 'media.upload',
      'media.delete', 'social_accounts.view', 'social_accounts.manage',
      'ai.generate_content', 'documents.view', 'documents.upload', 'messages.view',
      'messages.send', 'threads.create', 'attendance.check_in', 'leaves.request',
    ]),
  },
  {
    key: 'hr_manager', name: 'HR Manager', actorType: 'staff', colorToken: 'violet',
    description: 'Team profiles, attendance, leave and approvals.',
    grants: pick([
      'organization.view', 'users.view', 'users.update', 'users.view_activity',
      'attendance.check_in', 'attendance.view', 'attendance.view_live',
      'attendance.view_reports', 'attendance.email_reports', 'attendance.mark',
      'attendance.manage_policy', 'holidays.manage', 'leave_types.manage',
      'leaves.request', 'leaves.view', 'leaves.approve', 'leaves.cancel',
      'regularizations.request', 'regularizations.view', 'regularizations.approve',
      'regularizations.cancel', 'checkout_requests.request', 'checkout_requests.view',
      'checkout_requests.approve', 'checkout_requests.cancel', 'messages.view',
      'messages.send', 'threads.create',
    ]),
  },
  {
    key: 'viewer', name: 'Viewer', actorType: 'staff', colorToken: 'slate',
    description: 'Read-only access to clients, projects, content and documents.',
    grants: pick([
      'organization.view', 'clients.view', 'projects.view', 'tasks.view', 'posts.view',
      'post_comments.view', 'documents.view', 'sheets.view', 'messages.view',
    ]),
  },
  {
    key: 'client_viewer', name: 'Client viewer', actorType: 'client', colorToken: 'slate',
    description: 'Client portal read-only.',
    grants: pick(['projects.view', 'documents.view', 'posts.view', 'post_comments.view'], 'client'),
  },
];

export const SYSTEM_ROLE_KEYS = [
  'owner',
  'admin',
  'employee',
  'client_approver',
  'client_reviewer',
  'share_link',
  'share_link_reviewer',
] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export interface SystemRoleDef {
  key: SystemRoleKey;
  name: string;
  description: string;
  actorType: ActorType;
  locked: boolean;
  colorToken: string;
  /** Default grants for NEW agencies (existing agencies are backfilled from legacy data). */
  grants: () => Grant[];
}

export const SYSTEM_ROLES: SystemRoleDef[] = [
  {
    key: 'owner', name: 'Owner', actorType: 'staff', locked: true, colorToken: 'brass',
    description: 'Full access to everything. Always kept in sync with the catalog. At least one active owner is required.',
    grants: () => fullGrants('staff'),
  },
  {
    key: 'admin', name: 'Administrator', actorType: 'staff', locked: false, colorToken: 'sky',
    description: 'Runs the agency day to day. No finance, business, compensation or hidden documents by default.',
    grants: () => grantsFromLegacy({ role: 'admin', levels: { ...ALL_MANAGE, finance: 'none', business: 'none' } }),
  },
  {
    key: 'employee', name: 'Employee', actorType: 'staff', locked: false, colorToken: 'pine',
    description: 'Default role for new team members.',
    grants: () => grantsFromLegacy({ role: 'member', levels: EMPLOYEE_LEVELS }),
  },
  {
    key: 'client_approver', name: 'Client (approver)', actorType: 'client', locked: false, colorToken: 'rose',
    description: 'Client portal with content approval, proposals, agreements and invoices.',
    grants: () => pick(CLIENT_APPROVER_KEYS, 'client'),
  },
  {
    key: 'client_reviewer', name: 'Client (reviewer)', actorType: 'client', locked: false, colorToken: 'amber',
    description: 'Client portal without content approval.',
    grants: () => pick(CLIENT_APPROVER_KEYS.filter((k) => k !== 'posts.approve'), 'client'),
  },
  {
    key: 'share_link', name: 'Share link (approve)', actorType: 'client', locked: false, colorToken: 'violet',
    description: 'Share links that can review, comment on and approve posts.',
    grants: () => pick(['posts.view', 'post_comments.view', 'post_comments.create', 'posts.approve'], 'client'),
  },
  {
    key: 'share_link_reviewer', name: 'Share link (review)', actorType: 'client', locked: false, colorToken: 'slate',
    description: 'Share links that can review and comment on posts.',
    grants: () => pick(['posts.view', 'post_comments.view', 'post_comments.create'], 'client'),
  },
];

export function systemRole(key: SystemRoleKey): SystemRoleDef {
  const r = SYSTEM_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(`unknown system role ${key}`);
  return r;
}

/**
 * Validate a role's grant set against the catalog: known permission, valid
 * scope for the role's actor type, and `requires` satisfied (same or broader
 * scope, or any scope when the required permission has no overlapping scope).
 * Returns human-readable problems (empty = valid).
 */
export function validateGrantSet(grants: Grant[], actor: ActorType): string[] {
  const problems: string[] = [];
  const held = new Map<string, Scope[]>();
  for (const gr of grants) {
    const p = BY_KEY.get(gr.permission);
    if (!p) {
      problems.push(`Unknown permission "${gr.permission}".`);
      continue;
    }
    if (!p.actors.includes(actor)) {
      problems.push(`"${gr.permission}" cannot be granted to ${actor} roles.`);
      continue;
    }
    if (!scopesForActor(p, actor).includes(gr.scope)) {
      problems.push(`"${gr.permission}" does not support scope "${gr.scope}".`);
      continue;
    }
    held.set(gr.permission, [...(held.get(gr.permission) ?? []), gr.scope]);
  }
  for (const [key, scopes] of held) {
    const p = BY_KEY.get(key)!;
    for (const req of p.requires) {
      const reqDef = BY_KEY.get(req)!;
      if (!reqDef.actors.includes(actor)) continue;
      const have = held.get(req);
      if (!have) {
        problems.push(`"${key}" requires "${req}".`);
        continue;
      }
      for (const s of scopes) {
        const reqScopes = scopesForActor(reqDef, actor);
        // Same-resource requirements (x.update → x.view) must cover the scope;
        // cross-resource requirements (threads.create → messages.view) need any scope.
        const comparable = reqDef.resource === p.resource && reqScopes.includes(s);
        if (comparable && !have.some((h) => scopeCovers(h, s))) {
          problems.push(`"${key}" at scope "${s}" requires "${req}" at the same or a broader scope.`);
        }
      }
    }
  }
  return problems;
}

/** Add missing `requires` (at matching or broadest scope) — used by migration & templates. */
export function closeOverRequires(grants: Grant[], actor: ActorType): Grant[] {
  const out = [...grants];
  const has = (k: string, s?: Scope) =>
    out.some((x) => x.permission === k && (!s || scopeCovers(x.scope, s)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const gr of [...out]) {
      const p = BY_KEY.get(gr.permission);
      if (!p) continue;
      for (const req of p.requires) {
        const r = BY_KEY.get(req)!;
        if (!r.actors.includes(actor)) continue;
        const rs = scopesForActor(r, actor);
        const same = r.resource === p.resource && rs.includes(gr.scope);
        const scope: Scope = same ? gr.scope : broadestScope(r, actor)!;
        if (!has(req, same ? gr.scope : undefined)) {
          out.push(g(req, scope));
          changed = true;
        }
      }
    }
  }
  return out;
}

/** Catalog version: changes whenever the permission set changes (clients cache on it). */
export const CATALOG_VERSION = (() => {
  let h = 0;
  for (const p of PERMISSIONS) {
    const s = `${p.key}:${p.scopes.join(',')}:${p.actors.join(',')}`;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
})();

/** Serializable catalog for clients (no legacy internals). */
export function publicCatalog() {
  return {
    version: CATALOG_VERSION,
    scopes: SCOPES.map((s) => ({ key: s, label: SCOPE_LABELS[s], description: SCOPE_DESCRIPTIONS[s] })),
    categories: CATEGORIES,
    permissions: PERMISSIONS.map((p) => ({
      key: p.key,
      resource: p.resource,
      action: p.action,
      category: p.category,
      label: p.label,
      description: p.description,
      scopes: p.scopes,
      actors: p.actors,
      sensitive: p.sensitive,
      requires: p.requires,
    })),
    templates: ROLE_TEMPLATES.map((t) => ({
      key: t.key, name: t.name, description: t.description, actorType: t.actorType,
      colorToken: t.colorToken, grants: t.grants,
    })),
  };
}
