import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  uniqueIndex,
  index,
  foreignKey,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Collision-safety: every table name is prefixed with TABLE_PREFIX so this
 * schema can live in a shared Turso DB (default "sanctum_") or a dedicated
 * one (set TABLE_PREFIX="" for bare names). Read directly from process.env
 * here (not the zod env) because drizzle-kit imports this module standalone.
 */
export const TABLE_PREFIX = process.env.TABLE_PREFIX ?? 'sanctum_';
const t = (name: string) => `${TABLE_PREFIX}${name}`;

/** unix-second timestamp column stored as INTEGER */
const ts = (name: string) => integer(name, { mode: 'timestamp' });
const now = sql`(unixepoch())`;

// ============================================================
//  PLANS (shared catalog — NO agency_id; limits live here)
// ============================================================
export const plans = sqliteTable(t('plans'), {
  id: text('id').primaryKey(), // 'studio' | 'agency' | 'partner' | 'empire'
  name: text('name').notNull(),
  maxClients: integer('max_clients'),
  maxTeamMembers: integer('max_team_members'),
  maxAiGenerations: integer('max_ai_generations'),
  maxStorageBytes: integer('max_storage_bytes'),
  priceCentsMonthly: integer('price_cents_monthly').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: ts('created_at').notNull().default(now),
});

// ============================================================
//  AGENCIES (TENANT ROOT)
// ============================================================
export const agencies = sqliteTable(t('agencies'), {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logoUrl: text('logo_url'),
  brandColor: text('brand_color'),
  // Agency-wide UI theme preset (frontend theme/registry.ts key). Owner/admin
  // sets it in Settings; applies to all the agency's users.
  themePreset: text('theme_preset').notNull().default('evergreen'),
  status: text('status', { enum: ['active', 'suspended', 'deleted'] })
    .notNull()
    .default('active'),
  // Per-agency role permission defaults: a JSON object
  // { admin: { moduleKey: level }, member: { moduleKey: level } }.
  // NULL means "use built-in defaults" (full access). See lib/permissions.ts.
  rolePermissionsJson: text('role_permissions_json'),
  createdAt: ts('created_at').notNull().default(now),
  updatedAt: ts('updated_at').notNull().default(now),
});

// ============================================================
//  SUBSCRIPTIONS (1 active per agency -> plan)
// ============================================================
export const subscriptions = sqliteTable(
  t('subscriptions'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    status: text('status', {
      enum: ['trialing', 'active', 'past_due', 'canceled'],
    })
      .notNull()
      .default('active'),
    currentPeriodStart: ts('current_period_start'),
    currentPeriodEnd: ts('current_period_end'),
    externalCustomerId: text('external_customer_id'),
    externalSubscriptionId: text('external_subscription_id'),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [index('ix_subscriptions_agency').on(tbl.agencyId)],
);

// ============================================================
//  USERS (owner | admin | member)
// ============================================================
export const users = sqliteTable(
  t('users'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name'),
    role: text('role', { enum: ['owner', 'admin', 'member'] })
      .notNull()
      .default('member'),
    // Module-level RBAC overrides: a JSON object of { moduleKey: accessLevel }.
    // NULL means "use role defaults" (full access). See lib/permissions.ts.
    permissionsJson: text('permissions_json'),
    // Optional custom role (named permission preset). When set, the user's
    // `role` column holds the custom role's base tier. See custom_roles.
    customRoleId: text('custom_role_id'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    // ---- HR / profile fields ----
    designation: text('designation'),
    department: text('department'),
    phone: text('phone'),
    hourlyRate: integer('hourly_rate'), // paise, nullable
    weeklyCapacityHrs: integer('weekly_capacity_hrs').notNull().default(40),
    skills: text('skills'), // comma-separated
    lastLoginAt: ts('last_login_at'),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_users_agency_email').on(
      tbl.agencyId,
      sql`lower(${tbl.email})`,
    ),
    index('ix_users_agency').on(tbl.agencyId),
  ],
);

// ============================================================
//  INVITES (pending staff invitations)
// ============================================================
export const invites = sqliteTable(
  t('invites'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ['admin', 'member'] })
      .notNull()
      .default('member'),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: text('invited_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: text('status', {
      enum: ['pending', 'accepted', 'revoked', 'expired'],
    })
      .notNull()
      .default('pending'),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_invites_agency').on(tbl.agencyId),
    index('ix_invites_agency_status').on(tbl.agencyId, tbl.status),
  ],
);

// Single-use, short-lived password-reset tokens (sha256-hashed at rest).
export const passwordResets = sqliteTable(
  t('password_resets'),
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [index('ix_password_resets_user').on(tbl.userId)],
);

