/**
 * Publishes content posts to a client's connected Instagram / Facebook Page.
 *
 * One post_publications row per (post, account) makes this idempotent: a post
 * is never sent twice to the same account, even if its status is flipped back
 * (e.g. a reopened task moving it posted → scheduled). Instagram videos process
 * asynchronously, so a reel can sit in `processing` across job runs.
 */
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  contentPosts,
  postMedia,
  postPublications,
  socialAccounts,
} from '../db/schema.js';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import { broadcastPortalRefresh } from '../realtime/io.js';
import { unsealString } from './vault.js';
import {
  MetaApiError,
  fbPublish,
  igContainerStatus,
  igCreateContainer,
  igPublishContainer,
  metaConfigured,
  type PublishInput,
  type Published,
} from './meta.js';
import { notifyPermissionHolders } from './notifications.js';
import { isAgencyStorageKey } from './storage.js';
import { audit } from './audit.js';
import { actorAuditId, systemActor } from '../authz/actor.js';
import { can } from '../authz/engine.js';
import { postApprovalIsValid } from '../authz/policies/posts.js';

/** Explicit, minimal grant of the auto-publish job (design §I.4). */
export const AUTO_PUBLISH_GRANTS = [{ permission: 'posts.publish', scope: 'organization' as const }];

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp|avi)(?:[?#]|$)/i;
/** Automatic retries per (post, account); "Publish now" ignores the cap. */
const MAX_AUTO_ATTEMPTS = 3;
/** Posts due longer ago than this are left alone, so enabling publishing never floods a backlog. */
const LOOKBACK_MS = 24 * 3_600_000;

export const socialPublishEnabled = (): boolean =>
  env.SOCIAL_PUBLISH_ENABLED && metaConfigured();

export interface PublishOptions {
  /** Manual "Publish now": ignores the per-account auto-publish switch and the retry cap. */
  manual?: boolean;
  /** How long to wait for an Instagram video to finish processing before leaving it for the next run. */
  maxWaitMs?: number;
  pollMs?: number;
}

export interface PublicationResult {
  accountId: string;
  platform: 'instagram' | 'facebook';
  status: 'published' | 'processing' | 'failed' | 'skipped';
  permalink?: string | null;
  error?: string | null;
}

type Post = typeof contentPosts.$inferSelect;
type Account = typeof socialAccounts.$inferSelect;
type Publication = typeof postPublications.$inferSelect;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function platformsOf(json: string): Set<string> {
  try {
    const a = JSON.parse(json);
    return new Set(Array.isArray(a) ? a.map((p) => String(p).trim().toLowerCase()) : []);
  } catch {
    return new Set();
  }
}

async function setPublication(id: string, patch: Partial<typeof postPublications.$inferInsert>) {
  await db
    .update(postPublications)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(postPublications.id, id));
}

async function publishToAccount(
  post: Post,
  acct: Account,
  input: PublishInput,
  prev: Publication | null,
  wait: { maxWaitMs: number; pollMs: number },
): Promise<PublicationResult> {
  const base = { accountId: acct.id, platform: acct.platform };
  const pubId = prev?.id ?? newId('pub');
  const attempts = (prev?.attempts ?? 0) + 1;

  if (prev) {
    await setPublication(pubId, { status: 'publishing', attempts, error: null });
  } else {
    try {
      await db.insert(postPublications).values({
        id: pubId,
        agencyId: post.agencyId,
        clientId: post.clientId,
        postId: post.id,
        socialAccountId: acct.id,
        platform: acct.platform,
        status: 'publishing',
        attempts,
      });
    } catch {
      // Unique (post, account) — another run got here first.
      return { ...base, status: 'processing' };
    }
  }

  try {
    const token = unsealString(acct.accessTokenEnc);
    let published: Published;

    if (acct.platform === 'instagram') {
      let containerId = prev?.containerId ?? null;
      if (!containerId) {
        containerId = await igCreateContainer(acct.externalId, token, input);
        await setPublication(pubId, { containerId });
      }
      if (input.media.some((m) => m.video)) {
        const deadline = Date.now() + wait.maxWaitMs;
        for (;;) {
          const st = await igContainerStatus(containerId, token);
          if (st.code === 'FINISHED') break;
          if (st.code === 'ERROR' || st.code === 'EXPIRED') {
            throw new MetaApiError(
              `Instagram couldn't process the video${st.message ? ` (${st.message})` : ''}. ` +
                'Use an MP4 (H.264), 9:16, under 15 minutes.',
              400,
            );
          }
          if (Date.now() >= deadline) {
            await setPublication(pubId, { status: 'processing' });
            return { ...base, status: 'processing' };
          }
          await sleep(wait.pollMs);
        }
      }
      published = await igPublishContainer(acct.externalId, containerId, token);
    } else {
      published = await fbPublish(acct.externalId, token, input);
    }

    await setPublication(pubId, {
      status: 'published',
      externalPostId: published.id,
      permalink: published.permalink,
      error: null,
      publishedAt: new Date(),
    });
    return { ...base, status: 'published', permalink: published.permalink };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : 'Publishing failed.').slice(0, 500);
    // Drop the container: an ERROR/EXPIRED one can't be retried, so the next
    // attempt starts fresh.
    await setPublication(pubId, { status: 'failed', error: msg, containerId: null });
    if (e instanceof MetaApiError && e.isAuthError) {
      await db
        .update(socialAccounts)
        .set({ status: 'expired', lastError: msg, updatedAt: new Date() })
        .where(eq(socialAccounts.id, acct.id));
    }
    return { ...base, status: 'failed', error: msg };
  }
}

