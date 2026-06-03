import {
  sqliteTable,
  text,
  integer,
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

// ---- Inferred row types (handy across the app) ----
export type Agency = typeof agencies.$inferSelect;
export type User = typeof users.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type ContentPost = typeof contentPosts.$inferSelect;
export type PostMedia = typeof postMedia.$inferSelect;
export type PortalToken = typeof portalTokens.$inferSelect;
export type AiGeneration = typeof aiGenerations.$inferSelect;
export type Plan = typeof plans.$inferSelect;