// ============================================================
//  CLIENTS (the agency's end clients)
// ============================================================
export const clients = sqliteTable(
  t('clients'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    logoUrl: text('logo_url'),
    brandColor: text('brand_color'),
    handlesJson: text('handles_json'),
    contactEmail: text('contact_email'),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    // ---- Agency-CRM fields ----
    industry: text('industry'),
    website: text('website'),
    phoneCc: text('phone_cc'), // dial code e.g. '+91'
    phone: text('phone'),
    clientSource: text('client_source', {
      enum: [
        'referral',
        'inbound',
        'outbound',
        'social',
        'event',
        'agency_network',
        'other',
      ],
    }),
    gstNumber: text('gst_number'),
    paymentTermsDays: integer('payment_terms_days'),
    billingAddress: text('billing_address'),
    billingState: text('billing_state'),
    billingCity: text('billing_city'),
    billingPincode: text('billing_pincode'),
    relationshipHealth: text('relationship_health', {
      enum: ['excellent', 'good', 'at_risk', 'poor'],
    })
      .notNull()
      .default('good'),
    nextFollowUpAt: ts('next_follow_up_at'),
    internalNotes: text('internal_notes'),
    portalVisibleStatuses: text('portal_visible_statuses')
      .notNull()
      .default('pending_approval,approved,scheduled,posted'),
    // Client-side portal role: 'approver' (Client Admin — can approve/reject
    // content) or 'reviewer' (Client Employee — can view + comment/request
    // changes, but NOT approve). Governs the portal's canApprove capability.
    portalRole: text('portal_role', { enum: ['approver', 'reviewer'] })
      .notNull()
      .default('approver'),
    // Account manager / relationship owner (distinct from task assignment).
    ownerId: text('owner_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_clients_agency').on(tbl.agencyId),
    index('ix_clients_agency_status').on(tbl.agencyId, tbl.status),
    index('ix_clients_agency_owner').on(tbl.agencyId, tbl.ownerId),
    index('ix_clients_agency_followup').on(tbl.agencyId, tbl.nextFollowUpAt),
  ],
);

// ============================================================
//  CLIENT_ASSIGNMENTS (M:N users <-> clients; staff scoping)
// ============================================================
export const clientAssignments = sqliteTable(
  t('client_assignments'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assignedBy: text('assigned_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_assign_client_user').on(tbl.clientId, tbl.userId),
    index('ix_assign_agency_user').on(tbl.agencyId, tbl.userId),
    index('ix_assign_agency_client').on(tbl.agencyId, tbl.clientId),
  ],
);

// ============================================================
//  PORTAL_TOKENS (opaque, hashed, revocable; scoped to ONE client)
// ============================================================
export const portalTokens = sqliteTable(
  t('portal_tokens'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    label: text('label'),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    revoked: integer('revoked', { mode: 'boolean' }).notNull().default(false),
    revokedAt: ts('revoked_at'),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [index('ix_tokens_agency_client').on(tbl.agencyId, tbl.clientId)],
);

// ============================================================
//  AI_GENERATIONS (usage tracking for monthly quota)
//  Declared before content_posts so the FK reference resolves.
// ============================================================
export const aiGenerations = sqliteTable(
  t('ai_generations'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    requestedBy: text('requested_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    period: text('period').notNull(), // 'YYYY-MM'
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] })
      .notNull()
      .default('pending'),
    model: text('model'),
    promptSummary: text('prompt_summary'),
    postsCreated: integer('posts_created').notNull().default(0),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    error: text('error'),
    createdAt: ts('created_at').notNull().default(now),
    completedAt: ts('completed_at'),
  },
  (tbl) => [
    index('ix_ai_agency_period').on(tbl.agencyId, tbl.period, tbl.status),
    index('ix_ai_agency_client').on(tbl.agencyId, tbl.clientId),
  ],
);

// ============================================================
//  CONTENT_POSTS (calendar items)
// ============================================================
export const contentPosts = sqliteTable(
  t('content_posts'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    postType: text('post_type', {
      enum: ['reel', 'story', 'carousel', 'post'],
    }).notNull(),
    caption: text('caption'),
    platformsJson: text('platforms_json').notNull().default('[]'),
    scheduledAt: ts('scheduled_at'),
    status: text('status', {
      enum: [
        'draft',
        'pending_approval',
        'approved',
        'changes_requested',
        'scheduled',
        'posted',
      ],
    })
      .notNull()
      .default('draft'),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    aiGenerationId: text('ai_generation_id').references(
      () => aiGenerations.id,
      { onDelete: 'set null' },
    ),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_posts_agency_client_sched').on(
      tbl.agencyId,
      tbl.clientId,
      tbl.scheduledAt,
    ),
    index('ix_posts_agency_client_status').on(
      tbl.agencyId,
      tbl.clientId,
      tbl.status,
    ),
  ],
);

// ============================================================
//  POST_MEDIA (Cloudinary assets attached to a post)
// ============================================================
export const postMedia = sqliteTable(
  t('post_media'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    postId: text('post_id')
      .notNull()
      .references(() => contentPosts.id, { onDelete: 'cascade' }),
    cloudinaryPublicId: text('cloudinary_public_id').notNull(),
    secureUrl: text('secure_url').notNull(),
    resourceType: text('resource_type', {
      enum: ['image', 'video'],
    }).notNull(),
    format: text('format'),
    bytes: integer('bytes').notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    position: integer('position').notNull().default(0),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_media_agency_post').on(tbl.agencyId, tbl.postId),
    index('ix_media_agency').on(tbl.agencyId),
  ],
);