/**
 * Publish one post to every active account of its client whose platform the
 * post targets. Marks the post `posted` once every target is live.
 */
export async function publishPost(
  agencyId: string,
  postId: string,
  opts: PublishOptions = {},
): Promise<PublicationResult[]> {
  const wait = { maxWaitMs: opts.maxWaitMs ?? 45_000, pollMs: opts.pollMs ?? 5_000 };
  const [post] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, postId), eq(contentPosts.agencyId, agencyId)))
    .limit(1);
  if (!post) return [];
  // Defence in depth: whoever calls this, only client-approved content goes out.
  // (A `posted` post may be retried for accounts that failed.)
  if (
    !['approved', 'scheduled', 'posted'].includes(post.status) ||
    post.archivedAt ||
    !(await postApprovalIsValid(agencyId, post))
  ) {
    return [];
  }

  const platforms = platformsOf(post.platformsJson);
  const accounts = await db
    .select()
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.agencyId, agencyId),
        eq(socialAccounts.clientId, post.clientId),
        eq(socialAccounts.status, 'active'),
      ),
    );
  const targets = accounts.filter(
    (a) => platforms.has(a.platform) && (opts.manual || a.autoPublish),
  );
  if (!targets.length) return [];

  const mediaRows = await db
    .select()
    .from(postMedia)
    .where(
      and(
        eq(postMedia.agencyId, agencyId),
        eq(postMedia.postId, post.id),
        eq(postMedia.archived, false),
      ),
    )
    .orderBy(asc(postMedia.position), asc(postMedia.createdAt));
  const input: PublishInput = {
    postType: post.postType,
    caption: post.caption ?? '',
    // Only assets stored under this agency's prefix are handed to Meta.
    media: mediaRows.filter((m) => isAgencyStorageKey(agencyId, m.cloudinaryPublicId)).map((m) => ({
      url: m.secureUrl,
      video: m.resourceType === 'video' || VIDEO_EXT.test(m.secureUrl),
    })),
  };

  const existing = await db
    .select()
    .from(postPublications)
    .where(and(eq(postPublications.agencyId, agencyId), eq(postPublications.postId, post.id)));
  const byAccount = new Map(existing.map((p) => [p.socialAccountId, p]));

  const results: PublicationResult[] = [];
  const freshFailures: PublicationResult[] = [];
  for (const acct of targets) {
    const base = { accountId: acct.id, platform: acct.platform };
    const prev = byAccount.get(acct.id) ?? null;
    if (prev?.status === 'published') {
      results.push({ ...base, status: 'published', permalink: prev.permalink });
      continue;
    }
    if (acct.platform === 'facebook' && post.postType === 'story') {
      results.push({ ...base, status: 'skipped', error: 'Stories publish to Instagram only.' });
      continue;
    }
    if (prev?.status === 'failed' && !opts.manual && prev.attempts >= MAX_AUTO_ATTEMPTS) {
      results.push({ ...base, status: 'failed', error: prev.error });
      continue;
    }
    const r = await publishToAccount(post, acct, input, prev, wait);
    results.push(r);
    if (r.status === 'failed') freshFailures.push(r);
  }

  const live = results.filter((r) => r.status !== 'skipped');
  if (live.length && live.every((r) => r.status === 'published') && post.status !== 'posted') {
    await db
      .update(contentPosts)
      .set({ status: 'posted', updatedAt: new Date() })
      .where(and(eq(contentPosts.id, post.id), eq(contentPosts.agencyId, agencyId)));
  }
  if (results.some((r) => r.status === 'published')) broadcastPortalRefresh(post.clientId);

  // Automatic runs have no one watching — tell the people who can publish.
  if (!opts.manual && freshFailures.length) {
    const where = freshFailures.map((f) => (f.platform === 'instagram' ? 'Instagram' : 'Facebook'));
    await notifyPermissionHolders(agencyId, 'posts.publish', {
      agencyId,
      type: 'social.publish_failed',
      title: `Couldn't publish to ${[...new Set(where)].join(' & ')}`,
      body: freshFailures[0].error ?? null,
      entityType: 'post',
      entityId: post.id,
      link: `/clients/${post.clientId}/calendar?post=${post.id}`,
    });
  }
  return results;
}

