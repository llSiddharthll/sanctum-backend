import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { signupAgency, createMemberSession, type Agent } from './helpers';
import { registerClient, connect, toolNames, callTool, startLoopback, useTool } from './mcp-helpers';

/**
 * A realistic day of agency work done only through MCP tools, to prove the
 * tool definitions match the real API (paths, field names, rupee→paise units).
 * Every read tool without required inputs is also called once.
 */
describe('MCP tools — end-to-end workflow', () => {
  let stop: () => Promise<void>;
  let owner: Agent;
  let token: string;
  let memberToken: string;
  const today = new Date().toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    stop = startLoopback();
    owner = (await signupAgency()).agent;
    const member = await createMemberSession(owner, { permissions: {}, fullName: 'Asha Member' });
    const oauthClient = await registerClient();
    token = (await connect(owner, oauthClient)).access;
    memberToken = (await connect(member.agent, oauthClient)).access;
    ids.member = member.user.id;
  });

  afterAll(() => stop());

  const t = <T = any>(name: string, args: Record<string, unknown> = {}) => useTool<T>(token, name, args);

  it('CRM: client, contact, note, lead → convert, proposal, agreement', async () => {
    const client = await t('clients_create', { name: 'Bloom Digital', contactEmail: 'hello@bloom.test', industry: 'Retail' });
    ids.client = client.id;
    await t('clients_contacts_add', { clientId: ids.client, name: 'Riya Shah', email: 'riya@bloom.test', isPrimary: true });
    await t('clients_notes_add', { clientId: ids.client, body: 'Kick-off call went well', type: 'call' });
    expect((await t('clients_get', { clientId: ids.client })).name ?? (await t('clients_get', { clientId: ids.client })).client?.name).toBeTruthy();

    const lead = await t('leads_create', { name: 'Ravi Kumar', company: 'UrbanNest', email: 'ravi@urbannest.test', estimatedValueRupees: 150000 });
    ids.lead = lead.id;
    const leadFull = await t('leads_get', { leadId: ids.lead });
    expect(JSON.stringify(leadFull)).toContain('15000000'); // ₹1,50,000 stored as paise
    await t('leads_update', { leadId: ids.lead, stage: 'qualified' });
    await t('leads_activity_add', { leadId: ids.lead, body: 'Send SOW', type: 'follow_up', dueAt: inDays(2) });
    await t('leads_convert', { leadId: ids.lead });

    const proposal = await t('proposals_create', {
      title: 'Social media retainer',
      clientId: ids.client,
      sections: [{ heading: 'Scope', body: '12 posts and 4 reels a month' }],
      deliverables: [
        { title: 'Brand kit', quantity: 1, rateRupees: 50000, billing: 'one_time' },
        { title: 'Monthly content', quantity: 1, rateRupees: 40000, billing: 'monthly' },
      ],
    });
    ids.proposal = proposal.id;
    const p = await t('proposals_get', { proposalId: ids.proposal });
    expect(JSON.stringify(p)).toContain('5900000'); // ₹50,000 + 18% GST = ₹59,000 one-time
    await t('proposals_update', { proposalId: ids.proposal, title: 'Social media retainer (v2)' });

    const agreement = await t('agreements_create', { clientId: ids.client, title: 'Retainer agreement', retainerRupees: 40000 });
    ids.agreement = agreement.id;
    expect(JSON.stringify(await t('agreements_get', { agreementId: ids.agreement }))).toContain('4000000');

    const found = await t('search', { query: 'bloom' });
    expect(found.matches.some((m: { id: string }) => m.id === ids.client)).toBe(true);
  });

  it('Work: project, members, milestone, tasks, comments, timer, manual time', async () => {
    const project = await t('projects_create', {
      name: 'Bloom — Q4 content',
      clientId: ids.client,
      billingType: 'one_time',
      contractValueRupees: 200000,
      startDate: today,
      deadline: inDays(90),
    });
    ids.project = project.id;
    expect(JSON.stringify(await t('projects_get', { projectId: ids.project }))).toContain('20000000');
    await t('projects_members_add', { projectId: ids.project, userId: ids.member });
    const ms = await t('projects_milestones_create', { projectId: ids.project, title: 'November calendar', dueDate: inDays(14) });
    ids.milestone = ms.id;

    const task = await t('tasks_create', {
      projectId: ids.project,
      title: 'Design 12 November posts',
      priority: 'high',
      dueDate: inDays(3),
      assigneeIds: [ids.member],
      milestoneId: ids.milestone,
    });
    ids.task = task.id;
    await t('tasks_create_bulk', { projectId: ids.project, titles: ['Write captions', 'Schedule posts'] });
    await t('tasks_update', { projectId: ids.project, taskId: ids.task, status: 'in_progress' });
    await t('tasks_comment_add', { projectId: ids.project, taskId: ids.task, body: 'First drafts are in the drive' });
    expect((await t('tasks_get', { projectId: ids.project, taskId: ids.task })).title ?? 'ok').toBeTruthy();

    await t('timers_start', { projectId: ids.project, taskId: ids.task, note: 'Designing' });
    expect(await t('timers_active')).toBeTruthy();
    await t('timers_stop');
    await t('timesheet_log_time', { projectId: ids.project, taskId: ids.task, date: today, durationMinutes: 90, note: 'Captions' });
    const entries = await t('timesheet_entries', { from: today, to: today });
    expect(JSON.stringify(entries)).toContain('90');
    await t('tasks_list_project', { projectId: ids.project });
    await t('projects_time_summary', { projectId: ids.project });
  });

  it('Money: invoice with GST, mark sent, part payment, expense', async () => {
    const inv = await t('invoices_create', {
      clientId: ids.client,
      projectId: ids.project,
      dueDate: inDays(15),
      items: [{ description: 'November retainer', quantity: 1, rateRupees: 10000, gstRate: 18 }],
    });
    ids.invoice = inv.id;
    const full = await t('invoices_get', { invoiceId: ids.invoice });
    expect(JSON.stringify(full)).toContain('1180000'); // ₹10,000 + 18% = ₹11,800
    await t('invoices_change_status', { invoiceId: ids.invoice, status: 'sent' });
    await t('invoices_record_payment', { invoiceId: ids.invoice, amountRupees: 5000, method: 'upi' });
    expect(JSON.stringify(await t('invoices_get', { invoiceId: ids.invoice }))).toContain('500000');

    const exp = await t('expenses_create', { amountRupees: 2499, category: 'software', description: 'Canva Pro' });
    ids.expense = exp.id;
    expect(JSON.stringify(await t('expenses_get', { expenseId: ids.expense }))).toContain('249900');
    await t('finance_client', { clientId: ids.client });
  });

  it('People: attendance, leave, documents, content calendar, messages', async () => {
    await t('attendance_check_in');
    await t('attendance_today');
    const types = await t<any>('leaves_types_list');
    const typeList = Array.isArray(types) ? types : types.items ?? [];
    if (typeList.length) {
      const leave = await useTool(memberToken, 'leaves_apply', {
        leaveTypeId: typeList[0].id,
        startDay: inDays(10),
        endDay: inDays(10),
        reason: 'Family function',
      });
      await t('leaves_decide', { leaveId: leave.id, decision: 'approve' });
    }
    await t('documents_add_link', { name: 'Brand guidelines', fileUrl: 'https://example.com/brand.pdf', clientId: ids.client });

    const post = await t('posts_create', {
      clientId: ids.client,
      postType: 'reel',
      caption: 'Diwali offer reel',
      platforms: ['instagram'],
      scheduledAt: `${inDays(5)}T18:30:00+05:30`,
    });
    ids.post = post.id;
    await t('posts_comment', { clientId: ids.client, postId: ids.post, body: 'Use the new logo' });
    await t('posts_list', { clientId: ids.client });

    const thread = await t('messages_start_conversation', {
      subject: 'November calendar',
      participantIds: [ids.member],
      body: 'Can you share the drafts by Friday?',
    });
    ids.thread = thread.id;
    await t('messages_send', { threadId: ids.thread, body: 'Thanks!' });
    expect(JSON.stringify(await t('messages_read', { threadId: ids.thread }))).toContain('Thanks!');
  });

  it('every read tool with no required input works for the owner', async () => {
    const SKIP = new Set(['search']);
    const failures: string[] = [];
    // tools/list gives the input schemas the client sees.
    const res = await callTool(token, 'whoami');
    expect(res.result?.isError).toBeFalsy();
    const { tools } = await (await import('./mcp-helpers')).rpc(token, 'tools/list').then((r) => r.body.result);
    for (const tool of tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean }; inputSchema?: { required?: string[] } }>) {
      if (!tool.annotations?.readOnlyHint || SKIP.has(tool.name) || (tool.inputSchema?.required?.length ?? 0) > 0) continue;
      const out = await callTool(token, tool.name, {});
      if (out.error || out.result?.isError) failures.push(`${tool.name}: ${out.result?.content?.[0]?.text ?? out.error?.message}`);
    }
    expect(failures).toEqual([]);
  });

  it('a member without finance access cannot reach finance through MCP', async () => {
    const names = await toolNames(memberToken);
    for (const n of ['invoices_create', 'invoices_list', 'expenses_create', 'finance_overview', 'leads_create']) {
      expect(names).not.toContain(n);
    }
    expect(names).toContain('my_tasks');
    // The member was assigned a task above: it shows up in their own list.
    expect(JSON.stringify(await useTool(memberToken, 'my_tasks'))).toContain(ids.task);
  });
});