// ============================================================
//  POST_COMMENTS (agency users OR a client via portal token)
// ============================================================
export const postComments = sqliteTable(
  t('post_comments'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    postId: text('post_id')
      .notNull()
      .references(() => contentPosts.id, { onDelete: 'cascade' }),
    authorType: text('author_type', { enum: ['user', 'client'] }).notNull(),
    authorUserId: text('author_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    portalTokenId: text('portal_token_id').references(() => portalTokens.id, {
      onDelete: 'set null',
    }),
    authorLabel: text('author_label'),
    body: text('body').notNull(),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_comments_agency_post').on(
      tbl.agencyId,
      tbl.postId,
      tbl.createdAt,
    ),
  ],
);

// ============================================================
//  POST_APPROVALS (client decision; attributed to a token)
// ============================================================
export const postApprovals = sqliteTable(
  t('post_approvals'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    postId: text('post_id')
      .notNull()
      .references(() => contentPosts.id, { onDelete: 'cascade' }),
    portalTokenId: text('portal_token_id')
      .notNull()
      .references(() => portalTokens.id, { onDelete: 'restrict' }),
    decision: text('decision', {
      enum: ['approved', 'changes_requested'],
    }).notNull(),
    note: text('note'),
    actorLabel: text('actor_label'),
    ip: text('ip'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_approvals_agency_post').on(
      tbl.agencyId,
      tbl.postId,
      tbl.createdAt,
    ),
  ],
);