let running = false;

/**
 * Scheduler entry: publish approved/scheduled posts that came due in the last
 * 24h, and finish Instagram videos still processing from a previous run.
 *
 * Runs per agency as `systemActor('social-auto-publish', agencyId,
 * ['posts.publish'])`; a post is only published when its client approval is
 * still valid (postApprovalIsValid). Each attempt is audited with
 * actorType 'system'.
 */
export async function runDuePublishing(
  now = new Date(),
  opts: PublishOptions = {},
): Promise<{ posts: number; published: number; failed: number; processing: number }> {
  const tally = { posts: 0, published: 0, failed: 0, processing: 0 };
  if (running) return tally; // a slow video wait can outlast the 5-min interval
  running = true;
  try {
    const due = await db
      .select({ id: contentPosts.id, agencyId: contentPosts.agencyId, clientId: contentPosts.clientId })
      .from(contentPosts)
      .where(
        and(
          inArray(contentPosts.status, ['approved', 'scheduled']),
          lte(contentPosts.scheduledAt, now),
          gte(contentPosts.scheduledAt, new Date(now.getTime() - LOOKBACK_MS)),
          isNull(contentPosts.archivedAt),
        ),
      );
    const processing = await db
      .select({
        id: postPublications.postId,
        agencyId: postPublications.agencyId,
        clientId: postPublications.clientId,
      })
      .from(postPublications)
      .where(eq(postPublications.status, 'processing'));

    const candidates = [...processing, ...due];
    const clientIds = [...new Set(candidates.map((p) => p.clientId))];
    if (!clientIds.length) return tally;
    const withAccounts = new Set(
      (
        await db
          .select({ clientId: socialAccounts.clientId })
          .from(socialAccounts)
          .where(
            and(
              inArray(socialAccounts.clientId, clientIds),
              eq(socialAccounts.status, 'active'),
              eq(socialAccounts.autoPublish, true),
            ),
          )
      ).map((r) => r.clientId),
    );

    const seen = new Set<string>();
    for (const p of candidates) {
      if (seen.has(p.id) || !withAccounts.has(p.clientId)) continue;
      seen.add(p.id);
      const actor = systemActor('social-auto-publish', p.agencyId, AUTO_PUBLISH_GRANTS);
      if (!can(actor, 'posts.publish')) continue;
      tally.posts++;
      try {
        const results = await publishPost(actor.agencyId, p.id, opts);
        for (const r of results) {
          if (r.status === 'published') tally.published++;
          else if (r.status === 'failed') tally.failed++;
          else if (r.status === 'processing') tally.processing++;
        }
        if (results.length) {
          await audit({
            agencyId: actor.agencyId,
            actorType: 'system',
            actorId: actorAuditId(actor),
            action: 'social.auto_publish',
            entityType: 'post',
            entityId: p.id,
            metadata: { results: results.map((r) => `${r.platform}:${r.status}`) },
          });
        }
      } catch (e) {
        tally.failed++;
        console.error(`[social] publishing post ${p.id} failed`, e);
      }
    }
    return tally;
  } finally {
    running = false;
  }
}
