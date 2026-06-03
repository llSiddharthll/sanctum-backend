/**
 * Sanctum demo seed.
 *
 * Populates the dedicated, already-migrated Turso "sanctum" database (tables
 * prefixed `sanctum_`) with a coherent demo dataset so the founder can log in
 * and immediately see a populated dashboard, calendar, clients, and a working
 * client portal.
 *
 * - Uses the project's OWN db client + drizzle schema + id/password/vault helpers.
 * - Idempotent: deletes existing rows from every seeded table in FK-safe order,
 *   then re-inserts. Safe to re-run.
 * - Prints the raw portal tokens + share URLs and per-table row counts.
 *
 * Run:  npx --no-install tsc -p tsconfig.json  &&  node dist/seed.js
 */

import { libsql, db, ensurePragmas, schema } from './db/client.js';
import { newId, newOpaqueToken } from './lib/ids.js';
import { hashPassword } from './lib/password.js';
import { encryptSecret } from './services/vault.js';

const {
  plans,
  agencies,
  subscriptions,
  users,
  clients,
  clientAssignments,
  portalTokens,
  aiGenerations,
  contentPosts,
  postMedia,
  postComments,
  postApprovals,
  brandStrategy,
  credentialsVault,
  usageCounters,
  auditLog,
  invites,
} = schema;

const GB = 1024 * 1024 * 1024;

/** Helper: a fixed instant in June 2026 for a given day/hour (UTC). */
function jun(day: number, hour = 10, minute = 0): Date {
  return new Date(Date.UTC(2026, 5, day, hour, minute, 0));
}