// ============================================================
//  BRAND_STRATEGY (per client; feeds AI prompt)
// ============================================================
export const brandStrategy = sqliteTable(
  t('brand_strategy'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .unique()
      .references(() => clients.id, { onDelete: 'cascade' }),
    tone: text('tone'),
    audience: text('audience'),
    pillarsJson: text('pillars_json'),
    dos: text('dos'),
    donts: text('donts'),
    notes: text('notes'),
    updatedBy: text('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [index('ix_strategy_agency').on(tbl.agencyId)],
);

// ============================================================
//  CREDENTIALS_VAULT (CIPHERTEXT ONLY — admin-only access)
// ============================================================
export const credentialsVault = sqliteTable(
  t('credentials_vault'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    username: text('username'),
    ciphertext: blob('ciphertext').notNull(),
    iv: blob('iv').notNull(),
    authTag: blob('auth_tag').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedBy: text('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [index('ix_vault_agency_client').on(tbl.agencyId, tbl.clientId)],
);

// ============================================================
//  USAGE_COUNTERS (rolled-up counters per {agency, period})
// ============================================================
export const usageCounters = sqliteTable(
  t('usage_counters'),
  {
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    period: text('period').notNull(), // 'YYYY-MM'
    aiGenerationsUsed: integer('ai_generations_used').notNull().default(0),
    storageBytesUsed: integer('storage_bytes_used').notNull().default(0),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [uniqueIndex('pk_usage_counters').on(tbl.agencyId, tbl.period)],
);

// ============================================================
//  AUDIT_LOG (append-only; security-relevant events)
// ============================================================
export const auditLog = sqliteTable(
  t('audit_log'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    actorType: text('actor_type', {
      enum: ['owner', 'admin', 'member', 'client_token', 'system'],
    }).notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    metadataJson: text('metadata_json'),
    ip: text('ip'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_audit_agency_created').on(tbl.agencyId, tbl.createdAt),
    index('ix_audit_agency_entity').on(
      tbl.agencyId,
      tbl.entityType,
      tbl.entityId,
    ),
  ],
);

// ============================================================
//  PROJECTS (client engagements / deliverables)
// ============================================================
export const projects = sqliteTable(
  t('projects'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    type: text('type', {
      enum: ['fixed_price', 'retainer', 'hourly', 'milestone_based'],
    })
      .notNull()
      .default('fixed_price'),
    status: text('status', {
      enum: ['planning', 'active', 'on_hold', 'completed', 'cancelled'],
    })
      .notNull()
      .default('planning'),
    health: text('health', {
      enum: ['on_track', 'at_risk', 'off_track'],
    })
      .notNull()
      .default('on_track'),
    contractValue: integer('contract_value').default(0),
    currency: text('currency').notNull().default('INR'),
    startDate: ts('start_date'),
    deadline: ts('deadline'),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_projects_agency').on(tbl.agencyId),
    index('ix_projects_agency_client').on(tbl.agencyId, tbl.clientId),
    index('ix_projects_agency_status').on(tbl.agencyId, tbl.status),
  ],
);

// ============================================================
//  PROJECT_TASKS (kanban items under a project)
// ============================================================
export const projectTasks = sqliteTable(
  t('project_tasks'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Optional link to a milestone in the SAME project. Cleared (set null)
    // if the milestone is deleted so a task is never orphaned to a stale id.
    milestoneId: text('milestone_id').references(
      () => projectMilestones.id,
      { onDelete: 'set null' },
    ),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', {
      enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done'],
    })
      .notNull()
      .default('todo'),
    assigneeId: text('assignee_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    priority: text('priority', {
      enum: ['none', 'low', 'medium', 'high', 'urgent'],
    })
      .notNull()
      .default('none'),
    estimateMinutes: integer('estimate_minutes'), // nullable
    startDate: ts('start_date'), // nullable; pairs with dueDate
    dueDate: ts('due_date'),
    // Stamped when status -> 'done', cleared otherwise.
    completedAt: ts('completed_at'),
    // Self-FK to a parent task (one level only — enforced in the API). The
    // actual FK + cascade is declared in the table callback below.
    parentTaskId: text('parent_task_id'),
    position: integer('position').notNull().default(0),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_tasks_agency_project').on(tbl.agencyId, tbl.projectId),
    index('ix_tasks_agency_project_status').on(
      tbl.agencyId,
      tbl.projectId,
      tbl.status,
    ),
    index('ix_tasks_agency_project_milestone').on(
      tbl.agencyId,
      tbl.projectId,
      tbl.milestoneId,
    ),
    index('ix_tasks_agency_project_parent').on(
      tbl.agencyId,
      tbl.projectId,
      tbl.parentTaskId,
    ),
    index('ix_tasks_agency_project_priority').on(
      tbl.agencyId,
      tbl.projectId,
      tbl.priority,
    ),
    // Self-reference: deleting a parent cascades to its subtasks.
    foreignKey({
      columns: [tbl.parentTaskId],
      foreignColumns: [tbl.id],
      name: 'fk_tasks_parent',
    }).onDelete('cascade'),
  ],
);

// ============================================================
//  TASK_ASSIGNEES (M:N users <-> tasks)
//  Multiple assignees per task. projectTasks.assigneeId mirrors the
//  "primary" (first) assignee for backward compatibility.
// ============================================================
export const taskAssignees = sqliteTable(
  t('task_assignees'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => projectTasks.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_task_assignee').on(tbl.taskId, tbl.userId),
    index('ix_task_assignees_task').on(tbl.taskId),
  ],
);

// ============================================================
//  PROJECT_MILESTONES (dated checkpoints under a project)
// ============================================================
export const projectMilestones = sqliteTable(
  t('project_milestones'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    dueDate: ts('due_date'),
    status: text('status', {
      enum: ['pending', 'completed'],
    })
      .notNull()
      .default('pending'),
    completedAt: ts('completed_at'),
    position: integer('position').notNull().default(0),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_milestones_agency_project').on(tbl.agencyId, tbl.projectId),
  ],
);

// ============================================================
//  PROJECT_MEMBERS (M:N users <-> projects)
// ============================================================
export const projectMembers = sqliteTable(
  t('project_members'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_project_members_project_user').on(
      tbl.projectId,
      tbl.userId,
    ),
    index('ix_project_members_agency_project').on(
      tbl.agencyId,
      tbl.projectId,
    ),
  ],
);

// ============================================================
//  PROJECT_TASK_LABELS (label definitions, project-scoped)
// ============================================================
export const projectTaskLabels = sqliteTable(
  t('project_task_labels'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // pine|brass|sky|rose|amber|violet|slate
    color: text('color').notNull().default('pine'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_task_labels_project_name').on(tbl.projectId, tbl.name),
    index('ix_task_labels_agency_project').on(tbl.agencyId, tbl.projectId),
  ],
);

// ============================================================
//  PROJECT_TASK_LABEL_LINKS (M:N task <-> label)
// ============================================================
export const projectTaskLabelLinks = sqliteTable(
  t('project_task_label_links'),
  {
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => projectTasks.id, { onDelete: 'cascade' }),
    labelId: text('label_id')
      .notNull()
      .references(() => projectTaskLabels.id, { onDelete: 'cascade' }),
  },
  (tbl) => [
    primaryKey({ columns: [tbl.taskId, tbl.labelId] }),
    index('ix_task_label_links_label').on(tbl.labelId),
  ],
);

// ============================================================
//  PROJECT_TASK_DEPENDENCIES (blocks / blocked-by)
//  Canonical direction: blockerTaskId blocks blockedTaskId.
// ============================================================
export const projectTaskDependencies = sqliteTable(
  t('project_task_dependencies'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    blockerTaskId: text('blocker_task_id')
      .notNull()
      .references(() => projectTasks.id, { onDelete: 'cascade' }),
    blockedTaskId: text('blocked_task_id')
      .notNull()
      .references(() => projectTasks.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_task_deps_edge').on(
      tbl.blockerTaskId,
      tbl.blockedTaskId,
    ),
    index('ix_task_deps_blocked').on(tbl.blockedTaskId),
    index('ix_task_deps_agency_project').on(tbl.agencyId, tbl.projectId),
  ],
);

// ============================================================
//  PROJECT_TASK_COMMENTS (task discussion + soft delete)
// ============================================================
export const projectTaskComments = sqliteTable(
  t('project_task_comments'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => projectTasks.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    // JSON array of userIds parsed from @mentions.
    mentionsJson: text('mentions_json'),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
    // Soft delete (author-only).
    deletedAt: ts('deleted_at'),
  },
  (tbl) => [
    index('ix_task_comments_task_created').on(tbl.taskId, tbl.createdAt),
  ],
);

// ============================================================
//  TIME_LOGS (per-user worklog entries; minutes against project/task)
// ============================================================
export const timeLogs = sqliteTable(
  t('time_logs'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    taskId: text('task_id').references(() => projectTasks.id, {
      onDelete: 'set null',
    }),
    minutes: integer('minutes').notNull(),
    workDate: ts('work_date').notNull(),
    note: text('note'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_time_logs_agency_user_date').on(
      tbl.agencyId,
      tbl.userId,
      tbl.workDate,
    ),
  ],
);

// ============================================================
//  TIMERS (a row exists ONLY while a timer is RUNNING; deleted on stop)
//  Exactly ONE running timer per user is enforced in application code.
// ============================================================
export const timers = sqliteTable(
  t('timers'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => projectTasks.id, {
      onDelete: 'set null',
    }),
    startedAt: ts('started_at').notNull(),
    note: text('note'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_timers_agency_user').on(tbl.agencyId, tbl.userId),
    index('ix_timers_agency_project').on(tbl.agencyId, tbl.projectId),
  ],
);

// ============================================================
//  INVOICES (financial documents; money stored as INTEGER PAISE)
//  ₹1 = 100 paise. status: draft|sent|partially_paid|paid|cancelled.
//  'overdue' is DERIVED in the serializer, never stored.
// ============================================================
export const invoices = sqliteTable(
  t('invoices'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    // restrict: financial records must not vanish if a client is removed.
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    invoiceNumber: text('invoice_number'),
    status: text('status', {
      enum: ['draft', 'sent', 'partially_paid', 'paid', 'cancelled'],
    })
      .notNull()
      .default('draft'),
    issueDate: ts('issue_date'),
    dueDate: ts('due_date'),
    isInterstate: integer('is_interstate', { mode: 'boolean' })
      .notNull()
      .default(false),
    currency: text('currency').notNull().default('INR'),
    // ---- All money fields are INTEGER PAISE ----
    subtotal: integer('subtotal').notNull().default(0),
    taxTotal: integer('tax_total').notNull().default(0),
    cgst: integer('cgst').notNull().default(0),
    sgst: integer('sgst').notNull().default(0),
    igst: integer('igst').notNull().default(0),
    total: integer('total').notNull().default(0),
    notes: text('notes'),
    terms: text('terms'),
    bankDetails: text('bank_details'),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_invoices_agency_number').on(
      tbl.agencyId,
      tbl.invoiceNumber,
    ),
    index('ix_invoices_agency').on(tbl.agencyId),
    index('ix_invoices_agency_status').on(tbl.agencyId, tbl.status),
    index('ix_invoices_agency_client').on(tbl.agencyId, tbl.clientId),
    index('ix_invoices_agency_project').on(tbl.agencyId, tbl.projectId),
  ],
);

// ============================================================
//  INVOICE_ITEMS (line items; rate & amount in INTEGER PAISE)
// ============================================================
export const invoiceItems = sqliteTable(
  t('invoice_items'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    quantity: real('quantity').notNull().default(1),
    unit: text('unit').notNull().default('piece'),
    rate: integer('rate').notNull().default(0), // paise
    gstRate: real('gst_rate').notNull().default(18),
    amount: integer('amount').notNull().default(0), // paise = round(quantity*rate)
    position: integer('position').notNull().default(0),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_invoice_items_agency_invoice').on(tbl.agencyId, tbl.invoiceId),
    index('ix_invoice_items_invoice').on(tbl.invoiceId),
  ],
);

// ============================================================
//  INVOICE_PAYMENTS (receipts against an invoice; amount in PAISE)
// ============================================================
export const invoicePayments = sqliteTable(
  t('invoice_payments'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(), // paise
    paidAt: ts('paid_at'),
    method: text('method', {
      enum: ['bank_transfer', 'upi', 'cash', 'card', 'cheque', 'other'],
    })
      .notNull()
      .default('bank_transfer'),
    reference: text('reference'),
    notes: text('notes'),
    recordedBy: text('recorded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_invoice_payments_agency_invoice').on(
      tbl.agencyId,
      tbl.invoiceId,
    ),
    index('ix_invoice_payments_agency_paid').on(tbl.agencyId, tbl.paidAt),
  ],
);

// ============================================================
//  EXPENSES (agency outgoings; amount & gstAmount in PAISE)
// ============================================================
export const expenses = sqliteTable(
  t('expenses'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    clientId: text('client_id').references(() => clients.id, {
      onDelete: 'set null',
    }),
    category: text('category', {
      enum: [
        'software',
        'salaries',
        'marketing',
        'travel',
        'office',
        'equipment',
        'contractor',
        'taxes',
        'utilities',
        'other',
      ],
    })
      .notNull()
      .default('other'),
    amount: integer('amount').notNull(), // paise
    description: text('description'),
    expenseDate: ts('expense_date'),
    receiptUrl: text('receipt_url'),
    gstDeductible: integer('gst_deductible', { mode: 'boolean' })
      .notNull()
      .default(false),
    gstAmount: integer('gst_amount'), // paise, nullable
    loggedBy: text('logged_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_expenses_agency').on(tbl.agencyId),
    index('ix_expenses_agency_category').on(tbl.agencyId, tbl.category),
    index('ix_expenses_agency_date').on(tbl.agencyId, tbl.expenseDate),
    index('ix_expenses_agency_project').on(tbl.agencyId, tbl.projectId),
    index('ix_expenses_agency_client').on(tbl.agencyId, tbl.clientId),
  ],
);

// ============================================================
//  MESSAGE_THREADS (real-time conversations within an agency)
// ============================================================
export const messageThreads = sqliteTable(
  t('message_threads'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    clientId: text('client_id').references(() => clients.id, {
      onDelete: 'set null',
    }),
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    status: text('status', {
      enum: ['open', 'awaiting', 'closed'],
    })
      .notNull()
      .default('open'),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastMessageAt: ts('last_message_at'),
    lastMessagePreview: text('last_message_preview'),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_threads_agency_last_message').on(
      tbl.agencyId,
      tbl.lastMessageAt,
    ),
  ],
);

