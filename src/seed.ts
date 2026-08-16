/**
 * Sanctum demo seed.
 *
 * Populates the dedicated, already-migrated Turso "sanctum" database (tables
 * prefixed `sanctum_`) with a coherent, "today"-dated demo dataset covering
 * every main model: one agency ("Sanctum Studio"), custom roles, staff + client
 * logins, clients + CRM, leads, projects/tasks/time, attendance/leave, finance,
 * documents, messaging and the content-calendar/portal.
 *
 * - Uses the project's OWN db client + drizzle schema + id/password/vault helpers.
 * - Idempotent: deletes existing rows from every seeded table in FK-safe order,
 *   then re-inserts. Safe to re-run.
 * - Prints a per-role credentials table, portal share links, and row counts.
 *
 * Treats "today" as 2026-08-14; all dates are offsets from that base.
 *
 * Run:  npx --no-install tsc -p tsconfig.json  &&  node dist/seed.js
 */

import { libsql, db, ensurePragmas, schema } from './db/client.js';
import { newId, newOpaqueToken } from './lib/ids.js';
import { hashPassword } from './lib/password.js';
import { encryptSecret } from './services/vault.js';
import { ROLE_PRESETS, serializeOverrides } from './lib/permissions.js';

const {
  plans,
  agencies,
  subscriptions,
  customRoles,
  users,
  invites,
  clients,
  clientAssignments,
  clientUserProjects,
  clientContacts,
  clientNotes,
  clientTags,
  clientTagLinks,
  deals,
  leads,
  leadActivities,
  projects,
  projectMembers,
  projectMilestones,
  projectTasks,
  taskAssignees,
  projectTaskComments,
  projectTaskLabels,
  projectTaskLabelLinks,
  projectTaskDependencies,
  timeLogs,
  timers,
  attendancePolicy,
  attendanceRecords,
  attendanceRegularizations,
  holidays,
  leaveTypes,
  leaveRequests,
  notifications,
  expenses,
  invoices,
  invoiceItems,
  invoicePayments,
  agreements,
  agreementTemplates,
  proposals,
  proposalTemplates,
  attendanceCheckoutRequests,
  passwordResets,
  pushTokens,
  documentFolders,
  documents,
  sheets,
  messageThreads,
  threadParticipants,
  messages,
  contentPosts,
  postMedia,
  portalTokens,
  postComments,
  postApprovals,
  brandStrategy,
  credentialsVault,
  aiGenerations,
  usageCounters,
  auditLog,
} = schema;

const GB = 1024 * 1024 * 1024;
const PERIOD = '2026-08';

// "today"
const TODAY = new Date('2026-08-14T09:00:00Z');