async function main(): Promise<void> {
  await ensurePragmas();

  // -----------------------------------------------------------------
  // 1. CLEAN — delete in FK-safe (child -> parent) order. Idempotent.
  // -----------------------------------------------------------------
  console.log('Cleaning existing demo rows (FK-safe order)...');
  // Leaf / dependent tables first.
  await db.delete(postApprovals);
  await db.delete(postComments);
  await db.delete(postMedia);
  await db.delete(contentPosts);
  await db.delete(aiGenerations);
  await db.delete(credentialsVault);
  await db.delete(brandStrategy);
  await db.delete(portalTokens);
  await db.delete(clientAssignments);
  await db.delete(invites);
  await db.delete(usageCounters);
  await db.delete(auditLog);
  await db.delete(clients);
  await db.delete(subscriptions);
  await db.delete(users);
  await db.delete(agencies);
  await db.delete(plans);

  // -----------------------------------------------------------------
  // 2. PLANS (shared catalog)
  // -----------------------------------------------------------------
  console.log('Seeding plans...');
  await db.insert(plans).values([
    {
      id: 'studio',
      name: 'Studio',
      maxClients: 4,
      maxTeamMembers: 5,
      maxAiGenerations: 5,
      maxStorageBytes: 5 * GB,
      priceCentsMonthly: 4900,
      isActive: true,
      sortOrder: 1,
    },
    {
      id: 'agency',
      name: 'Agency',
      maxClients: 10,
      maxTeamMembers: 15,
      maxAiGenerations: 30,
      maxStorageBytes: 15 * GB,
      priceCentsMonthly: 9900,
      isActive: true,
      sortOrder: 2,
    },
    {
      id: 'partner',
      name: 'Partner',
      maxClients: 25,
      maxTeamMembers: 30,
      maxAiGenerations: 60,
      maxStorageBytes: 40 * GB,
      priceCentsMonthly: 19900,
      isActive: true,
      sortOrder: 3,
    },
    {
      id: 'empire',
      name: 'Empire',
      maxClients: 50,
      maxTeamMembers: 50,
      maxAiGenerations: 100,
      maxStorageBytes: 100 * GB,
      priceCentsMonthly: 39900,
      isActive: true,
      sortOrder: 4,
    },
  ]);

  // -----------------------------------------------------------------
  // 3. AGENCY — Sanctum Studio
  // -----------------------------------------------------------------
  console.log('Seeding agency...');
  const agencyId = newId('agc');
  await db.insert(agencies).values({
    id: agencyId,
    name: 'Sanctum Studio',
    slug: 'sanctum-studio',
    logoUrl:
      'https://res.cloudinary.com/dkqo3uz5o/image/upload/v1/demo/sanctum-studio-logo.png',
    brandColor: '#6D28D9',
    status: 'active',
  });

  // -----------------------------------------------------------------
  // 4. SUBSCRIPTION — Sanctum Studio on the Agency plan, active
  // -----------------------------------------------------------------
  console.log('Seeding subscription...');
  await db.insert(subscriptions).values({
    id: newId('sub'),
    agencyId,
    planId: 'agency',
    status: 'active',
    currentPeriodStart: jun(1, 0, 0),
    currentPeriodEnd: new Date(Date.UTC(2026, 6, 1, 0, 0, 0)),
    externalCustomerId: 'cus_demo_sanctum',
    externalSubscriptionId: 'sub_demo_sanctum',
  });

  // -----------------------------------------------------------------
  // 5. USERS — owner (Siddharth) + member (Aanya); password "Sanctum@123"
  // -----------------------------------------------------------------
  console.log('Seeding users (hashing passwords with argon2)...');
  const passwordHash = await hashPassword('Sanctum@123');

  const ownerId = newId('usr');
  const memberId = newId('usr');
  await db.insert(users).values([
    {
      id: ownerId,
      agencyId,
      email: 'owner@sanctum.studio',
      passwordHash,
      fullName: 'Siddharth',
      role: 'owner',
      status: 'active',
      lastLoginAt: jun(2, 9, 15),
    },
    {
      id: memberId,
      agencyId,
      email: 'aanya@sanctum.studio',
      passwordHash,
      fullName: 'Aanya',
      role: 'member',
      status: 'active',
      lastLoginAt: jun(2, 11, 40),
    },
  ]);

  // -----------------------------------------------------------------
  // 6. CLIENTS (5) — sector, brand colors, social handles
  // -----------------------------------------------------------------
  console.log('Seeding clients...');
  type ClientSeed = {
    key: string;
    name: string;
    sector: string;
    brandColor: string;
    contactEmail: string;
    handles: Record<string, string>;
  };
  const clientSeeds: ClientSeed[] = [
    {
      key: 'bloom',
      name: 'Bloom Digital',
      sector: 'beauty/skincare',
      brandColor: '#EC4899',
      contactEmail: 'hello@bloomdigital.co',
      handles: {
        instagram: '@bloom.digital',
        facebook: 'BloomDigitalSkincare',
        youtube: '@bloomdigital',
      },
    },
    {
      key: 'aurora',
      name: 'Aurora Cafe',
      sector: 'food',
      brandColor: '#F59E0B',
      contactEmail: 'manager@auroracafe.com',
      handles: {
        instagram: '@aurora.cafe',
        facebook: 'AuroraCafeHouse',
        x: '@auroracafe',
      },
    },
    {
      key: 'novafit',
      name: 'NovaFit',
      sector: 'fitness',
      brandColor: '#10B981',
      contactEmail: 'team@novafit.app',
      handles: {
        instagram: '@novafit',
        youtube: '@novafit.training',
        linkedin: 'novafit',
      },
    },
    {
      key: 'lumen',
      name: 'Lumen Realty',
      sector: 'real estate',
      brandColor: '#0EA5E9',
      contactEmail: 'contact@lumenrealty.com',
      handles: {
        instagram: '@lumen.realty',
        linkedin: 'lumen-realty',
        facebook: 'LumenRealtyGroup',
      },
    },
    {
      key: 'saffron',
      name: 'Saffron Kitchen',
      sector: 'restaurant',
      brandColor: '#DC2626',
      contactEmail: 'reservations@saffronkitchen.in',
      handles: {
        instagram: '@saffron.kitchen',
        facebook: 'SaffronKitchenIndian',
        x: '@saffronkitchen',
      },
    },
  ];

  const clientIds: Record<string, string> = {};
  for (const c of clientSeeds) {
    const id = newId('cli');
    clientIds[c.key] = id;
    await db.insert(clients).values({
      id,
      agencyId,
      name: c.name,
      logoUrl: `https://res.cloudinary.com/dkqo3uz5o/image/upload/v1/demo/${c.key}-logo.png`,
      brandColor: c.brandColor,
      handlesJson: JSON.stringify({ ...c.handles, sector: c.sector }),
      contactEmail: c.contactEmail,
      status: 'active',
      // keep schema default for portalVisibleStatuses
    });
  }

  // -----------------------------------------------------------------
  // 7. CLIENT_ASSIGNMENTS — assign Aanya (member) to 2 clients
  // -----------------------------------------------------------------
  console.log('Seeding client assignments...');
  await db.insert(clientAssignments).values([
    {
      id: newId('asg'),
      agencyId,
      clientId: clientIds.bloom,
      userId: memberId,
      assignedBy: ownerId,
    },
    {
      id: newId('asg'),
      agencyId,
      clientId: clientIds.aurora,
      userId: memberId,
      assignedBy: ownerId,
    },
  ]);

  // -----------------------------------------------------------------
  // 8. CONTENT_POSTS — ~10 posts each for Bloom + Aurora across June 2026
  // -----------------------------------------------------------------
  console.log('Seeding content posts...');
  type PostType = 'reel' | 'story' | 'carousel' | 'post';
  type Status =
    | 'draft'
    | 'pending_approval'
    | 'approved'
    | 'changes_requested'
    | 'scheduled'
    | 'posted';

  type PostSeed = {
    clientKey: string;
    type: PostType;
    caption: string;
    platforms: string[];
    day: number;
    status: Status;
    createdBy: string;
  };

  const postSeeds: PostSeed[] = [
    // ---- Bloom Digital (beauty/skincare) ----
    {
      clientKey: 'bloom',
      type: 'carousel',
      caption:
        '5 ingredients your moisturizer should never have. Swipe to glow-proof your shelf. #SkincareScience',
      platforms: ['instagram', 'facebook'],
      day: 2,
      status: 'posted',
      createdBy: memberId,
    },
    {
      clientKey: 'bloom',
      type: 'reel',
      caption:
        'POV: your 60-second morning routine that actually sticks. Cleanse, vitamin C, SPF. Done. ☀️',
      platforms: ['instagram'],
      day: 4,
      status: 'posted',
      createdBy: memberId,
    },
    {
      clientKey: 'bloom',
      type: 'post',
      caption:
        'Hyaluronic acid 101: it hydrates, it plumps, it loves you back. Save this for later. 💧',
      platforms: ['instagram', 'facebook'],
      day: 6,
      status: 'scheduled',
      createdBy: memberId,
    },
    {
      clientKey: 'bloom',
      type: 'story',
      caption: 'Flash poll: oily, dry, or combination? Tap to tell us. 👀',
      platforms: ['instagram'],
      day: 8,
      status: 'scheduled',
      createdBy: memberId,
    },
    {
      clientKey: 'bloom',
      type: 'carousel',
      caption:
        'Before / after: 4 weeks of consistent niacinamide. Real client, real glow. ✨',
      platforms: ['instagram', 'facebook', 'youtube'],
      day: 11,
      status: 'approved',
      createdBy: memberId,
    },
    {
      clientKey: 'bloom',
      type: 'reel',
      caption:
        'Dermatologist-approved: how much SPF you ACTUALLY need (it is more than you think).',
      platforms: ['instagram', 'youtube'],
      day: 13,
      status: 'approved',
      createdBy: ownerId,
    },
    {
      clientKey: 'bloom',
      type: 'post',
      caption:
        'New drop: the Midnight Repair Serum is back in stock. Limited batch — link in bio. 🌙',
      platforms: ['instagram', 'facebook'],
      day: 16,
      status: 'pending_approval',
      createdBy: memberId,
    },
    {
      clientKey: 'bloom',
      type: 'carousel',
      caption:
        'Myth vs fact: does drinking water clear your skin? Let us settle this. 🧪',
      platforms: ['instagram'],
      day: 18,
      status: 'pending_approval',
      createdBy: memberId,
    },
    {
      clientKey: 'bloom',
      type: 'reel',
      caption:
        'Unboxing the summer glow kit — 3 products, 1 routine, zero stickiness.',
      platforms: ['instagram', 'youtube'],
      day: 22,
      status: 'changes_requested',
      createdBy: memberId,
    },
    {
      clientKey: 'bloom',
      type: 'post',
      caption:
        'Sunday self-care thread. What is the one product you will never run out of? 💬',
      platforms: ['instagram', 'facebook'],
      day: 25,
      status: 'draft',
      createdBy: memberId,
    },

    // ---- Aurora Cafe (food) ----
    {
      clientKey: 'aurora',
      type: 'post',
      caption:
        'The croissant that started it all. 36 hours of lamination, 3 minutes to disappear. 🥐',
      platforms: ['instagram', 'facebook'],
      day: 1,
      status: 'posted',
      createdBy: memberId,
    },
    {
      clientKey: 'aurora',
      type: 'reel',
      caption:
        'Latte art ASMR you did not know you needed. Sound on. ☕ #LatteArt',
      platforms: ['instagram', 'x'],
      day: 3,
      status: 'posted',
      createdBy: memberId,
    },
    {
      clientKey: 'aurora',
      type: 'story',
      caption: 'Today only: buy one cold brew, gift one. Show this story at the counter. 🧊',
      platforms: ['instagram'],
      day: 5,
      status: 'posted',
      createdBy: memberId,
    },
    {
      clientKey: 'aurora',
      type: 'carousel',
      caption:
        'A walk through our new summer menu — 6 plates, one very hungry photographer.',
      platforms: ['instagram', 'facebook'],
      day: 7,
      status: 'scheduled',
      createdBy: memberId,
    },
    {
      clientKey: 'aurora',
      type: 'post',
      caption:
        'Meet Priya, the hands behind every loaf. Baker spotlight, every first Friday. 🍞',
      platforms: ['instagram', 'facebook'],
      day: 10,
      status: 'scheduled',
      createdBy: ownerId,
    },
    {
      clientKey: 'aurora',
      type: 'reel',
      caption:
        'How we plate the matcha tiramisu in 4 moves. Save it, then come taste it. 🍵',
      platforms: ['instagram'],
      day: 12,
      status: 'approved',
      createdBy: memberId,
    },
    {
      clientKey: 'aurora',
      type: 'carousel',
      caption:
        'Weekend brunch lineup is here. Swipe for the full spread and bring a friend. 🍳',
      platforms: ['instagram', 'facebook'],
      day: 14,
      status: 'approved',
      createdBy: memberId,
    },
    {
      clientKey: 'aurora',
      type: 'post',
      caption:
        'We are hiring a weekend barista! Tag someone who makes a mean flat white. ☕',
      platforms: ['instagram', 'facebook', 'x'],
      day: 17,
      status: 'pending_approval',
      createdBy: memberId,
    },
    {
      clientKey: 'aurora',
      type: 'reel',
      caption:
        'A day in 30 seconds: 6am dough, 8am rush, 4pm golden hour. This is Aurora.',
      platforms: ['instagram', 'x'],
      day: 20,
      status: 'changes_requested',
      createdBy: memberId,
    },
    {
      clientKey: 'aurora',
      type: 'story',
      caption: 'Rate our new iced pistachio latte 1-10. Be honest. 😅',
      platforms: ['instagram'],
      day: 24,
      status: 'draft',
      createdBy: memberId,
    },
  ];

  const postIds: string[] = [];
  // Track a couple of specific posts we want to attach media/comments/approvals to.
  let bloomPendingPostId = '';
  let bloomChangesPostId = '';
  let auroraApprovedPostId = '';

  for (const p of postSeeds) {
    const id = newId('pst');
    postIds.push(id);
    const scheduledAt = jun(p.day, 10, 0);
    await db.insert(contentPosts).values({
      id,
      agencyId,
      clientId: clientIds[p.clientKey],
      postType: p.type,
      caption: p.caption,
      platformsJson: JSON.stringify(p.platforms),
      scheduledAt,
      status: p.status,
      createdBy: p.createdBy,
    });

    if (p.clientKey === 'bloom' && p.status === 'pending_approval' && !bloomPendingPostId)
      bloomPendingPostId = id;
    if (p.clientKey === 'bloom' && p.status === 'changes_requested' && !bloomChangesPostId)
      bloomChangesPostId = id;
    if (p.clientKey === 'aurora' && p.status === 'approved' && !auroraApprovedPostId)
      auroraApprovedPostId = id;
  }

  // -----------------------------------------------------------------
  // 9. POST_MEDIA — placeholder Cloudinary-style assets on a few posts
  // -----------------------------------------------------------------
  console.log('Seeding post media...');
  const mediaTargets = [
    {
      postId: bloomPendingPostId,
      clientId: clientIds.bloom,
      publicId: 'demo/bloom-serum-1',
      url: 'https://res.cloudinary.com/dkqo3uz5o/image/upload/v1/demo/sample.jpg',
      bytes: 184320,
      width: 1080,
      height: 1350,
    },
    {
      postId: bloomChangesPostId,
      clientId: clientIds.bloom,
      publicId: 'demo/bloom-glowkit-1',
      url: 'https://res.cloudinary.com/dkqo3uz5o/image/upload/v1/demo/sample.jpg',
      bytes: 220114,
      width: 1080,
      height: 1080,
    },
    {
      postId: auroraApprovedPostId,
      clientId: clientIds.aurora,
      publicId: 'demo/aurora-tiramisu-1',
      url: 'https://res.cloudinary.com/dkqo3uz5o/image/upload/v1/demo/sample.jpg',
      bytes: 312050,
      width: 1080,
      height: 1920,
    },
    {
      postId: auroraApprovedPostId,
      clientId: clientIds.aurora,
      publicId: 'demo/aurora-tiramisu-2',
      url: 'https://res.cloudinary.com/dkqo3uz5o/image/upload/v1/demo/sample.jpg',
      bytes: 298765,
      width: 1080,
      height: 1920,
    },
  ];
  let mediaPos = 0;
  for (const m of mediaTargets) {
    if (!m.postId) continue;
    await db.insert(postMedia).values({
      id: newId('med'),
      agencyId,
      clientId: m.clientId,
      postId: m.postId,
      cloudinaryPublicId: m.publicId,
      secureUrl: m.url,
      resourceType: 'image',
      format: 'jpg',
      bytes: m.bytes,
      width: m.width,
      height: m.height,
      position: mediaPos++,
    });
  }

  // -----------------------------------------------------------------
  // 10. PORTAL_TOKENS — Bloom + Aurora (raw token printed; sha256 stored)
  // -----------------------------------------------------------------
  console.log('Seeding portal tokens...');
  const portalLinks: { client: string; rawToken: string; url: string }[] = [];

  const bloomTokenId = newId('ptk');
  const bloomToken = newOpaqueToken(); // { raw, hash }
  await db.insert(portalTokens).values({
    id: bloomTokenId,
    agencyId,
    clientId: clientIds.bloom,
    tokenHash: bloomToken.hash,
    label: 'Bloom Digital — client review link',
    createdBy: ownerId,
    revoked: false,
  });
  portalLinks.push({
    client: 'Bloom Digital',
    rawToken: bloomToken.raw,
    url: `http://localhost:3000/portal/${bloomToken.raw}`,
  });

  const auroraTokenId = newId('ptk');
  const auroraToken = newOpaqueToken();
  await db.insert(portalTokens).values({
    id: auroraTokenId,
    agencyId,
    clientId: clientIds.aurora,
    tokenHash: auroraToken.hash,
    label: 'Aurora Cafe — client review link',
    createdBy: ownerId,
    revoked: false,
  });
  portalLinks.push({
    client: 'Aurora Cafe',
    rawToken: auroraToken.raw,
    url: `http://localhost:3000/portal/${auroraToken.raw}`,
  });

  // -----------------------------------------------------------------
  // 11. POST_COMMENTS + POST_APPROVALS
  //     Includes: a client approval, and a request_changes with a comment.
  // -----------------------------------------------------------------
  console.log('Seeding comments and approvals...');

  // Internal (user) comment on the Bloom pending post.
  if (bloomPendingPostId) {
    await db.insert(postComments).values({
      id: newId('cmt'),
      agencyId,
      clientId: clientIds.bloom,
      postId: bloomPendingPostId,
      authorType: 'user',
      authorUserId: memberId,
      authorLabel: 'Aanya',
      body: 'Caption tightened and SPF claim double-checked. Ready for client review.',
      createdAt: jun(15, 14, 5),
    });
  }

  // Client approval on the Aurora approved post (attributed to Aurora token).
  if (auroraApprovedPostId) {
    await db.insert(postComments).values({
      id: newId('cmt'),
      agencyId,
      clientId: clientIds.aurora,
      postId: auroraApprovedPostId,
      authorType: 'client',
      portalTokenId: auroraTokenId,
      authorLabel: 'Aurora Cafe',
      body: 'Love this one — the matcha shot is gorgeous. Approved!',
      createdAt: jun(12, 16, 30),
    });
    await db.insert(postApprovals).values({
      id: newId('apr'),
      agencyId,
      clientId: clientIds.aurora,
      postId: auroraApprovedPostId,
      portalTokenId: auroraTokenId,
      decision: 'approved',
      note: 'Looks great, ship it.',
      actorLabel: 'Aurora Cafe',
      ip: '203.0.113.21',
      createdAt: jun(12, 16, 31),
    });
  }

  // Client request_changes (with comment) on the Bloom changes-requested post.
  if (bloomChangesPostId) {
    await db.insert(postComments).values({
      id: newId('cmt'),
      agencyId,
      clientId: clientIds.bloom,
      postId: bloomChangesPostId,
      authorType: 'client',
      portalTokenId: bloomTokenId,
      authorLabel: 'Bloom Digital',
      body: 'Can we swap the second clip and avoid the word "cheap"? Otherwise great.',
      createdAt: jun(22, 11, 12),
    });
    await db.insert(postApprovals).values({
      id: newId('apr'),
      agencyId,
      clientId: clientIds.bloom,
      postId: bloomChangesPostId,
      portalTokenId: bloomTokenId,
      decision: 'changes_requested',
      note: 'Swap the second clip; tweak wording per comment.',
      actorLabel: 'Bloom Digital',
      ip: '198.51.100.7',
      createdAt: jun(22, 11, 13),
    });
  }

  // -----------------------------------------------------------------
  // 12. BRAND_STRATEGY — one row for Bloom Digital
  // -----------------------------------------------------------------
  console.log('Seeding brand strategy...');
  await db.insert(brandStrategy).values({
    id: newId('bst'),
    agencyId,
    clientId: clientIds.bloom,
    tone: 'Warm, expert, and reassuring — like a friend who happens to be a dermatologist.',
    audience:
      'Women 22-38, skincare-curious, value science over hype, shop online, follow routines not trends.',
    pillarsJson: JSON.stringify([
      'Education (ingredient science, myth-busting)',
      'Routine & habit-building',
      'Product spotlights & drops',
      'Community & real results',
    ]),
    dos: 'Cite ingredients by name; show real before/afters; keep claims SPF-safe and honest.',
    donts: 'No fearmongering, no "miracle" language, never promise to "cure" anything.',
    notes: 'Lead with value, sell second. Keep the voice calm and confident.',
    updatedBy: ownerId,
  });

  // -----------------------------------------------------------------
  // 13. CREDENTIALS_VAULT — one encrypted demo credential (AES-256-GCM)
  // -----------------------------------------------------------------
  console.log('Seeding credentials vault (encrypted)...');
  const sealed = encryptSecret('demo-instagram-app-password-not-real');
  await db.insert(credentialsVault).values({
    id: newId('vlt'),
    agencyId,
    clientId: clientIds.bloom,
    platform: 'instagram',
    username: '@bloom.digital',
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    authTag: sealed.authTag,
    keyVersion: sealed.keyVersion,
    createdBy: ownerId,
    updatedBy: ownerId,
  });

  // -----------------------------------------------------------------
  // 14. AI_GENERATIONS — one succeeded generation feeding the quota
  // -----------------------------------------------------------------
  console.log('Seeding AI generations...');
  await db.insert(aiGenerations).values({
    id: newId('aig'),
    agencyId,
    clientId: clientIds.bloom,
    requestedBy: ownerId,
    period: '2026-06',
    status: 'succeeded',
    model: 'claude-sonnet-4-5',
    promptSummary: 'Generate a month of skincare content for Bloom Digital.',
    postsCreated: 8,
    inputTokens: 1820,
    outputTokens: 4410,
    createdAt: jun(1, 8, 30),
    completedAt: jun(1, 8, 31),
  });

  // -----------------------------------------------------------------
  // 15. USAGE_COUNTERS — current period rollup
  // -----------------------------------------------------------------
  console.log('Seeding usage counters...');
  const storageUsed = mediaTargets
    .filter((m) => m.postId)
    .reduce((sum, m) => sum + m.bytes, 0);
  await db.insert(usageCounters).values({
    agencyId,
    period: '2026-06',
    aiGenerationsUsed: 1,
    storageBytesUsed: storageUsed,
  });

  // -----------------------------------------------------------------
  // 16. AUDIT_LOG — a couple of representative events
  // -----------------------------------------------------------------
  console.log('Seeding audit log...');
  await db.insert(auditLog).values([
    {
      id: newId('aud'),
      agencyId,
      actorType: 'owner',
      actorId: ownerId,
      action: 'auth.login',
      entityType: 'user',
      entityId: ownerId,
      ip: '203.0.113.10',
      createdAt: jun(2, 9, 15),
    },
    {
      id: newId('aud'),
      agencyId,
      actorType: 'owner',
      actorId: ownerId,
      action: 'portal_token.create',
      entityType: 'portal_token',
      entityId: bloomTokenId,
      metadataJson: JSON.stringify({ client: 'Bloom Digital' }),
      ip: '203.0.113.10',
      createdAt: jun(2, 9, 20),
    },
    {
      id: newId('aud'),
      agencyId,
      actorType: 'client_token',
      actorId: auroraTokenId,
      action: 'post.approve',
      entityType: 'content_post',
      entityId: auroraApprovedPostId,
      ip: '203.0.113.21',
      createdAt: jun(12, 16, 31),
    },
  ]);

  // -----------------------------------------------------------------
  // VERIFY — print per-table row counts.
  // -----------------------------------------------------------------
  console.log('\nSeed complete. Verifying row counts per sanctum_ table...\n');

  const prefix = process.env.TABLE_PREFIX ?? 'sanctum_';
  const tableNames = [
    'plans',
    'agencies',
    'subscriptions',
    'users',
    'invites',
    'clients',
    'client_assignments',
    'portal_tokens',
    'ai_generations',
    'content_posts',
    'post_media',
    'post_comments',
    'post_approvals',
    'brand_strategy',
    'credentials_vault',
    'usage_counters',
    'audit_log',
  ];

  for (const name of tableNames) {
    const full = `${prefix}${name}`;
    const r = await libsql.execute(`SELECT count(*) AS n FROM "${full}"`);
    const n = r.rows[0]?.n ?? 0;
    console.log(`  ${full.padEnd(30)} ${n}`);
  }

  // -----------------------------------------------------------------
  // PRINT — demo login + portal share links (raw tokens; demo only).
  // -----------------------------------------------------------------
  console.log('\n================ DEMO ACCESS ================');
  console.log('Login password (both users): Sanctum@123');
  console.log('  Owner : owner@sanctum.studio   (Siddharth)');
  console.log('  Member: aanya@sanctum.studio   (Aanya)');
  console.log('\nPortal share links (raw token shown once — demo data):');
  for (const link of portalLinks) {
    console.log(`  ${link.client}:`);
    console.log(`    raw token: ${link.rawToken}`);
    console.log(`    share URL: ${link.url}`);
  }
  console.log('============================================\n');
}

main()
  .then(async () => {
    await libsql.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('Seed failed:', err);
    try {
      await libsql.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