// ============================================================
//  THREAD_PARTICIPANTS (M:N users <-> threads; read cursors)
// ============================================================
export const threadParticipants = sqliteTable(
  t('thread_participants'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => messageThreads.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastReadAt: ts('last_read_at'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_thread_participants_thread_user').on(
      tbl.threadId,
      tbl.userId,
    ),
  ],
);

// ============================================================
//  MESSAGES (persisted chat; Socket.IO is delivery-only)
// ============================================================
export const messages = sqliteTable(
  t('messages'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => messageThreads.id, { onDelete: 'cascade' }),
    senderId: text('sender_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    // JSON array of { url, type:'image'|'file', name, mime?, bytes? }.
    attachmentsJson: text('attachments_json'),
    createdAt: ts('created_at').notNull().default(now),
    editedAt: ts('edited_at'),
  },
  (tbl) => [index('ix_messages_thread_created').on(tbl.threadId, tbl.createdAt)],
);

// ============================================================
//  DOCUMENTS (file hub — Cloudinary-backed assets + metadata)
// ============================================================
export const documents = sqliteTable(
  t('documents'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category', {
      enum: [
        'contract',
        'nda',
        'proposal',
        'deliverable',
        'invoice',
        'report',
        'design',
        'ai_generated',
        'misc',
      ],
    })
      .notNull()
      .default('misc'),
    clientId: text('client_id').references(() => clients.id, {
      onDelete: 'set null',
    }),
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    fileUrl: text('file_url').notNull(),
    publicId: text('public_id'),
    resourceType: text('resource_type', {
      enum: ['image', 'raw', 'video'],
    })
      .notNull()
      .default('image'),
    format: text('format'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    clientVisible: integer('client_visible', { mode: 'boolean' })
      .notNull()
      .default(false),
    uploadedBy: text('uploaded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [index('ix_documents_agency_created').on(tbl.agencyId, tbl.createdAt)],
);

// ============================================================
//  SHEETS (lightweight spreadsheets; data is a JSON string)
// ============================================================
export const sheets = sqliteTable(
  t('sheets'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('Untitled Sheet'),
    clientId: text('client_id').references(() => clients.id, {
      onDelete: 'set null',
    }),
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    data: text('data').notNull().default('{}'),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [index('ix_sheets_agency_updated').on(tbl.agencyId, tbl.updatedAt)],
);

// ============================================================
//  ATTENDANCE_POLICY (per-agency work schedule + fencing; singleton)
//  workdaysCsv: comma list of weekday numbers 0=Sun..6=Sat.
//  Times are MINUTES from local midnight (in `timezone`).
// ============================================================
export const attendancePolicy = sqliteTable(t('attendance_policy'), {
  agencyId: text('agency_id')
    .primaryKey()
    .references(() => agencies.id, { onDelete: 'cascade' }),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  workdaysCsv: text('workdays_csv').notNull().default('1,2,3,4,5'),
  // Which Saturday occurrences (1..5) are OFF when Saturday is a working day.
  // e.g. "2,4" = 2nd & 4th Saturdays off (the common "even Saturdays" rule).
  saturdayOffWeeksCsv: text('saturday_off_weeks_csv'),
  shiftStartMin: integer('shift_start_min').notNull().default(540), // 09:00
  shiftEndMin: integer('shift_end_min').notNull().default(1080), // 18:00
  fullDayMinutes: integer('full_day_minutes').notNull().default(480), // 8h
  halfDayMinutes: integer('half_day_minutes').notNull().default(240), // 4h
  lateGraceMinutes: integer('late_grace_minutes').notNull().default(15),
  countOvertime: integer('count_overtime', { mode: 'boolean' })
    .notNull()
    .default(true),
  // Optional fencing — restrict where a punch can originate.
  enforceIp: integer('enforce_ip', { mode: 'boolean' }).notNull().default(false),
  allowedIpsCsv: text('allowed_ips_csv'),
  enforceGeo: integer('enforce_geo', { mode: 'boolean' })
    .notNull()
    .default(false),
  geoLat: real('geo_lat'),
  geoLng: real('geo_lng'),
  geoRadiusM: integer('geo_radius_m'),
  updatedAt: ts('updated_at').notNull().default(now),
});

// ============================================================
//  ATTENDANCE_RECORDS (one row per user per day; `day` = 'YYYY-MM-DD')
// ============================================================
export const attendanceRecords = sqliteTable(
  t('attendance_records'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: text('day').notNull(), // local calendar day in the agency timezone
    checkInAt: ts('check_in_at'),
    checkOutAt: ts('check_out_at'),
    workedMinutes: integer('worked_minutes').notNull().default(0),
    overtimeMinutes: integer('overtime_minutes').notNull().default(0),
    status: text('status', {
      enum: [
        'present',
        'late',
        'half_day',
        'absent',
        'on_leave',
        'holiday',
        'weekly_off',
      ],
    })
      .notNull()
      .default('present'),
    isLate: integer('is_late', { mode: 'boolean' }).notNull().default(false),
    source: text('source', {
      enum: ['self', 'admin', 'regularized', 'system'],
    })
      .notNull()
      .default('self'),
    note: text('note'),
    checkInIp: text('check_in_ip'),
    checkInLat: real('check_in_lat'),
    checkInLng: real('check_in_lng'),
    // Human-readable area for the check-in (reverse-geocoded from the coords).
    checkInLocation: text('check_in_location'),
    // Check-out location capture (mirrors the check-in fields).
    checkOutIp: text('check_out_ip'),
    checkOutLat: real('check_out_lat'),
    checkOutLng: real('check_out_lng'),
    checkOutLocation: text('check_out_location'),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_attendance_user_day').on(tbl.userId, tbl.day),
    index('ix_attendance_agency_day').on(tbl.agencyId, tbl.day),
    index('ix_attendance_agency_user_day').on(
      tbl.agencyId,
      tbl.userId,
      tbl.day,
    ),
  ],
);

// ============================================================
//  HOLIDAYS (agency-wide; `day` = 'YYYY-MM-DD'). Applied to all members.
// ============================================================
export const holidays = sqliteTable(
  t('holidays'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    name: text('name').notNull(),
    recurring: integer('recurring', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_holidays_agency_day').on(tbl.agencyId, tbl.day),
    index('ix_holidays_agency').on(tbl.agencyId),
  ],
);

// ============================================================
//  LEAVE_TYPES (per-agency catalog: casual/sick/earned/unpaid…)
// ============================================================
export const leaveTypes = sqliteTable(
  t('leave_types'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    colorToken: text('color_token').notNull().default('pine'),
    paid: integer('paid', { mode: 'boolean' }).notNull().default(true),
    annualQuota: integer('annual_quota').notNull().default(0), // days/year, 0=unlimited
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_leave_types_agency_name').on(tbl.agencyId, tbl.name),
    index('ix_leave_types_agency').on(tbl.agencyId),
  ],
);

// ============================================================
//  LEAVE_REQUESTS (apply -> approve/reject workflow)
// ============================================================
export const leaveRequests = sqliteTable(
  t('leave_requests'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    leaveTypeId: text('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id, { onDelete: 'restrict' }),
    startDay: text('start_day').notNull(), // YYYY-MM-DD
    endDay: text('end_day').notNull(),
    halfDayStart: integer('half_day_start', { mode: 'boolean' })
      .notNull()
      .default(false),
    halfDayEnd: integer('half_day_end', { mode: 'boolean' })
      .notNull()
      .default(false),
    days: real('days').notNull().default(0), // computed working-day count
    reason: text('reason'),
    status: text('status', {
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    decidedBy: text('decided_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_leave_req_agency_status').on(tbl.agencyId, tbl.status),
    index('ix_leave_req_agency_user').on(tbl.agencyId, tbl.userId),
  ],
);

// ============================================================
//  ATTENDANCE_REGULARIZATIONS (fix a day: late/short/half/missed punch)
// ============================================================
export const attendanceRegularizations = sqliteTable(
  t('attendance_regularizations'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    type: text('type', {
      enum: [
        'missed_punch',
        'late',
        'short_hours',
        'half_day',
        'wrong_status',
      ],
    }).notNull(),
    requestedCheckInAt: ts('requested_check_in_at'),
    requestedCheckOutAt: ts('requested_check_out_at'),
    requestedStatus: text('requested_status', {
      enum: ['present', 'half_day', 'on_leave'],
    }),
    reason: text('reason').notNull(),
    status: text('status', {
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    decidedBy: text('decided_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_regular_agency_status').on(tbl.agencyId, tbl.status),
    index('ix_regular_agency_user').on(tbl.agencyId, tbl.userId),
  ],
);

// ============================================================
//  NOTIFICATIONS (in-app alerts; realtime over Socket.IO)
// ============================================================
export const notifications = sqliteTable(
  t('notifications'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // e.g. 'leave.requested', 'leave.approved'
    title: text('title').notNull(),
    body: text('body'),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    link: text('link'),
    readAt: ts('read_at'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_notifications_user_created').on(tbl.userId, tbl.createdAt),
    index('ix_notifications_user_unread').on(tbl.userId, tbl.readAt),
  ],
);

// ============================================================
//  CLIENT_CONTACTS (multiple people per client)
// ============================================================
export const clientContacts = sqliteTable(
  t('client_contacts'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role'), // job title / relationship (e.g. 'Founder', 'Finance')
    email: text('email'),
    phone: text('phone'),
    isPrimary: integer('is_primary', { mode: 'boolean' })
      .notNull()
      .default(false),
    isBilling: integer('is_billing', { mode: 'boolean' })
      .notNull()
      .default(false),
    notes: text('notes'),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [index('ix_client_contacts_agency_client').on(tbl.agencyId, tbl.clientId)],
);

// ============================================================
//  CLIENT_NOTES (activity timeline: notes / calls / meetings / emails)
// ============================================================
export const clientNotes = sqliteTable(
  t('client_notes'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    type: text('type', {
      enum: ['note', 'call', 'meeting', 'email', 'task'],
    })
      .notNull()
      .default('note'),
    body: text('body').notNull(),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    // For 'task' entries: a due date + completion stamp (drives follow-ups).
    dueAt: ts('due_at'),
    completedAt: ts('completed_at'),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_client_notes_agency_client_created').on(
      tbl.agencyId,
      tbl.clientId,
      tbl.createdAt,
    ),
  ],
);

// ============================================================
//  DEALS (sales pipeline / opportunities per client)
//  valuePaise: INTEGER PAISE (₹1 = 100 paise).
// ============================================================
export const deals = sqliteTable(
  t('deals'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    stage: text('stage', {
      enum: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
    })
      .notNull()
      .default('lead'),
    valuePaise: integer('value_paise').notNull().default(0),
    currency: text('currency').notNull().default('INR'),
    probability: integer('probability').notNull().default(0), // 0..100
    expectedCloseAt: ts('expected_close_at'),
    ownerId: text('owner_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lostReason: text('lost_reason'),
    notes: text('notes'),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    closedAt: ts('closed_at'),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_deals_agency_stage').on(tbl.agencyId, tbl.stage),
    index('ix_deals_agency_client').on(tbl.agencyId, tbl.clientId),
  ],
);

// ============================================================
//  CLIENT_TAGS + CLIENT_TAG_LINKS (M:N segmentation)
// ============================================================
export const clientTags = sqliteTable(
  t('client_tags'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    colorToken: text('color_token').notNull().default('pine'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (tbl) => [uniqueIndex('ux_client_tags_agency_name').on(tbl.agencyId, tbl.name)],
);

export const clientTagLinks = sqliteTable(
  t('client_tag_links'),
  {
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => clientTags.id, { onDelete: 'cascade' }),
  },
  (tbl) => [
    primaryKey({ columns: [tbl.clientId, tbl.tagId] }),
    index('ix_client_tag_links_tag').on(tbl.tagId),
    index('ix_client_tag_links_agency_client').on(tbl.agencyId, tbl.clientId),
  ],
);

// ============================================================
//  CUSTOM_ROLES (named permission presets per agency)
//  baseRole = the privilege tier the role inherits (admin|member).
//  permissionsJson = module->level overrides layered above the base tier.
// ============================================================
export const customRoles = sqliteTable(
  t('custom_roles'),
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    colorToken: text('color_token').notNull().default('pine'),
    baseRole: text('base_role', { enum: ['admin', 'member'] })
      .notNull()
      .default('member'),
    permissionsJson: text('permissions_json'),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    uniqueIndex('ux_custom_roles_agency_name').on(tbl.agencyId, tbl.name),
    index('ix_custom_roles_agency').on(tbl.agencyId),
  ],
);

// ---- Inferred row types (handy across the app) ----
export type Agency = typeof agencies.$inferSelect;
export type User = typeof users.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type ContentPost = typeof contentPosts.$inferSelect;
export type PostMedia = typeof postMedia.$inferSelect;
export type PortalToken = typeof portalTokens.$inferSelect;
export type AiGeneration = typeof aiGenerations.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectTask = typeof projectTasks.$inferSelect;
export type ProjectMilestone = typeof projectMilestones.$inferSelect;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type TimeLog = typeof timeLogs.$inferSelect;
export type Timer = typeof timers.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type InvoicePayment = typeof invoicePayments.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type MessageThread = typeof messageThreads.$inferSelect;
export type ThreadParticipant = typeof threadParticipants.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type Sheet = typeof sheets.$inferSelect;
export type AttendancePolicy = typeof attendancePolicy.$inferSelect;
export type AttendanceRecord = typeof attendanceRecords.$inferSelect;
export type Holiday = typeof holidays.$inferSelect;
export type LeaveType = typeof leaveTypes.$inferSelect;
export type LeaveRequest = typeof leaveRequests.$inferSelect;
export type AttendanceRegularization =
  typeof attendanceRegularizations.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type ClientContact = typeof clientContacts.$inferSelect;
export type ClientNote = typeof clientNotes.$inferSelect;
export type Deal = typeof deals.$inferSelect;
export type ClientTag = typeof clientTags.$inferSelect;
export type CustomRole = typeof customRoles.$inferSelect;