/** A UTC instant `offsetDays` from TODAY at the given hour/minute. */
function at(offsetDays: number, hour = 10, minute = 0): Date {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

/** 'YYYY-MM-DD' for a day `offsetDays` from TODAY (UTC). */
function dayStr(offsetDays: number): string {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Rupees -> integer paise (money is stored as INTEGER PAISE, ₹1 = 100). */
const inr = (rupees: number): number => Math.round(rupees * 100);

// ---- shared enum unions (keep object-literal inserts strongly typed) ----
type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
type PostType = 'reel' | 'story' | 'carousel' | 'post';
type PostStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'changes_requested'
  | 'scheduled'
  | 'posted';
type ClientSource =
  | 'referral'
  | 'inbound'
  | 'outbound'
  | 'social'
  | 'event'
  | 'agency_network'
  | 'other';
type Health = 'excellent' | 'good' | 'at_risk' | 'poor';
type DealStage =
  | 'lead'
  | 'qualified'
  | 'proposal'
  | 'negotiation'
  | 'won'
  | 'lost';
type LeadStage =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'converted'
  | 'lost'
  | 'spam';

async function main(): Promise<void> {
  // Disable FK constraints temporarily during table clean
  try {
    await libsql.execute('PRAGMA foreign_keys = OFF;');
  } catch {}

  // -----------------------------------------------------------------
  // 1. CLEAN — delete in FK-safe (child -> parent) order. Idempotent.
  // -----------------------------------------------------------------
  console.log('Cleaning existing demo rows (FK-safe order)...');
  await db.delete(agreements);
  await db.delete(agreementTemplates);
  await db.delete(proposals);
  await db.delete(proposalTemplates);
  await db.delete(passwordResets);
  await db.delete(pushTokens);
  await db.delete(attendanceCheckoutRequests);
  await db.delete(messages);
  await db.delete(threadParticipants);
  await db.delete(messageThreads);
  await db.delete(notifications);
  await db.delete(sheets);
  await db.delete(documents);
  await db.delete(documentFolders);
  await db.delete(invoicePayments);
  await db.delete(invoiceItems);
  await db.delete(invoices);
  await db.delete(expenses);
  await db.delete(attendanceRegularizations);
  await db.delete(leaveRequests);
  await db.delete(leaveTypes);
  await db.delete(holidays);
  await db.delete(attendanceRecords);
  await db.delete(attendancePolicy);
  await db.delete(timers);
  await db.delete(timeLogs);
  await db.delete(projectTaskDependencies);
  await db.delete(projectTaskLabelLinks);
  await db.delete(projectTaskComments);
  await db.delete(taskAssignees);
  await db.delete(projectTaskLabels);
  await db.delete(projectTasks);
  await db.delete(projectMilestones);
  await db.delete(projectMembers);
  await db.delete(clientUserProjects);
  await db.delete(postApprovals);
  await db.delete(postComments);
  await db.delete(postMedia);
  await db.delete(contentPosts);
  await db.delete(aiGenerations);
  await db.delete(credentialsVault);
  await db.delete(brandStrategy);
  await db.delete(portalTokens);
  await db.delete(leadActivities);
  await db.delete(leads);
  await db.delete(deals);
  await db.delete(clientTagLinks);
  await db.delete(clientTags);
  await db.delete(clientNotes);
  await db.delete(clientContacts);
  await db.delete(clientAssignments);
  await db.delete(projects);
  await db.delete(invites);
  await db.delete(usageCounters);
  await db.delete(auditLog);
  await db.delete(customRoles);
  await db.delete(clients);
  await db.delete(users);
  await db.delete(subscriptions);
  await db.delete(agencies);
  await db.delete(plans);

  // -----------------------------------------------------------------
  // 2. PLANS (shared catalog)
  // -----------------------------------------------------------------
  await ensurePragmas();
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
      maxClients: null,
      maxTeamMembers: null,
      maxAiGenerations: 1000,
      maxStorageBytes: 100 * GB,
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
    createdAt: at(-200),
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
    currentPeriodStart: at(-14, 0, 0),
    currentPeriodEnd: at(16, 0, 0),
    externalCustomerId: 'cus_demo_sanctum',
    externalSubscriptionId: 'sub_demo_sanctum',
  });

  // -----------------------------------------------------------------
  // 5. CUSTOM ROLES — Manager + Employee from ROLE_PRESETS
  // -----------------------------------------------------------------
  console.log('Seeding custom roles...');
  const managerPreset = ROLE_PRESETS.find((p) => p.key === 'manager')!;
  const employeePreset = ROLE_PRESETS.find((p) => p.key === 'employee')!;
  const managerRoleId = newId('crl');
  const employeeRoleId = newId('crl');
  await db.insert(customRoles).values([
    {
      id: managerRoleId,
      agencyId,
      name: managerPreset.name,
      colorToken: managerPreset.colorToken,
      baseRole: managerPreset.baseRole,
      permissionsJson: serializeOverrides(managerPreset.permissions),
    },
    {
      id: employeeRoleId,
      agencyId,
      name: employeePreset.name,
      colorToken: employeePreset.colorToken,
      baseRole: employeePreset.baseRole,
      permissionsJson: serializeOverrides(employeePreset.permissions),
    },
  ]);

  // -----------------------------------------------------------------
  // 6. STAFF USERS — all password "Sanctum@123", status active
  // -----------------------------------------------------------------
  console.log('Seeding users (hashing passwords with argon2)...');
  const passwordHash = await hashPassword('Sanctum@123');

  const ownerId = newId('usr');
  const adminId = newId('usr');
  const managerId = newId('usr');
  const emp1Id = newId('usr');
  const emp2Id = newId('usr');
  const emp3Id = newId('usr');
  const client1UserId = newId('usr');
  const client2UserId = newId('usr');

  await db.insert(users).values([
    {
      id: ownerId,
      agencyId,
      email: 'owner@sanctum.test',
      passwordHash,
      fullName: 'Arjun Mehta',
      role: 'owner',
      status: 'active',
      designation: 'Founder',
      department: 'Leadership',
      phone: '+91 98765 40001',
      weeklyCapacityHrs: 40,
      lastLoginAt: at(0, 8, 30),
    },
    {
      id: adminId,
      agencyId,
      email: 'admin@sanctum.test',
      passwordHash,
      fullName: 'Priya Sharma',
      role: 'admin',
      status: 'active',
      designation: 'Operations Lead',
      department: 'Operations',
      phone: '+91 98765 40002',
      hourlyRate: inr(1000),
      weeklyCapacityHrs: 40,
      skills: 'Ops, Finance, Client Success',
      lastLoginAt: at(0, 9, 5),
    },
    {
      id: managerId,
      agencyId,
      email: 'manager@sanctum.test',
      passwordHash,
      fullName: 'Rahul Nair',
      role: 'member',
      customRoleId: managerRoleId,
      status: 'active',
      designation: 'Delivery Manager',
      department: 'Delivery',
      phone: '+91 98765 40003',
      hourlyRate: inr(1200),
      weeklyCapacityHrs: 40,
      skills: 'Project Management, Strategy, Client Relations',
      lastLoginAt: at(0, 9, 20),
    },
    {
      id: emp1Id,
      agencyId,
      email: 'emp1@sanctum.test',
      passwordHash,
      fullName: 'Sneha Iyer',
      role: 'member',
      customRoleId: employeeRoleId,
      status: 'active',
      designation: 'Senior Designer',
      department: 'Creative',
      phone: '+91 98765 40004',
      hourlyRate: inr(800),
      weeklyCapacityHrs: 40,
      skills: 'Figma, Illustrator, Branding, Motion',
      lastLoginAt: at(0, 9, 35),
    },
    {
      id: emp2Id,
      agencyId,
      email: 'emp2@sanctum.test',
      passwordHash,
      fullName: 'Vikram Rao',
      role: 'member',
      customRoleId: employeeRoleId,
      status: 'active',
      designation: 'Content Writer',
      department: 'Content',
      phone: '+91 98765 40005',
      hourlyRate: inr(650),
      weeklyCapacityHrs: 40,
      skills: 'Copywriting, SEO, Scriptwriting',
      lastLoginAt: at(-1, 18, 10),
    },
    {
      id: emp3Id,
      agencyId,
      email: 'emp3@sanctum.test',
      passwordHash,
      fullName: 'Ananya Gupta',
      role: 'member',
      customRoleId: employeeRoleId,
      status: 'active',
      designation: 'Social Media Executive',
      department: 'Social',
      phone: '+91 98765 40006',
      hourlyRate: inr(600),
      weeklyCapacityHrs: 40,
      skills: 'Instagram, Analytics, Community, Ads',
      lastLoginAt: at(0, 9, 45),
    },
  ]);

  // -----------------------------------------------------------------
  // 7. CLIENTS (5) — CRM fields; ownerId = account manager (staff)
  // -----------------------------------------------------------------
  console.log('Seeding clients...');
  type ClientSeed = {
    key: string;
    name: string;
    industry: string;
    brandColor: string;
    contactEmail: string;
    website: string;
    phone: string;
    source: ClientSource;
    gst: string;
    terms: number;
    city: string;
    state: string;
    pincode: string;
    health: Health;
    ownerId: string;
    followUpOffset: number;
    handles: Record<string, string>;
  };
  const clientSeeds: ClientSeed[] = [
    {
      key: 'bloom',
      name: 'Bloom Digital',
      industry: 'Beauty & Skincare',
      brandColor: '#EC4899',
      contactEmail: 'hello@bloomdigital.co',
      website: 'https://bloomdigital.co',
      phone: '98111 22001',
      source: 'referral',
      gst: '27AABCB1234C1Z5',
      terms: 15,
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      health: 'excellent',
      ownerId: adminId,
      followUpOffset: 4,
      handles: { instagram: '@bloom.digital', facebook: 'BloomDigitalSkincare' },
    },
    {
      key: 'aurora',
      name: 'Aurora Cafe',
      industry: 'Food & Beverage',
      brandColor: '#F59E0B',
      contactEmail: 'manager@auroracafe.com',
      website: 'https://auroracafe.com',
      phone: '98111 22002',
      source: 'inbound',
      gst: '27AACCA5678D1Z2',
      terms: 30,
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      health: 'good',
      ownerId: managerId,
      followUpOffset: 2,
      handles: { instagram: '@aurora.cafe', x: '@auroracafe' },
    },
    {
      key: 'novafit',
      name: 'NovaFit',
      industry: 'Health & Fitness',
      brandColor: '#10B981',
      contactEmail: 'team@novafit.app',
      website: 'https://novafit.app',
      phone: '98111 22003',
      source: 'social',
      gst: '29AADCN9012E1Z9',
      terms: 15,
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      health: 'good',
      ownerId: adminId,
      followUpOffset: 7,
      handles: { instagram: '@novafit', youtube: '@novafit.training' },
    },
    {
      key: 'lumen',
      name: 'Lumen Realty',
      industry: 'Real Estate',
      brandColor: '#0EA5E9',
      contactEmail: 'contact@lumenrealty.com',
      website: 'https://lumenrealty.com',
      phone: '98111 22004',
      source: 'outbound',
      gst: '07AAECL3456F1Z1',
      terms: 45,
      city: 'Delhi',
      state: 'Delhi',
      pincode: '110001',
      health: 'at_risk',
      ownerId: managerId,
      followUpOffset: 1,
      handles: { instagram: '@lumen.realty', linkedin: 'lumen-realty' },
    },
    {
      key: 'saffron',
      name: 'Saffron Kitchen',
      industry: 'Restaurant',
      brandColor: '#DC2626',
      contactEmail: 'reservations@saffronkitchen.in',
      website: 'https://saffronkitchen.in',
      phone: '98111 22005',
      source: 'event',
      gst: '24AAFCS7890G1Z8',
      terms: 30,
      city: 'Ahmedabad',
      state: 'Gujarat',
      pincode: '380001',
      health: 'good',
      ownerId: adminId,
      followUpOffset: 10,
      handles: { instagram: '@saffron.kitchen', facebook: 'SaffronKitchenIndian' },
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
      handlesJson: JSON.stringify(c.handles),
      contactEmail: c.contactEmail,
      status: 'active',
      industry: c.industry,
      website: c.website,
      phoneCc: '+91',
      phone: c.phone,
      clientSource: c.source,
      gstNumber: c.gst,
      paymentTermsDays: c.terms,
      billingAddress: `${c.city} HQ`,
      billingState: c.state,
      billingCity: c.city,
      billingPincode: c.pincode,
      relationshipHealth: c.health,
      nextFollowUpAt: at(c.followUpOffset, 11),
      internalNotes: `Account owned by the studio. Payment terms ${c.terms} days.`,
      portalRole: c.key === 'aurora' ? 'reviewer' : 'approver',
      ownerId: c.ownerId,
      createdAt: at(-150),
    });
  }

  // -----------------------------------------------------------------
  // 8. CLIENT USERS — role 'client'; client1 (Bloom) unscoped, client2
  //    (Aurora) scoped to ONE project via client_user_projects (below).
  // -----------------------------------------------------------------
  console.log('Seeding client users...');
  await db.insert(users).values([
    {
      id: client1UserId,
      agencyId,
      email: 'client1@sanctum.test',
      passwordHash,
      fullName: 'Meera Kapoor (Bloom Digital)',
      role: 'client',
      clientId: clientIds.bloom,
      status: 'active',
      phone: '+91 98111 22001',
      lastLoginAt: at(-1, 20, 15),
    },
    {
      id: client2UserId,
      agencyId,
      email: 'client2@sanctum.test',
      passwordHash,
      fullName: 'Karan Malhotra (Aurora Cafe)',
      role: 'client',
      clientId: clientIds.aurora,
      status: 'active',
      phone: '+91 98111 22002',
      lastLoginAt: at(-2, 19, 40),
    },
  ]);

  // -----------------------------------------------------------------
  // 9. CLIENT ASSIGNMENTS — staff scoping
  // -----------------------------------------------------------------
  console.log('Seeding client assignments...');
  await db.insert(clientAssignments).values([
    { id: newId('asg'), agencyId, clientId: clientIds.bloom, userId: emp1Id, assignedBy: ownerId },
    { id: newId('asg'), agencyId, clientId: clientIds.bloom, userId: emp2Id, assignedBy: ownerId },
    { id: newId('asg'), agencyId, clientId: clientIds.aurora, userId: emp3Id, assignedBy: managerId },
    { id: newId('asg'), agencyId, clientId: clientIds.aurora, userId: emp1Id, assignedBy: managerId },
    { id: newId('asg'), agencyId, clientId: clientIds.novafit, userId: managerId, assignedBy: ownerId },
    { id: newId('asg'), agencyId, clientId: clientIds.lumen, userId: emp2Id, assignedBy: managerId },
  ]);

  // -----------------------------------------------------------------
  // 10. CLIENT CONTACTS
  // -----------------------------------------------------------------
  console.log('Seeding client contacts...');
  await db.insert(clientContacts).values([
    {
      id: newId('cct'),
      agencyId,
      clientId: clientIds.bloom,
      name: 'Meera Kapoor',
      role: 'Founder',
      email: 'meera@bloomdigital.co',
      phone: '+91 98111 22001',
      isPrimary: true,
      isBilling: true,
      notes: 'Main decision-maker; prefers WhatsApp.',
    },
    {
      id: newId('cct'),
      agencyId,
      clientId: clientIds.bloom,
      name: 'Dev Anand',
      role: 'Marketing Lead',
      email: 'dev@bloomdigital.co',
      phone: '+91 98111 22011',
      isPrimary: false,
      isBilling: false,
      notes: 'Day-to-day content approvals.',
    },
    {
      id: newId('cct'),
      agencyId,
      clientId: clientIds.aurora,
      name: 'Karan Malhotra',
      role: 'Owner',
      email: 'karan@auroracafe.com',
      phone: '+91 98111 22002',
      isPrimary: true,
      isBilling: true,
      notes: 'Reviews everything before it goes live.',
    },
    {
      id: newId('cct'),
      agencyId,
      clientId: clientIds.lumen,
      name: 'Rhea Sethi',
      role: 'Finance',
      email: 'accounts@lumenrealty.com',
      phone: '+91 98111 22041',
      isPrimary: true,
      isBilling: true,
      notes: 'Slow on payments — follow up before due date.',
    },
  ]);

  // -----------------------------------------------------------------
  // 11. CLIENT NOTES — activity timeline (note / call / meeting / ...)
  // -----------------------------------------------------------------
  console.log('Seeding client notes...');
  await db.insert(clientNotes).values([
    {
      id: newId('cnt'),
      agencyId,
      clientId: clientIds.bloom,
      authorId: adminId,
      type: 'meeting',
      body: 'Kickoff for the Summer Skincare Launch. Agreed on 4-week runway and hero SKU.',
      pinned: true,
      createdAt: at(-20, 11),
    },
    {
      id: newId('cnt'),
      agencyId,
      clientId: clientIds.bloom,
      authorId: emp2Id,
      type: 'call',
      body: 'Meera confirmed launch date and approved the content calendar.',
      createdAt: at(-9, 15),
    },
    {
      id: newId('cnt'),
      agencyId,
      clientId: clientIds.aurora,
      authorId: managerId,
      type: 'meeting',
      body: 'Rebrand review — client likes concept B, wants warmer palette.',
      createdAt: at(-6, 12),
    },
    {
      id: newId('cnt'),
      agencyId,
      clientId: clientIds.lumen,
      authorId: managerId,
      type: 'note',
      body: 'Relationship at risk — slow feedback and overdue invoice. Escalate.',
      pinned: true,
      createdAt: at(-3, 10),
    },
    {
      id: newId('cnt'),
      agencyId,
      clientId: clientIds.lumen,
      authorId: managerId,
      type: 'task',
      body: 'Call Rhea about the overdue invoice.',
      dueAt: at(1, 11),
      createdAt: at(-1, 16),
    },
    {
      id: newId('cnt'),
      agencyId,
      clientId: clientIds.saffron,
      authorId: adminId,
      type: 'email',
      body: 'Sent the reels package proposal; awaiting reply.',
      createdAt: at(-11, 9),
    },
  ]);

  // -----------------------------------------------------------------
  // 12. CLIENT TAGS + LINKS
  // -----------------------------------------------------------------
  console.log('Seeding client tags...');
  const tagVip = newId('tag');
  const tagRetainer = newId('tag');
  const tagPriority = newId('tag');
  const tagProspect = newId('tag');
  await db.insert(clientTags).values([
    { id: tagVip, agencyId, name: 'VIP', colorToken: 'amber' },
    { id: tagRetainer, agencyId, name: 'Retainer', colorToken: 'pine' },
    { id: tagPriority, agencyId, name: 'Priority', colorToken: 'rose' },
    { id: tagProspect, agencyId, name: 'Upsell', colorToken: 'violet' },
  ]);
  await db.insert(clientTagLinks).values([
    { agencyId, clientId: clientIds.bloom, tagId: tagVip },
    { agencyId, clientId: clientIds.bloom, tagId: tagRetainer },
    { agencyId, clientId: clientIds.aurora, tagId: tagRetainer },
    { agencyId, clientId: clientIds.lumen, tagId: tagPriority },
    { agencyId, clientId: clientIds.novafit, tagId: tagProspect },
    { agencyId, clientId: clientIds.saffron, tagId: tagProspect },
  ]);

  // -----------------------------------------------------------------
  // 13. DEALS — sales pipeline (all stages; valuePaise)
  // -----------------------------------------------------------------
  console.log('Seeding deals...');
  const dealSeeds: Array<{
    title: string;
    clientKey: string;
    stage: DealStage;
    value: number;
    probability: number;
    closeOffset: number;
    owner: string;
    notes: string;
    closedOffset?: number;
    lostReason?: string;
  }> = [
    { title: 'Saffron — Menu photography', clientKey: 'saffron', stage: 'lead', value: inr(45000), probability: 20, closeOffset: 25, owner: adminId, notes: 'Inbound enquiry via website.' },
    { title: 'Bloom — Festive campaign', clientKey: 'bloom', stage: 'qualified', value: inr(120000), probability: 40, closeOffset: 30, owner: adminId, notes: 'Qualified; needs budget confirmation.' },
    { title: 'NovaFit — App launch retainer', clientKey: 'novafit', stage: 'proposal', value: inr(180000), probability: 60, closeOffset: 20, owner: adminId, notes: 'Proposal sent; awaiting sign-off.' },
    { title: 'Lumen — Q4 website + ads', clientKey: 'lumen', stage: 'negotiation', value: inr(320000), probability: 75, closeOffset: 12, owner: managerId, notes: 'Negotiating scope and timeline.' },
    { title: 'Aurora — Second outlet launch', clientKey: 'aurora', stage: 'won', value: inr(150000), probability: 100, closeOffset: -3, owner: managerId, notes: 'Closed won — kickoff scheduled.', closedOffset: -3 },
    { title: 'Saffron — Reels package', clientKey: 'saffron', stage: 'lost', value: inr(90000), probability: 0, closeOffset: -10, owner: adminId, notes: 'Went with another agency.', closedOffset: -8, lostReason: 'Budget / price' },
  ];
  for (const d of dealSeeds) {
    await db.insert(deals).values({
      id: newId('deal'),
      agencyId,
      clientId: clientIds[d.clientKey],
      title: d.title,
      stage: d.stage,
      valuePaise: d.value,
      currency: 'INR',
      probability: d.probability,
      expectedCloseAt: at(d.closeOffset, 12),
      ownerId: d.owner,
      lostReason: d.lostReason ?? null,
      notes: d.notes,
      createdBy: adminId,
      closedAt: d.closedOffset != null ? at(d.closedOffset, 15) : null,
      createdAt: at(d.closeOffset - 20, 10),
    });
  }

  // -----------------------------------------------------------------
  // 14. LEADS + LEAD ACTIVITIES (inbound pipeline)
  // -----------------------------------------------------------------
  console.log('Seeding leads...');
  const leadSeeds: Array<{
    name: string;
    company: string;
    email: string;
    phone: string;
    source: string;
    service: string;
    budget: string;
    message: string;
    stage: LeadStage;
    value: number;
    owner: string;
    actOffset: number;
    convertedClientKey?: string;
  }> = [
    { name: 'Rohan Desai', company: 'FitPeak Gyms', email: 'rohan@fitpeak.in', phone: '+91 98200 11111', source: 'website', service: 'Social media management', budget: '₹50k-₹1L/mo', message: 'Looking to grow our Instagram presence.', stage: 'new', value: inr(80000), owner: adminId, actOffset: -1 },
    { name: 'Isha Verma', company: 'The Bake Studio', email: 'isha@bakestudio.in', phone: '+91 98200 22222', source: 'referral', service: 'Content + ads', budget: '₹40k/mo', message: 'Referred by Aurora Cafe.', stage: 'contacted', value: inr(40000), owner: managerId, actOffset: -2 },
    { name: 'Aditya Kulkarni', company: 'UrbanNest Interiors', email: 'aditya@urbannest.in', phone: '+91 98200 33333', source: 'event', service: 'Full-funnel marketing', budget: '₹1.5L/mo', message: 'Met at the design expo.', stage: 'qualified', value: inr(150000), owner: adminId, actOffset: -3 },
    { name: 'Neha Joshi', company: 'GreenLeaf Organics', email: 'neha@greenleaf.in', phone: '+91 98200 44444', source: 'inbound', service: 'Branding + social', budget: '₹1L/mo', message: 'Ready to start next month.', stage: 'converted', value: inr(120000), owner: managerId, actOffset: -6, convertedClientKey: 'saffron' },
    { name: 'Sameer Khan', company: 'Khan Motors', email: 'sameer@khanmotors.in', phone: '+91 98200 55555', source: 'outbound', service: 'Reels', budget: '₹30k', message: 'Not the right time for us.', stage: 'lost', value: inr(30000), owner: adminId, actOffset: -9 },
    { name: 'promo bot', company: '', email: 'promo@spam.example', phone: '', source: 'website', service: '', budget: '', message: 'Buy 10k followers cheap!!! click here', stage: 'spam', value: 0, owner: adminId, actOffset: -4 },
  ];
  const leadIds: string[] = [];
  for (const l of leadSeeds) {
    const id = newId('lead');
    leadIds.push(id);
    await db.insert(leads).values({
      id,
      agencyId,
      name: l.name,
      company: l.company || null,
      email: l.email || null,
      phone: l.phone || null,
      source: l.source || null,
      service: l.service || null,
      budget: l.budget || null,
      message: l.message || null,
      stage: l.stage,
      estimatedValue: l.value || null,
      ownerId: l.owner,
      convertedClientId: l.convertedClientKey ? clientIds[l.convertedClientKey] : null,
      lastActivityAt: at(l.actOffset, 14),
      createdAt: at(l.actOffset - 3, 9),
    });
  }
  console.log('Seeding lead activities...');
  await db.insert(leadActivities).values([
    {
      id: newId('lac'),
      agencyId,
      leadId: leadIds[1],
      authorId: managerId,
      type: 'call',
      body: 'Intro call done — sending a starter proposal.',
      createdAt: at(-2, 11),
    },
    {
      id: newId('lac'),
      agencyId,
      leadId: leadIds[1],
      authorId: managerId,
      type: 'follow_up',
      body: 'Follow up on the proposal.',
      dueAt: at(2, 11),
      createdAt: at(-2, 11, 5),
    },
    {
      id: newId('lac'),
      agencyId,
      leadId: leadIds[2],
      authorId: adminId,
      type: 'note',
      body: 'Strong fit — budget and timeline aligned.',
      createdAt: at(-3, 16),
    },
    {
      id: newId('lac'),
      agencyId,
      leadId: leadIds[2],
      authorId: adminId,
      type: 'follow_up',
      body: 'Send SOW and pricing.',
      dueAt: at(1, 10),
      createdAt: at(-3, 16, 5),
    },
  ]);

  // -----------------------------------------------------------------
  // 15. PROJECTS (5) — spread across clients; varied status + health
  // -----------------------------------------------------------------
  console.log('Seeding projects...');
  const P = {
    bloomLaunch: newId('prj'),
    auroraRebrand: newId('prj'),
    auroraRetainer: newId('prj'),
    novafitApp: newId('prj'),
    lumenWeb: newId('prj'),
  };
  await db.insert(projects).values([
    {
      id: P.bloomLaunch,
      agencyId,
      clientId: clientIds.bloom,
      name: 'Summer Skincare Launch',
      description: '4-week launch runway for the Midnight Repair Serum.',
      type: 'fixed_price',
      status: 'active',
      health: 'on_track',
      contractValue: inr(150000),
      currency: 'INR',
      startDate: at(-20),
      deadline: at(25),
      createdBy: ownerId,
      createdAt: at(-22),
    },
    {
      id: P.auroraRebrand,
      agencyId,
      clientId: clientIds.aurora,
      name: 'Cafe Rebrand 2026',
      description: 'Full visual identity refresh + menu redesign.',
      type: 'milestone_based',
      status: 'active',
      health: 'at_risk',
      contractValue: inr(250000),
      currency: 'INR',
      startDate: at(-35),
      deadline: at(10),
      createdBy: managerId,
      createdAt: at(-37),
    },
    {
      id: P.auroraRetainer,
      agencyId,
      clientId: clientIds.aurora,
      name: 'Q3 Content Retainer',
      description: 'Monthly content + reporting retainer.',
      type: 'retainer',
      status: 'completed',
      health: 'on_track',
      contractValue: inr(35000),
      currency: 'INR',
      startDate: at(-120),
      deadline: at(-5),
      createdBy: managerId,
      createdAt: at(-122),
    },
    {
      id: P.novafitApp,
      agencyId,
      clientId: clientIds.novafit,
      name: 'App Launch Campaign',
      description: 'Go-to-market campaign for the NovaFit app.',
      type: 'fixed_price',
      status: 'planning',
      health: 'on_track',
      contractValue: inr(400000),
      currency: 'INR',
      startDate: at(5),
      deadline: at(60),
      createdBy: adminId,
      createdAt: at(-4),
    },
    {
      id: P.lumenWeb,
      agencyId,
      clientId: clientIds.lumen,
      name: 'Website + Listings Revamp',
      description: 'New website and property-listings overhaul.',
      type: 'hourly',
      status: 'on_hold',
      health: 'off_track',
      contractValue: inr(0),
      currency: 'INR',
      startDate: at(-60),
      deadline: at(-2),
      createdBy: managerId,
      createdAt: at(-62),
    },
  ]);

  // client2 (Aurora) scoped to exactly ONE of Aurora's two projects.
  console.log('Seeding client_user_projects (scoping client2)...');
  await db.insert(clientUserProjects).values({
    id: newId('cup'),
    agencyId,
    userId: client2UserId,
    projectId: P.auroraRebrand,
  });

  // -----------------------------------------------------------------
  // 16. PROJECT MEMBERS
  // -----------------------------------------------------------------
  console.log('Seeding project members...');
  await db.insert(projectMembers).values([
    { id: newId('pmb'), agencyId, projectId: P.bloomLaunch, userId: managerId, role: 'lead' },
    { id: newId('pmb'), agencyId, projectId: P.bloomLaunch, userId: emp1Id, role: 'contributor' },
    { id: newId('pmb'), agencyId, projectId: P.bloomLaunch, userId: emp2Id, role: 'contributor' },
    { id: newId('pmb'), agencyId, projectId: P.auroraRebrand, userId: managerId, role: 'lead' },
    { id: newId('pmb'), agencyId, projectId: P.auroraRebrand, userId: emp1Id, role: 'contributor' },
    { id: newId('pmb'), agencyId, projectId: P.auroraRebrand, userId: emp3Id, role: 'contributor' },
    { id: newId('pmb'), agencyId, projectId: P.auroraRetainer, userId: emp2Id, role: 'lead' },
    { id: newId('pmb'), agencyId, projectId: P.auroraRetainer, userId: emp3Id, role: 'contributor' },
    { id: newId('pmb'), agencyId, projectId: P.novafitApp, userId: managerId, role: 'lead' },
    { id: newId('pmb'), agencyId, projectId: P.novafitApp, userId: emp1Id, role: 'contributor' },
    { id: newId('pmb'), agencyId, projectId: P.lumenWeb, userId: emp2Id, role: 'lead' },
    { id: newId('pmb'), agencyId, projectId: P.lumenWeb, userId: emp3Id, role: 'contributor' },
  ]);

  // -----------------------------------------------------------------
  // 17. PROJECT MILESTONES (2-3 each; some done/overdue)
  // -----------------------------------------------------------------
  console.log('Seeding milestones...');
  const milestoneIds: Record<string, string> = {};
  type MilestoneSpec = {
    project: string;
    title: string;
    dueOffset: number;
    status: 'pending' | 'completed';
    completedOffset?: number;
    position: number;
    key?: string;
  };
  const milestoneSpecs: MilestoneSpec[] = [
    { project: P.bloomLaunch, title: 'Content plan approved', dueOffset: -12, status: 'completed', completedOffset: -13, position: 0 },
    { project: P.bloomLaunch, title: 'Photoshoot day', dueOffset: -2, status: 'completed', completedOffset: -2, position: 1, key: 'bloom-shoot' },
    { project: P.bloomLaunch, title: 'Go-live', dueOffset: 24, status: 'pending', position: 2, key: 'bloom-golive' },
    { project: P.auroraRebrand, title: 'Brand audit', dueOffset: -20, status: 'completed', completedOffset: -21, position: 0 },
    { project: P.auroraRebrand, title: 'Logo + identity (OVERDUE)', dueOffset: -3, status: 'pending', position: 1, key: 'aurora-logo' },
    { project: P.auroraRebrand, title: 'Rollout', dueOffset: 9, status: 'pending', position: 2 },
    { project: P.auroraRetainer, title: 'July content', dueOffset: -40, status: 'completed', completedOffset: -38, position: 0 },
    { project: P.auroraRetainer, title: 'August content', dueOffset: -8, status: 'completed', completedOffset: -6, position: 1 },
    { project: P.novafitApp, title: 'Kickoff', dueOffset: 7, status: 'pending', position: 0 },
    { project: P.lumenWeb, title: 'Discovery', dueOffset: -40, status: 'completed', completedOffset: -42, position: 0 },
    { project: P.lumenWeb, title: 'Design (OVERDUE)', dueOffset: -5, status: 'pending', position: 1 },
  ];
  const milestoneRows: Array<typeof projectMilestones.$inferInsert> = [];
  for (const m of milestoneSpecs) {
    const id = newId('mst');
    if (m.key) milestoneIds[m.key] = id;
    milestoneRows.push({
      id,
      agencyId,
      projectId: m.project,
      title: m.title,
      dueDate: at(m.dueOffset, 18),
      status: m.status,
      completedAt: m.completedOffset != null ? at(m.completedOffset, 15) : null,
      position: m.position,
    });
  }
  await db.insert(projectMilestones).values(milestoneRows);

  // -----------------------------------------------------------------
  // 18. PROJECT TASKS (+ task_assignees) — all statuses, overdue/due-today,
  //     varied priorities, a couple of subtasks.
  // -----------------------------------------------------------------
  console.log('Seeding project tasks...');
  type TaskSpec = {
    title: string;
    status: TaskStatus;
    priority: Priority;
    assignee: string | null;
    dueOffset: number | null;
    startOffset?: number | null;
    estimate?: number | null;
    milestoneKey?: string;
    key?: string;
    parentKey?: string;
    description?: string;
  };
  const taskKeyIds: Record<string, string> = {};
  async function insertTasks(projectId: string, specs: TaskSpec[]): Promise<string[]> {
    const ids: string[] = [];
    let pos = 0;
    for (const s of specs) {
      const id = newId('tsk');
      const dueDate = s.dueOffset == null ? null : at(s.dueOffset, 18);
      const startDate = s.startOffset != null ? at(s.startOffset, 9) : null;
      const completedAt = s.status === 'done' ? at(s.dueOffset ?? -1, 15) : null;
      await db.insert(projectTasks).values({
        id,
        agencyId,
        projectId,
        milestoneId: s.milestoneKey ? milestoneIds[s.milestoneKey] : null,
        title: s.title,
        description: s.description ?? null,
        status: s.status,
        assigneeId: s.assignee,
        priority: s.priority,
        estimateMinutes: s.estimate ?? null,
        startDate,
        dueDate,
        completedAt,
        parentTaskId: s.parentKey ? taskKeyIds[s.parentKey] : null,
        position: pos++,
      });
      if (s.assignee) {
        await db.insert(taskAssignees).values({
          id: newId('tas'),
          agencyId,
          taskId: id,
          userId: s.assignee,
        });
      }
      if (s.key) taskKeyIds[s.key] = id;
      ids.push(id);
    }
    return ids;
  }

  const bloomTasks: TaskSpec[] = [
    { title: 'Finalize August content calendar', status: 'done', priority: 'high', assignee: emp2Id, dueOffset: -10, estimate: 120 },
    { title: 'Shoot hero product visuals', status: 'done', priority: 'high', assignee: emp1Id, dueOffset: -2, milestoneKey: 'bloom-shoot', key: 'bloom-shoot-task', estimate: 240 },
    { title: 'Edit reel: 60-second routine', status: 'in_review', priority: 'medium', assignee: emp1Id, dueOffset: -1, key: 'bloom-reel', estimate: 180 },
    { title: 'Write captions for launch week', status: 'in_progress', priority: 'high', assignee: emp2Id, dueOffset: 0, key: 'bloom-captions', estimate: 90 },
    { title: 'Design carousel: ingredient science', status: 'in_progress', priority: 'medium', assignee: emp1Id, dueOffset: 1, startOffset: -1, key: 'bloom-carousel', estimate: 150 },
    { title: 'Slide copy for carousel', status: 'todo', priority: 'low', assignee: emp2Id, dueOffset: 1, parentKey: 'bloom-carousel', estimate: 45 },
    { title: 'Source ingredient icons', status: 'todo', priority: 'low', assignee: emp1Id, dueOffset: 1, parentKey: 'bloom-carousel', estimate: 60 },
    { title: 'Schedule approved posts', status: 'todo', priority: 'medium', assignee: emp3Id, dueOffset: 2, estimate: 60 },
    { title: 'Client review — chase pending approvals', status: 'todo', priority: 'urgent', assignee: managerId, dueOffset: -1, key: 'bloom-review' },
    { title: 'Prep influencer seeding list', status: 'todo', priority: 'low', assignee: emp3Id, dueOffset: null },
    { title: 'QA landing page links', status: 'todo', priority: 'low', assignee: emp2Id, dueOffset: 3, estimate: 30 },
    { title: 'Go-live checklist', status: 'todo', priority: 'medium', assignee: managerId, dueOffset: 24, milestoneKey: 'bloom-golive' },
    { title: 'Draft SPF myth-busting post', status: 'done', priority: 'low', assignee: emp2Id, dueOffset: -5, estimate: 60 },
    { title: 'Set up UTM tracking', status: 'in_review', priority: 'medium', assignee: emp3Id, dueOffset: 0, estimate: 45 },
  ];
  await insertTasks(P.bloomLaunch, bloomTasks);

  const auroraTasks: TaskSpec[] = [
    { title: 'Brand audit & moodboard', status: 'done', priority: 'high', assignee: emp1Id, dueOffset: -18, estimate: 180 },
    { title: 'Logo concepts v1', status: 'done', priority: 'high', assignee: emp1Id, dueOffset: -8, estimate: 240 },
    { title: 'Logo concepts v2 (client feedback)', status: 'in_progress', priority: 'urgent', assignee: emp1Id, dueOffset: -2, startOffset: -4, estimate: 180 },
    { title: 'Color + typography system', status: 'in_review', priority: 'high', assignee: emp3Id, dueOffset: 0, estimate: 120 },
    { title: 'Menu redesign layout', status: 'todo', priority: 'medium', assignee: emp3Id, dueOffset: 4, estimate: 150 },
    { title: 'Signage mockups', status: 'todo', priority: 'low', assignee: emp1Id, dueOffset: null },
    { title: 'Social templates', status: 'todo', priority: 'medium', assignee: emp3Id, dueOffset: 6, estimate: 120 },
    { title: 'Brand guidelines doc', status: 'todo', priority: 'medium', assignee: managerId, dueOffset: 8, milestoneKey: 'aurora-logo' },
    { title: 'Stakeholder review deck', status: 'todo', priority: 'high', assignee: managerId, dueOffset: -1 },
    { title: 'Print vendor handoff', status: 'todo', priority: 'low', assignee: emp1Id, dueOffset: null },
  ];
  await insertTasks(P.auroraRebrand, auroraTasks);

  const retainerTasks: TaskSpec[] = [
    { title: 'July: 12 posts delivered', status: 'done', priority: 'medium', assignee: emp2Id, dueOffset: -40 },
    { title: 'July: monthly report', status: 'done', priority: 'low', assignee: emp2Id, dueOffset: -35 },
    { title: 'August: content plan', status: 'done', priority: 'medium', assignee: emp2Id, dueOffset: -10 },
    { title: 'August: 12 posts', status: 'done', priority: 'medium', assignee: emp2Id, dueOffset: -6 },
    { title: 'August: report', status: 'done', priority: 'low', assignee: emp3Id, dueOffset: -4 },
    { title: 'Wrap-up & handover', status: 'done', priority: 'low', assignee: emp2Id, dueOffset: -5 },
  ];
  await insertTasks(P.auroraRetainer, retainerTasks);

  const novafitTasks: TaskSpec[] = [
    { title: 'Campaign brief & goals', status: 'todo', priority: 'high', assignee: managerId, dueOffset: 6 },
    { title: 'Creative concepts', status: 'todo', priority: 'medium', assignee: emp1Id, dueOffset: 12 },
    { title: 'Landing page copy', status: 'todo', priority: 'medium', assignee: emp2Id, dueOffset: 14 },
    { title: 'Influencer shortlist', status: 'todo', priority: 'low', assignee: emp3Id, dueOffset: null },
    { title: 'Media plan & budget', status: 'todo', priority: 'high', assignee: managerId, dueOffset: 10 },
  ];
  await insertTasks(P.novafitApp, novafitTasks);

  const lumenTasks: TaskSpec[] = [
    { title: 'Discovery workshop notes', status: 'done', priority: 'medium', assignee: emp2Id, dueOffset: -40 },
    { title: 'Wireframes', status: 'in_review', priority: 'medium', assignee: emp3Id, dueOffset: -6 },
    { title: 'Listings data import', status: 'todo', priority: 'low', assignee: emp2Id, dueOffset: -2 },
    { title: 'Homepage design', status: 'todo', priority: 'medium', assignee: emp3Id, dueOffset: null },
    { title: 'SEO audit', status: 'todo', priority: 'low', assignee: emp2Id, dueOffset: null },
  ];
  await insertTasks(P.lumenWeb, lumenTasks);

  // -----------------------------------------------------------------
  // 19. TASK LABELS + LINKS, COMMENTS, DEPENDENCIES (Bloom launch)
  // -----------------------------------------------------------------
  console.log('Seeding task labels, comments, dependencies...');
  const bloomLabels = {
    design: newId('lbl'),
    copy: newId('lbl'),
    urgent: newId('lbl'),
  };
  await db.insert(projectTaskLabels).values([
    { id: bloomLabels.design, agencyId, projectId: P.bloomLaunch, name: 'Design', color: 'violet' },
    { id: bloomLabels.copy, agencyId, projectId: P.bloomLaunch, name: 'Copy', color: 'sky' },
    { id: bloomLabels.urgent, agencyId, projectId: P.bloomLaunch, name: 'Urgent', color: 'rose' },
  ]);
  await db.insert(projectTaskLabelLinks).values([
    { agencyId, taskId: taskKeyIds['bloom-shoot-task'], labelId: bloomLabels.design },
    { agencyId, taskId: taskKeyIds['bloom-carousel'], labelId: bloomLabels.design },
    { agencyId, taskId: taskKeyIds['bloom-captions'], labelId: bloomLabels.copy },
    { agencyId, taskId: taskKeyIds['bloom-review'], labelId: bloomLabels.urgent },
  ]);
  await db.insert(projectTaskComments).values([
    {
      id: newId('tcm'),
      agencyId,
      taskId: taskKeyIds['bloom-captions'],
      authorId: managerId,
      body: 'Please keep the SPF claims safe and honest.',
      createdAt: at(-1, 11),
    },
    {
      id: newId('tcm'),
      agencyId,
      taskId: taskKeyIds['bloom-captions'],
      authorId: emp2Id,
      body: 'Done — tightened the copy and fact-checked the SPF numbers.',
      createdAt: at(0, 9, 30),
    },
    {
      id: newId('tcm'),
      agencyId,
      taskId: taskKeyIds['bloom-review'],
      authorId: managerId,
      body: 'Waiting on client approvals — following up today.',
      mentionsJson: JSON.stringify([client1UserId]),
      createdAt: at(0, 10),
    },
  ]);
  await db.insert(projectTaskDependencies).values({
    id: newId('tdp'),
    agencyId,
    projectId: P.bloomLaunch,
    blockerTaskId: taskKeyIds['bloom-shoot-task'],
    blockedTaskId: taskKeyIds['bloom-reel'],
    createdBy: managerId,
  });

  // -----------------------------------------------------------------
  // 20. TIME LOGS (several per employee, last ~7 days incl today) + TIMER
  // -----------------------------------------------------------------
  console.log('Seeding time logs and a running timer...');
  const timeLogPlan: Array<{ user: string; project: string; note: string }> = [
    { user: emp1Id, project: P.bloomLaunch, note: 'Design work' },
    { user: emp2Id, project: P.bloomLaunch, note: 'Copywriting' },
    { user: emp3Id, project: P.auroraRebrand, note: 'Social templates' },
    { user: managerId, project: P.auroraRebrand, note: 'Reviews & client calls' },
  ];
  const minutesByAbsOffset = [45, 90, 120, 150, 180, 210, 240];
  const timeLogRows: Array<typeof timeLogs.$inferInsert> = [];
  for (let i = 0; i < timeLogPlan.length; i++) {
    const plan = timeLogPlan[i];
    for (let o = 0; o >= -6; o--) {
      timeLogRows.push({
        id: newId('tlg'),
        agencyId,
        userId: plan.user,
        projectId: plan.project,
        taskId: null,
        minutes: minutesByAbsOffset[Math.abs(o)],
        workDate: at(o, 12),
        note: plan.note,
        createdAt: at(o, 18),
      });
    }
  }
  await db.insert(timeLogs).values(timeLogRows);

  await db.insert(timers).values({
    id: newId('tmr'),
    agencyId,
    userId: emp1Id,
    projectId: P.bloomLaunch,
    taskId: taskKeyIds['bloom-carousel'],
    startedAt: at(0, 9, 30),
    note: 'Working on the ingredient-science carousel',
  });

  // -----------------------------------------------------------------
  // 21. ATTENDANCE — policy + records + regularization + holidays + leave
  // -----------------------------------------------------------------
  console.log('Seeding attendance policy + records...');
  await db.insert(attendancePolicy).values({
    agencyId,
    timezone: 'Asia/Kolkata',
    workdaysCsv: '1,2,3,4,5',
    saturdayOffWeeksCsv: null,
    shiftStartMin: 540,
    shiftEndMin: 1080,
    fullDayMinutes: 480,
    halfDayMinutes: 240,
    lateGraceMinutes: 15,
    countOvertime: true,
  });

  const attendanceUserIds = [ownerId, adminId, managerId, emp1Id, emp2Id, emp3Id];
  const attendanceRows: Array<typeof attendanceRecords.$inferInsert> = [];
  for (let o = 0; o >= -13; o--) {
    const d = new Date(TODAY);
    d.setUTCDate(d.getUTCDate() + o);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    const day = d.toISOString().slice(0, 10);
    let ui = 0;
    for (const uid of attendanceUserIds) {
      // A couple of people are still checked-in (no checkout) TODAY.
      if (o === 0 && (ui === 0 || ui === 3)) {
        attendanceRows.push({
          id: newId('att'),
          agencyId,
          userId: uid,
          day,
          checkInAt: at(o, 9, 20),
          checkOutAt: null,
          workedMinutes: 0,
          overtimeMinutes: 0,
          status: 'present',
          isLate: false,
          source: 'self',
          checkInIp: '203.0.113.15',
          checkInLocation: 'Sanctum Studio, Mumbai',
        });
        ui++;
        continue;
      }
      const r = (Math.abs(o) + ui) % 6;
      if (r === 5) {
        attendanceRows.push({
          id: newId('att'),
          agencyId,
          userId: uid,
          day,
          checkInAt: at(o, 9, 30),
          checkOutAt: at(o, 13, 30),
          workedMinutes: 240,
          overtimeMinutes: 0,
          status: 'half_day',
          isLate: false,
          source: 'self',
          note: 'Half day',
        });
      } else if (r === 4) {
        attendanceRows.push({
          id: newId('att'),
          agencyId,
          userId: uid,
          day,
          checkInAt: at(o, 9, 40),
          checkOutAt: at(o, 18, 20),
          workedMinutes: 520,
          overtimeMinutes: 40,
          status: 'late',
          isLate: true,
          source: 'self',
        });
      } else {
        attendanceRows.push({
          id: newId('att'),
          agencyId,
          userId: uid,
          day,
          checkInAt: at(o, 9, 5),
          checkOutAt: at(o, 18, 10),
          workedMinutes: 545,
          overtimeMinutes: 65,
          status: 'present',
          isLate: false,
          source: 'self',
        });
      }
      ui++;
    }
  }
  await db.insert(attendanceRecords).values(attendanceRows);

  console.log('Seeding attendance regularization...');
  await db.insert(attendanceRegularizations).values({
    id: newId('reg'),
    agencyId,
    userId: emp3Id,
    day: dayStr(-3),
    type: 'missed_punch',
    requestedCheckInAt: at(-3, 9, 10),
    requestedCheckOutAt: at(-3, 18, 5),
    requestedStatus: 'present',
    reason: 'Forgot to check out — was on a client call.',
    status: 'pending',
  });

  console.log('Seeding holidays...');
  await db.insert(holidays).values([
    { id: newId('hol'), agencyId, day: dayStr(1), name: 'Independence Day', recurring: true, createdBy: adminId },
    { id: newId('hol'), agencyId, day: dayStr(49), name: 'Gandhi Jayanti', recurring: true, createdBy: adminId },
    { id: newId('hol'), agencyId, day: dayStr(86), name: 'Diwali', recurring: false, createdBy: adminId },
  ]);

  console.log('Seeding leave types + requests...');
  const casualTypeId = newId('lvt');
  const sickTypeId = newId('lvt');
  const earnedTypeId = newId('lvt');
  await db.insert(leaveTypes).values([
    { id: casualTypeId, agencyId, name: 'Casual', colorToken: 'sky', paid: true, annualQuota: 12, active: true, sortOrder: 0 },
    { id: sickTypeId, agencyId, name: 'Sick', colorToken: 'rose', paid: true, annualQuota: 12, active: true, sortOrder: 1 },
    { id: earnedTypeId, agencyId, name: 'Earned', colorToken: 'pine', paid: true, annualQuota: 18, active: true, sortOrder: 2 },
  ]);
  await db.insert(leaveRequests).values([
    {
      id: newId('lvr'),
      agencyId,
      userId: emp1Id,
      leaveTypeId: casualTypeId,
      startDay: dayStr(-9),
      endDay: dayStr(-9),
      days: 1,
      reason: 'Personal work.',
      status: 'approved',
      decidedBy: managerId,
      decidedAt: at(-11, 10),
      decisionNote: 'Approved.',
      createdAt: at(-12, 9),
    },
    {
      id: newId('lvr'),
      agencyId,
      userId: emp2Id,
      leaveTypeId: earnedTypeId,
      startDay: dayStr(5),
      endDay: dayStr(6),
      days: 2,
      reason: 'Short trip.',
      status: 'pending',
      createdAt: at(-1, 15),
    },
  ]);

  // -----------------------------------------------------------------
  // 22. EXPENSES (varied categories; amount paise; recent)
  // -----------------------------------------------------------------
  console.log('Seeding expenses...');
  const expenseSeeds: Array<{
    category:
      | 'software'
      | 'salaries'
      | 'marketing'
      | 'travel'
      | 'office'
      | 'equipment'
      | 'contractor'
      | 'taxes'
      | 'utilities'
      | 'other';
    amount: number;
    description: string;
    offset: number;
    clientKey?: string;
    project?: string;
    gstDeductible?: boolean;
  }> = [
    { category: 'software', amount: inr(2499), description: 'Figma team seats', offset: -2, gstDeductible: true },
    { category: 'software', amount: inr(1770), description: 'Cloudinary storage', offset: -5, gstDeductible: true },
    { category: 'marketing', amount: inr(15000), description: 'Bloom launch ad spend', offset: -3, clientKey: 'bloom', project: P.bloomLaunch, gstDeductible: true },
    { category: 'contractor', amount: inr(8000), description: 'Freelance photographer — Bloom shoot', offset: -2, clientKey: 'bloom', project: P.bloomLaunch, gstDeductible: false },
    { category: 'travel', amount: inr(1200), description: 'Client visit — Aurora Cafe', offset: -6, clientKey: 'aurora', gstDeductible: false },
    { category: 'office', amount: inr(3400), description: 'Coworking desk rent', offset: -10, gstDeductible: true },
    { category: 'equipment', amount: inr(52000), description: 'New iMac for design', offset: -14, gstDeductible: true },
    { category: 'utilities', amount: inr(2100), description: 'Internet + phone', offset: -12, gstDeductible: true },
    { category: 'salaries', amount: inr(180000), description: 'August payroll (partial)', offset: -1, gstDeductible: false },
  ];
  for (const e of expenseSeeds) {
    await db.insert(expenses).values({
      id: newId('exp'),
      agencyId,
      projectId: e.project ?? null,
      clientId: e.clientKey ? clientIds[e.clientKey] : null,
      category: e.category,
      amount: e.amount,
      description: e.description,
      expenseDate: at(e.offset, 12),
      gstDeductible: e.gstDeductible ?? false,
      gstAmount: e.gstDeductible ? Math.round(e.amount - e.amount / 1.18) : null,
      loggedBy: adminId,
    });
  }

  // -----------------------------------------------------------------
  // 23. INVOICES + ITEMS + PAYMENTS (status mix; money paise)
  // -----------------------------------------------------------------
  console.log('Seeding invoices...');
  type InvStatus = 'draft' | 'sent' | 'partially_paid' | 'paid' | 'cancelled';
  type PayMethod = 'bank_transfer' | 'upi' | 'cash' | 'card' | 'cheque' | 'other';
  async function insertInvoice(opts: {
    number: string;
    clientId: string;
    projectId?: string | null;
    status: InvStatus;
    issueOffset: number;
    dueOffset: number;
    items: Array<{ description: string; quantity: number; rate: number }>;
    payments?: Array<{ amount: number; method: PayMethod; offset: number; reference?: string }>;
  }): Promise<void> {
    const invId = newId('inv');
    let subtotal = 0;
    const itemRows: Array<typeof invoiceItems.$inferInsert> = opts.items.map((it, i) => {
      const amount = Math.round(it.quantity * it.rate);
      subtotal += amount;
      return {
        id: newId('ini'),
        agencyId,
        invoiceId: invId,
        description: it.description,
        quantity: it.quantity,
        unit: 'piece',
        rate: it.rate,
        gstRate: 18,
        amount,
        position: i,
      };
    });
    const taxTotal = Math.round(subtotal * 0.18);
    const cgst = Math.round(taxTotal / 2);
    const sgst = taxTotal - cgst;
    const total = subtotal + taxTotal;
    await db.insert(invoices).values({
      id: invId,
      agencyId,
      clientId: opts.clientId,
      projectId: opts.projectId ?? null,
      invoiceNumber: opts.number,
      status: opts.status,
      issueDate: at(opts.issueOffset, 10),
      dueDate: at(opts.dueOffset, 10),
      isInterstate: false,
      currency: 'INR',
      subtotal,
      taxTotal,
      cgst,
      sgst,
      igst: 0,
      total,
      notes: 'Thank you for your business.',
      terms: 'Payment due within the stated period.',
      bankDetails: 'Sanctum Studio • HDFC Bank • A/C 50100XXXXXX • IFSC HDFC0000123',
      createdBy: adminId,
      createdAt: at(opts.issueOffset, 10),
    });
    await db.insert(invoiceItems).values(itemRows);
    for (const p of opts.payments ?? []) {
      await db.insert(invoicePayments).values({
        id: newId('pay'),
        agencyId,
        invoiceId: invId,
        amount: p.amount,
        paidAt: at(p.offset, 12),
        method: p.method,
        reference: p.reference ?? null,
        recordedBy: adminId,
      });
    }
  }

  // Bloom — one paid, one sent.
  await insertInvoice({
    number: 'INV-2026-001',
    clientId: clientIds.bloom,
    projectId: P.bloomLaunch,
    status: 'paid',
    issueOffset: -35,
    dueOffset: -20,
    items: [{ description: 'Monthly social media retainer — July', quantity: 1, rate: inr(45000) }],
    payments: [{ amount: inr(53100), method: 'bank_transfer', offset: -22, reference: 'NEFT-778812' }],
  });
  await insertInvoice({
    number: 'INV-2026-002',
    clientId: clientIds.bloom,
    projectId: P.bloomLaunch,
    status: 'sent',
    issueOffset: -4,
    dueOffset: 11,
    items: [
      { description: 'Skincare launch — creative production', quantity: 1, rate: inr(60000) },
      { description: 'Ad management fee', quantity: 1, rate: inr(15000) },
    ],
  });

  // Aurora — one partially paid, one draft.
  await insertInvoice({
    number: 'INV-2026-003',
    clientId: clientIds.aurora,
    projectId: P.auroraRebrand,
    status: 'partially_paid',
    issueOffset: -18,
    dueOffset: 12,
    items: [{ description: 'Cafe rebrand — design & identity', quantity: 1, rate: inr(80000) }],
    payments: [{ amount: inr(50000), method: 'upi', offset: -10, reference: 'UPI-AUR-2201' }],
  });
  await insertInvoice({
    number: 'INV-2026-004',
    clientId: clientIds.aurora,
    projectId: P.auroraRetainer,
    status: 'draft',
    issueOffset: -1,
    dueOffset: 29,
    items: [{ description: 'Q3 content retainer — August', quantity: 1, rate: inr(35000) }],
  });

  // -----------------------------------------------------------------
  // 24. DOCUMENTS (client-visible + internal + external gdrive/onedrive)
  // -----------------------------------------------------------------
  console.log('Seeding documents...');
  const CLD = 'https://res.cloudinary.com/dkqo3uz5o/raw/upload/v1/demo';
  await db.insert(documents).values([
    {
      id: newId('doc'),
      agencyId,
      name: 'Master Services Agreement — Bloom.pdf',
      category: 'contract',
      clientId: clientIds.bloom,
      fileUrl: `${CLD}/bloom-msa.pdf`,
      publicId: 'demo/bloom-msa',
      resourceType: 'raw',
      format: 'pdf',
      mimeType: 'application/pdf',
      sizeBytes: 248320,
      clientVisible: true,
      uploadedBy: adminId,
    },
    {
      id: newId('doc'),
      agencyId,
      name: 'NDA — Aurora Cafe.pdf',
      category: 'nda',
      clientId: clientIds.aurora,
      fileUrl: `${CLD}/aurora-nda.pdf`,
      publicId: 'demo/aurora-nda',
      resourceType: 'raw',
      format: 'pdf',
      mimeType: 'application/pdf',
      sizeBytes: 112004,
      clientVisible: false,
      uploadedBy: adminId,
    },
    {
      id: newId('doc'),
      agencyId,
      name: 'Summer Launch Proposal — Bloom.pdf',
      category: 'proposal',
      clientId: clientIds.bloom,
      projectId: P.bloomLaunch,
      fileUrl: `${CLD}/bloom-proposal.pdf`,
      publicId: 'demo/bloom-proposal',
      resourceType: 'raw',
      format: 'pdf',
      mimeType: 'application/pdf',
      sizeBytes: 402210,
      clientVisible: true,
      uploadedBy: managerId,
    },
    {
      id: newId('doc'),
      agencyId,
      name: 'Brand Guidelines (Google Drive)',
      category: 'design',
      clientId: clientIds.aurora,
      projectId: P.auroraRebrand,
      fileUrl: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view',
      publicId: null,
      resourceType: 'raw',
      format: 'gdrive',
      mimeType: null,
      sizeBytes: 0,
      clientVisible: true,
      uploadedBy: emp1Id,
    },
    {
      id: newId('doc'),
      agencyId,
      name: 'August Performance Report — Bloom.pdf',
      category: 'report',
      clientId: clientIds.bloom,
      projectId: P.bloomLaunch,
      fileUrl: `${CLD}/bloom-aug-report.pdf`,
      publicId: 'demo/bloom-aug-report',
      resourceType: 'raw',
      format: 'pdf',
      mimeType: 'application/pdf',
      sizeBytes: 322114,
      clientVisible: true,
      uploadedBy: emp3Id,
    },
    {
      id: newId('doc'),
      agencyId,
      name: 'Final Deliverables (OneDrive)',
      category: 'deliverable',
      clientId: clientIds.aurora,
      fileUrl: 'https://1drv.ms/f/s!AkExampleOneDriveShareLink',
      publicId: null,
      resourceType: 'raw',
      format: 'onedrive',
      mimeType: null,
      sizeBytes: 0,
      clientVisible: true,
      uploadedBy: managerId,
    },
    {
      id: newId('doc'),
      agencyId,
      name: 'Internal — Payroll notes.xlsx',
      category: 'misc',
      fileUrl: `${CLD}/payroll-notes.xlsx`,
      publicId: 'demo/payroll-notes',
      resourceType: 'raw',
      format: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: 88123,
      clientVisible: false,
      uploadedBy: adminId,
    },
    {
      id: newId('doc'),
      agencyId,
      name: 'Ad Creative v2.png',
      category: 'design',
      clientId: clientIds.bloom,
      projectId: P.bloomLaunch,
      fileUrl: 'https://res.cloudinary.com/dkqo3uz5o/image/upload/v1/demo/ad-creative-v2.png',
      publicId: 'demo/ad-creative-v2',
      resourceType: 'image',
      format: 'png',
      mimeType: 'image/png',
      sizeBytes: 540210,
      clientVisible: false,
      uploadedBy: emp1Id,
    },
  ]);

  // -----------------------------------------------------------------
  // 25. SHEETS (lightweight spreadsheet)
  // -----------------------------------------------------------------
  console.log('Seeding sheets...');
  await db.insert(sheets).values({
    id: newId('sht'),
    agencyId,
    title: 'Content Tracker — August',
    clientId: clientIds.bloom,
    projectId: P.bloomLaunch,
    data: JSON.stringify({
      columns: ['Date', 'Platform', 'Type', 'Status'],
      rows: [
        ['Aug 06', 'Instagram', 'Carousel', 'Posted'],
        ['Aug 09', 'Instagram', 'Reel', 'Posted'],
        ['Aug 16', 'Instagram', 'Post', 'Scheduled'],
      ],
    }),
    createdBy: emp2Id,
  });

  // -----------------------------------------------------------------
  // 26. NOTIFICATIONS
  // -----------------------------------------------------------------
  console.log('Seeding notifications...');
  await db.insert(notifications).values([
    {
      id: newId('ntf'),
      agencyId,
      userId: emp1Id,
      type: 'leave.approved',
      title: 'Leave approved',
      body: 'Your casual leave was approved.',
      entityType: 'leave_request',
      link: '/attendance',
      readAt: at(-10, 10),
      createdAt: at(-11, 10),
    },
    {
      id: newId('ntf'),
      agencyId,
      userId: managerId,
      type: 'task.assigned',
      title: 'New task assigned',
      body: 'Client review — chase pending approvals.',
      entityType: 'project_task',
      link: '/projects',
      createdAt: at(-1, 9),
    },
    {
      id: newId('ntf'),
      agencyId,
      userId: emp2Id,
      type: 'task.comment',
      title: 'New comment on your task',
      body: 'Rahul commented on "Write captions for launch week".',
      entityType: 'project_task',
      link: '/projects',
      createdAt: at(-1, 11, 1),
    },
  ]);

  // -----------------------------------------------------------------
  // 27. CONTENT POSTS + MEDIA + PORTAL TOKENS + COMMENTS + APPROVALS
  // -----------------------------------------------------------------
  console.log('Seeding content posts...');
  const postSeeds: Array<{
    clientKey: 'bloom' | 'aurora';
    type: PostType;
    caption: string;
    platforms: string[];
    dayOffset: number;
    status: PostStatus;
    createdBy: string;
  }> = [
    { clientKey: 'bloom', type: 'carousel', caption: '5 ingredients your moisturizer should never have. Swipe to glow-proof your shelf.', platforms: ['instagram', 'facebook'], dayOffset: -8, status: 'posted', createdBy: emp2Id },
    { clientKey: 'bloom', type: 'reel', caption: 'POV: your 60-second morning routine that actually sticks.', platforms: ['instagram'], dayOffset: -5, status: 'posted', createdBy: emp1Id },
    { clientKey: 'bloom', type: 'post', caption: 'Hyaluronic acid 101: it hydrates, it plumps, it loves you back.', platforms: ['instagram', 'facebook'], dayOffset: 2, status: 'scheduled', createdBy: emp2Id },
    { clientKey: 'bloom', type: 'carousel', caption: 'Before / after: 4 weeks of consistent niacinamide.', platforms: ['instagram', 'facebook'], dayOffset: 4, status: 'approved', createdBy: emp1Id },
    { clientKey: 'bloom', type: 'reel', caption: 'New drop: the Midnight Repair Serum is back in stock.', platforms: ['instagram'], dayOffset: 6, status: 'pending_approval', createdBy: emp2Id },
    { clientKey: 'bloom', type: 'post', caption: 'Myth vs fact: does drinking water clear your skin?', platforms: ['instagram'], dayOffset: 8, status: 'changes_requested', createdBy: emp2Id },
    { clientKey: 'bloom', type: 'story', caption: 'Flash poll: oily, dry, or combination?', platforms: ['instagram'], dayOffset: 10, status: 'draft', createdBy: emp3Id },
    { clientKey: 'aurora', type: 'post', caption: 'The croissant that started it all. 36 hours of lamination.', platforms: ['instagram', 'facebook'], dayOffset: -6, status: 'posted', createdBy: emp3Id },
    { clientKey: 'aurora', type: 'reel', caption: 'How we plate the matcha tiramisu in 4 moves.', platforms: ['instagram'], dayOffset: 3, status: 'approved', createdBy: emp3Id },
    { clientKey: 'aurora', type: 'carousel', caption: 'A walk through our new summer menu.', platforms: ['instagram', 'facebook'], dayOffset: 5, status: 'scheduled', createdBy: emp3Id },
  ];
  let bloomPendingPostId = '';
  let bloomChangesPostId = '';
  let auroraApprovedPostId = '';
  for (const p of postSeeds) {
    const id = newId('pst');
    await db.insert(contentPosts).values({
      id,
      agencyId,
      clientId: clientIds[p.clientKey],
      postType: p.type,
      caption: p.caption,
      platformsJson: JSON.stringify(p.platforms),
      scheduledAt: at(p.dayOffset, 10),
      status: p.status,
      createdBy: p.createdBy,
    });
    if (p.clientKey === 'bloom' && p.status === 'pending_approval' && !bloomPendingPostId) bloomPendingPostId = id;
    if (p.clientKey === 'bloom' && p.status === 'changes_requested' && !bloomChangesPostId) bloomChangesPostId = id;
    if (p.clientKey === 'aurora' && p.status === 'approved' && !auroraApprovedPostId) auroraApprovedPostId = id;
  }

  console.log('Seeding post media...');
  const mediaTargets = [
    { postId: bloomPendingPostId, clientId: clientIds.bloom, publicId: 'demo/bloom-serum', bytes: 184320, w: 1080, h: 1350 },
    { postId: bloomChangesPostId, clientId: clientIds.bloom, publicId: 'demo/bloom-glowkit', bytes: 220114, w: 1080, h: 1080 },
    { postId: auroraApprovedPostId, clientId: clientIds.aurora, publicId: 'demo/aurora-tiramisu', bytes: 312050, w: 1080, h: 1920 },
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
      secureUrl: 'https://res.cloudinary.com/dkqo3uz5o/image/upload/v1/demo/sample.jpg',
      resourceType: 'image',
      format: 'jpg',
      bytes: m.bytes,
      width: m.w,
      height: m.h,
      position: mediaPos++,
    });
  }

  console.log('Seeding portal tokens...');
  const portalLinks: { client: string; rawToken: string; url: string }[] = [];
  const bloomTokenId = newId('ptk');
  const bloomToken = newOpaqueToken();
  await db.insert(portalTokens).values({
    id: bloomTokenId,
    agencyId,
    clientId: clientIds.bloom,
    tokenHash: bloomToken.hash,
    label: 'Bloom Digital — client review link',
    createdBy: ownerId,
    revoked: false,
  });
  portalLinks.push({ client: 'Bloom Digital', rawToken: bloomToken.raw, url: `http://localhost:3000/portal/${bloomToken.raw}` });

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
  portalLinks.push({ client: 'Aurora Cafe', rawToken: auroraToken.raw, url: `http://localhost:3000/portal/${auroraToken.raw}` });

  console.log('Seeding post comments + approvals...');
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
      createdAt: at(3, 16, 30),
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
      createdAt: at(3, 16, 31),
    });
  }
  if (bloomChangesPostId) {
    await db.insert(postComments).values({
      id: newId('cmt'),
      agencyId,
      clientId: clientIds.bloom,
      postId: bloomChangesPostId,
      authorType: 'client',
      portalTokenId: bloomTokenId,
      authorLabel: 'Bloom Digital',
      body: 'Can we soften the wording and swap the second image? Otherwise great.',
      createdAt: at(-1, 11, 12),
    });
    await db.insert(postApprovals).values({
      id: newId('apr'),
      agencyId,
      clientId: clientIds.bloom,
      postId: bloomChangesPostId,
      portalTokenId: bloomTokenId,
      decision: 'changes_requested',
      note: 'Swap the second image; tweak the wording.',
      actorLabel: 'Bloom Digital',
      ip: '198.51.100.7',
      createdAt: at(-1, 11, 13),
    });
  }
  if (bloomPendingPostId) {
    await db.insert(postComments).values({
      id: newId('cmt'),
      agencyId,
      clientId: clientIds.bloom,
      postId: bloomPendingPostId,
      authorType: 'user',
      authorUserId: emp2Id,
      authorLabel: 'Vikram Rao',
      body: 'Caption tightened and SPF claim double-checked. Ready for client review.',
      createdAt: at(-1, 14, 5),
    });
  }

  // -----------------------------------------------------------------
  // 28. BRAND STRATEGY (per client)
  // -----------------------------------------------------------------
  console.log('Seeding brand strategy...');
  await db.insert(brandStrategy).values([
    {
      id: newId('bst'),
      agencyId,
      clientId: clientIds.bloom,
      tone: 'Warm, expert, and reassuring — like a friend who happens to be a dermatologist.',
      audience: 'Women 22-38, skincare-curious, value science over hype.',
      pillarsJson: JSON.stringify(['Education', 'Routine-building', 'Product spotlights', 'Real results']),
      dos: 'Cite ingredients by name; show real before/afters; keep claims honest.',
      donts: 'No fearmongering, no "miracle" language, never promise to "cure".',
      notes: 'Lead with value, sell second.',
      updatedBy: adminId,
    },
    {
      id: newId('bst'),
      agencyId,
      clientId: clientIds.aurora,
      tone: 'Cozy, playful, and a little indulgent.',
      audience: 'Local foodies 18-45 who love aesthetic cafes and weekend brunches.',
      pillarsJson: JSON.stringify(['Behind the bake', 'Menu spotlights', 'Cafe moments', 'Community']),
      dos: 'Show process and people; use warm natural light.',
      donts: 'No stocky food photos; avoid over-editing.',
      notes: 'Sound on for reels — ASMR performs well.',
      updatedBy: managerId,
    },
  ]);

  // -----------------------------------------------------------------
  // 29. CREDENTIALS VAULT (encrypted, AES-256-GCM)
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
  // 30. AI GENERATIONS + USAGE COUNTERS
  // -----------------------------------------------------------------
  console.log('Seeding AI generations + usage counters...');
  await db.insert(aiGenerations).values([
    {
      id: newId('aig'),
      agencyId,
      clientId: clientIds.bloom,
      requestedBy: adminId,
      period: PERIOD,
      status: 'succeeded',
      model: 'claude-sonnet-4-5',
      promptSummary: 'Generate a month of skincare content for Bloom Digital.',
      postsCreated: 7,
      inputTokens: 1820,
      outputTokens: 4410,
      createdAt: at(-9, 8, 30),
      completedAt: at(-9, 8, 31),
    },
    {
      id: newId('aig'),
      agencyId,
      clientId: clientIds.aurora,
      requestedBy: managerId,
      period: PERIOD,
      status: 'succeeded',
      model: 'claude-sonnet-4-5',
      promptSummary: 'Draft cafe reels captions for Aurora.',
      postsCreated: 3,
      inputTokens: 900,
      outputTokens: 2100,
      createdAt: at(-4, 9, 0),
      completedAt: at(-4, 9, 1),
    },
  ]);
  const storageUsed = mediaTargets.filter((m) => m.postId).reduce((s, m) => s + m.bytes, 0);
  await db.insert(usageCounters).values({
    agencyId,
    period: PERIOD,
    aiGenerationsUsed: 2,
    storageBytesUsed: storageUsed,
  });

  // -----------------------------------------------------------------
  // 31. INVITE (one pending staff invite)
  // -----------------------------------------------------------------
  console.log('Seeding invite...');
  await db.insert(invites).values({
    id: newId('inv2'),
    agencyId,
    email: 'newhire@sanctum.test',
    role: 'member',
    tokenHash: newOpaqueToken().hash,
    invitedBy: ownerId,
    status: 'pending',
    expiresAt: at(7, 10),
    createdAt: at(-1, 10),
  });

  // -----------------------------------------------------------------
  // 32. AUDIT LOG
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
      createdAt: at(0, 8, 30),
    },
    {
      id: newId('aud'),
      agencyId,
      actorType: 'admin',
      actorId: adminId,
      action: 'invoice.create',
      entityType: 'invoice',
      entityId: null,
      metadataJson: JSON.stringify({ number: 'INV-2026-002' }),
      ip: '203.0.113.11',
      createdAt: at(-4, 10, 5),
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
      createdAt: at(3, 16, 31),
    },
  ]);

  // -----------------------------------------------------------------
  // 33. MESSAGING — one small thread
  // -----------------------------------------------------------------
  console.log('Seeding message thread...');
  const threadId = newId('thr');
  await db.insert(messageThreads).values({
    id: threadId,
    agencyId,
    subject: 'Bloom — August content review',
    clientId: clientIds.bloom,
    projectId: P.bloomLaunch,
    status: 'open',
    createdBy: managerId,
    lastMessageAt: at(0, 10, 30),
    lastMessagePreview: 'Perfect, scheduling the approved ones now.',
    createdAt: at(-2, 9),
  });
  await db.insert(threadParticipants).values([
    { id: newId('tpp'), agencyId, threadId, userId: managerId, lastReadAt: at(0, 10, 31) },
    { id: newId('tpp'), agencyId, threadId, userId: emp1Id, lastReadAt: at(0, 10, 30) },
    { id: newId('tpp'), agencyId, threadId, userId: emp2Id, lastReadAt: at(-1, 18, 0) },
  ]);
  await db.insert(messages).values([
    { id: newId('msg'), agencyId, threadId, senderId: managerId, body: 'Where are we on the launch-week captions?', createdAt: at(-2, 9, 0) },
    { id: newId('msg'), agencyId, threadId, senderId: emp2Id, body: 'Drafted — tightening the SPF claims now.', createdAt: at(-1, 16, 0) },
    { id: newId('msg'), agencyId, threadId, senderId: emp1Id, body: 'Carousel visuals are 80% done, sending previews EOD.', createdAt: at(0, 10, 15) },
    { id: newId('msg'), agencyId, threadId, senderId: managerId, body: 'Perfect, scheduling the approved ones now.', createdAt: at(0, 10, 30) },
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
    'custom_roles',
    'users',
    'invites',
    'clients',
    'client_assignments',
    'client_user_projects',
    'client_contacts',
    'client_notes',
    'client_tags',
    'client_tag_links',
    'deals',
    'leads',
    'lead_activities',
    'projects',
    'project_members',
    'project_milestones',
    'project_tasks',
    'task_assignees',
    'project_task_labels',
    'project_task_label_links',
    'project_task_comments',
    'project_task_dependencies',
    'time_logs',
    'timers',
    'attendance_policy',
    'attendance_records',
    'attendance_regularizations',
    'holidays',
    'leave_types',
    'leave_requests',
    'notifications',
    'expenses',
    'invoices',
    'invoice_items',
    'invoice_payments',
    'documents',
    'sheets',
    'message_threads',
    'thread_participants',
    'messages',
    'content_posts',
    'post_media',
    'portal_tokens',
    'post_comments',
    'post_approvals',
    'brand_strategy',
    'credentials_vault',
    'ai_generations',
    'usage_counters',
    'audit_log',
  ];
  for (const name of tableNames) {
    const full = `${prefix}${name}`;
    const r = await libsql.execute(`SELECT count(*) AS n FROM "${full}"`);
    const n = r.rows[0]?.n ?? 0;
    console.log(`  ${full.padEnd(34)} ${n}`);
  }

  // -----------------------------------------------------------------
  // PRINT — per-role credentials table.
  // -----------------------------------------------------------------
  console.log('\n========================= SANCTUM STUDIO — SEED CREDENTIALS =========================');
  console.log('All passwords: Sanctum@123    |    Frontend: http://localhost:3000\n');
  const header = `${'EMAIL'.padEnd(24)}${'PASSWORD'.padEnd(14)}${'ROLE / PERSONA'.padEnd(28)}SCOPE`;
  console.log(header);
  console.log('-'.repeat(header.length + 20));
  const credRows: Array<[string, string, string, string]> = [
    ['owner@sanctum.test', 'Sanctum@123', 'owner — Arjun Mehta', 'Full access (agency owner, immutable)'],
    ['admin@sanctum.test', 'Sanctum@123', 'admin — Priya Sharma', 'All modules incl. finance & settings'],
    ['manager@sanctum.test', 'Sanctum@123', 'member + Manager role', 'Delivery; no finance/settings'],
    ['emp1@sanctum.test', 'Sanctum@123', 'member + Employee role', 'Sneha Iyer — edit tasks/calendar/docs'],
    ['emp2@sanctum.test', 'Sanctum@123', 'member + Employee role', 'Vikram Rao — edit tasks/calendar/docs'],
    ['emp3@sanctum.test', 'Sanctum@123', 'member + Employee role', 'Ananya Gupta — edit tasks/calendar/docs'],
    ['client1@sanctum.test', 'Sanctum@123', 'client — Bloom Digital', 'Portal: ALL of Bloom’s projects'],
    ['client2@sanctum.test', 'Sanctum@123', 'client — Aurora Cafe', 'Portal: scoped to ONE project (Cafe Rebrand)'],
  ];
  for (const [e, p, r, s] of credRows) {
    console.log(`${e.padEnd(24)}${p.padEnd(14)}${r.padEnd(28)}${s}`);
  }

  console.log('\nClient portal share links (raw token shown once — demo only):');
  for (const link of portalLinks) {
    console.log(`  ${link.client}:`);
    console.log(`    raw token: ${link.rawToken}`);
    console.log(`    share URL: ${link.url}`);
  }
  console.log('=====================================================================================\n');
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
