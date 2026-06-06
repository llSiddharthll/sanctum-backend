import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  uniqueIndex,
  index,
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
  status: text('status', { enum: ['active', 'suspended', 'deleted'] })
    .notNull()
    .default('active'),
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
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (tbl) => [
    index('ix_clients_agency').on(tbl.agencyId),
    index('ix_clients_agency_status').on(tbl.agencyId, tbl.status),
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
    dueDate: ts('due_date'),
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
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type InvoicePayment = typeof invoicePayments.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type MessageThread = typeof messageThreads.$inferSelect;
export type ThreadParticipant = typeof threadParticipants.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type Sheet = typeof sheets.$inferSelect;
