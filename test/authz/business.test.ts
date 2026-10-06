import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import { eq } from 'drizzle-orm';
import {
  app,
  BASE,
  createMemberSession,
  data,
  signupAgency,
  type Agent,
  type SignupResult,
} from '../helpers';
import { db } from '../../src/db/client.js';
import { documentLinks, proposals } from '../../src/db/schema.js';
import { env } from '../../src/env.js';
import type { Grant } from '../../src/authz/catalog.js';

const g = (permission: string, scope: Grant['scope'] = 'organization'): Grant => ({ permission, scope });
const anon = () => supertest(app);
const tokenOf = (url: string) => String(url).split('/').pop()!;

describe('authz: business & finance', () => {
  let tenant: SignupResult;
  let owner: Agent;
  let clientId: string;

  beforeAll(async () => {
    tenant = await signupAgency();
    owner = tenant.agent;
    clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Biz Co', contactEmail: 'biz@client.test' })).id;
  });

  async function sentProposal(extra: Record<string, unknown> = {}) {
    const p = data(
      await owner.post(`${BASE}/proposals`).send({
        title: 'Priced',
        clientId,
        subtotalPaise: 100_000,
        totalPaise: 118_000,
        content: { sections: [{ heading: 'Scope', html: 'x' }], deliverables: [{ title: 'SEO', pricePaise: 100_000 }] },
        ...extra,
      }),
    );
    const sent = await owner.post(`${BASE}/proposals/${p.id}/send`).send({ recipientEmail: 'buyer@client.test' });
    expect(sent.status).toBe(200);
    return { id: p.id as string, token: tokenOf(data(sent).publicUrl) };
  }

  async function sentAgreement() {
    const a = data(
      await owner.post(`${BASE}/agreements`).send({ title: 'MSA', clientId, terms: { scope: 'w', clauses: ['c'] } }),
    );
    const sent = await owner.post(`${BASE}/agreements/${a.id}/send`).send({ recipientEmail: 'buyer@client.test' });
    expect(sent.status).toBe(200);
    return { id: a.id as string, token: tokenOf(data(sent).signUrl) };
  }

  it('an Accountant (template role) manages invoices and expenses but not leads or proposals', async () => {
    const role = await owner.post(`${BASE}/roles`).send({ name: 'Accountant', templateKey: 'accountant' });
    expect(role.status).toBe(201);
    const acct = await createMemberSession(owner, { roleIds: [data(role).id] });

    const inv = await acct.agent.post(`${BASE}/invoices`).send({
      clientId,
      items: [{ description: 'Retainer', quantity: 1, rate: 100_000, gstRate: 18 }],
    });
    expect(inv.status).toBe(201);
    expect(data(inv).total).toBe(118_000); // invoices.view shows amounts
    expect(data(inv).capabilities['invoices.record_payment']).toBe(true);
    expect((await acct.agent.get(`${BASE}/invoices`)).status).toBe(200);

    const exp = await acct.agent.post(`${BASE}/expenses`).send({ amount: 5_000, category: 'software' });
    expect(exp.status).toBe(201);
    expect((await acct.agent.patch(`${BASE}/expenses/${data(exp).id}`).send({ amount: 6_000 })).status).toBe(200);
    expect((await acct.agent.get(`${BASE}/finance/overview`)).status).toBe(200);

    // Snapshot without users.view_compensation: no salaries / payroll.
    const snap = data(await acct.agent.get(`${BASE}/finance/owner-snapshot`));
    expect(snap.salaries).toBeNull();
    expect(snap.monthlyPayroll).toBeNull();
    expect(Array.isArray(data(await owner.get(`${BASE}/finance/owner-snapshot`)).salaries)).toBe(true);

    expect((await acct.agent.get(`${BASE}/leads`)).status).toBe(403);
    expect((await acct.agent.post(`${BASE}/leads`).send({ name: 'L' })).status).toBe(403);
    expect((await acct.agent.get(`${BASE}/proposals`)).status).toBe(403);
    expect((await acct.agent.get(`${BASE}/agreements`)).status).toBe(403);
  });

  it('hides proposal pricing (totals AND content money) without proposals.view_pricing', async () => {
    const p = data(
      await owner.post(`${BASE}/proposals`).send({
        title: 'Secret price',
        clientId,
        totalPaise: 999_00,
        recurringPaise: 50_00,
        content: {
          sections: [{ heading: 'Approach', html: 'a' }, { heading: 'Investment', html: '₹99' }],
          deliverables: [{ title: 'Ads', pricePaise: 99_900, rateRupees: 999 }],
          tiers: [{ name: 'Starter', pricePerMonth: 10_000 }],
        },
      }),
    );
    const viewer = await createMemberSession(owner, {
      grants: [g('proposals.view'), g('proposals.create'), g('proposals.update')],
    });
    const got = data(await viewer.agent.get(`${BASE}/proposals/${p.id}`));
    expect(got.title).toBe('Secret price');
    expect(got.totalPaise).toBeNull();
    expect(got.recurringPaise).toBeNull();
    expect(got.content.deliverables[0].title).toBe('Ads');
    expect(got.content.deliverables[0].pricePaise).toBeUndefined();
    expect(got.content.deliverables[0].rateRupees).toBeUndefined();
    expect(got.content.tiers[0].pricePerMonth).toBeUndefined();
    expect(got.content.sections.map((s: any) => s.heading)).toEqual(['Approach']);
    expect(got.capabilities['proposals.view_pricing']).toBe(false);
    expect(JSON.stringify(data(await viewer.agent.get(`${BASE}/proposals`)))).not.toContain('99900');

    // Writing money needs the pricing permission.
    expect((await viewer.agent.put(`${BASE}/proposals/${p.id}`).send({ totalPaise: 1 })).status).toBe(403);
    expect(
      (await viewer.agent.put(`${BASE}/proposals/${p.id}`).send({ content: { deliverables: [] } })).status,
    ).toBe(403);
    expect((await viewer.agent.put(`${BASE}/proposals/${p.id}`).send({ title: 'Renamed' })).status).toBe(200);
    expect(
      (await viewer.agent.post(`${BASE}/proposals`).send({ title: 'x', totalPaise: 5, content: {} })).status,
    ).toBe(403);
    expect((await owner.get(`${BASE}/proposals/${p.id}`)).body.data.totalPaise).toBe(999_00);
  });

  it('own-scope lead users see only their own leads (lists, counts, detail)', async () => {
    const theirs = data(await owner.post(`${BASE}/leads`).send({ name: 'Owner lead', estimatedValue: 5000 }));
    const rep = await createMemberSession(owner, {
      grants: [g('leads.view', 'own'), g('leads.update', 'own')],
    });
    // Assigned to the rep by someone holding leads.assign.
    const mine = await owner.post(`${BASE}/leads`).send({ name: 'Rep lead', ownerId: rep.user.id });
    expect(mine.status).toBe(201);

    const list = data(await rep.agent.get(`${BASE}/leads`));
    expect(list.map((l: any) => l.id)).toEqual([data(mine).id]);
    expect(data(await rep.agent.get(`${BASE}/leads/stats`)).open).toBe(1);
    expect((await rep.agent.get(`${BASE}/leads/${theirs.id}`)).status).toBe(404);
    expect((await rep.agent.patch(`${BASE}/leads/${theirs.id}`).send({ name: 'x' })).status).toBe(404);
    // No lead values without leads.view_value; cannot set them either.
    expect(data(await owner.get(`${BASE}/leads/${theirs.id}`)).estimatedValue).toBe(5000);
    expect((await rep.agent.patch(`${BASE}/leads/${data(mine).id}`).send({ estimatedValue: 1 })).status).toBe(403);
    // Own-scope users cannot create or reassign.
    expect((await rep.agent.post(`${BASE}/leads`).send({ name: 'New' })).status).toBe(403);
    expect(
      (await rep.agent.patch(`${BASE}/leads/${data(mine).id}`).send({ ownerId: tenant.user.id })).status,
    ).toBe(403);
    expect((await rep.agent.patch(`${BASE}/leads/${data(mine).id}`).send({ name: 'Renamed' })).status).toBe(200);
  });

  it('enforces the invoice status machine and payment rules', async () => {
    const inv = data(
      await owner.post(`${BASE}/invoices`).send({
        clientId,
        items: [{ description: 'Work', quantity: 1, rate: 100_000, gstRate: 0 }],
      }),
    );
    const status = (s: string, extra: Record<string, unknown> = {}) =>
      owner.patch(`${BASE}/invoices/${inv.id}/status`).send({ status: s, ...extra });

    expect((await status('paid')).status).toBe(409); // draft → paid
    expect((await status('sent')).status).toBe(200);
    expect((await status('paid')).status).toBe(409); // unpaid → paid without override

    const over = await owner.post(`${BASE}/invoices/${inv.id}/payments`).send({ amount: 100_001 });
    expect(over.status).toBe(409); // > balance
    const part = await owner.post(`${BASE}/invoices/${inv.id}/payments`).send({ amount: 40_000 });
    expect(part.status).toBe(200);
    expect(data(part).status).toBe('partially_paid');
    expect((await status('cancelled')).status).toBe(409); // has payments
    expect((await status('draft')).status).toBe(409);

    const payer = await createMemberSession(owner, { grants: [g('invoices.view')] });
    expect((await payer.agent.post(`${BASE}/invoices/${inv.id}/payments`).send({ amount: 1 })).status).toBe(403);
    expect((await payer.agent.patch(`${BASE}/invoices/${inv.id}/status`).send({ status: 'paid' })).status).toBe(403);

    expect((await status('paid', { override: true, reason: 'Settled in cash' })).status).toBe(200);
    expect((await owner.patch(`${BASE}/invoices/${inv.id}`).send({ notes: 'late edit' })).status).toBe(409);
    expect((await owner.post(`${BASE}/invoices/${inv.id}/payments`).send({ amount: 1 })).status).toBe(409);

    const doomed = data(
      await owner.post(`${BASE}/invoices`).send({
        clientId,
        items: [{ description: 'X', quantity: 1, rate: 1000, gstRate: 0 }],
      }),
    );
    expect((await owner.patch(`${BASE}/invoices/${doomed.id}/status`).send({ status: 'cancelled' })).status).toBe(200);
    expect((await owner.patch(`${BASE}/invoices/${doomed.id}/status`).send({ status: 'sent' })).status).toBe(409);
    expect((await owner.post(`${BASE}/invoices/${doomed.id}/payments`).send({ amount: 1 })).status).toBe(409);
  });

  it('proposal/agreement state guards: convert once, frozen once converted/signed', async () => {
    const p = await sentProposal();
    expect((await owner.post(`${BASE}/proposals/${p.id}/convert-to-agreement`).send({})).status).toBe(409);
    expect((await anon().post(`${BASE}/proposals/public/${p.token}/accept`).send({ acceptedBy: 'B' })).status).toBe(200);
    // Accepted is still editable (agencies correct details after a verbal yes);
    // the web app warns that the client agreed to the version being replaced.
    expect((await owner.put(`${BASE}/proposals/${p.id}`).send({ title: 'corrected' })).status).toBe(200);
    // A decided proposal cannot be rejected afterwards.
    expect((await anon().post(`${BASE}/proposals/public/${p.token}/reject`).send({})).status).toBe(409);
    expect((await owner.post(`${BASE}/proposals/${p.id}/convert-to-agreement`).send({})).status).toBe(201);
    expect((await owner.post(`${BASE}/proposals/${p.id}/convert-to-agreement`).send({})).status).toBe(409);
    // Converted: the agreement is the contract, so the proposal is frozen.
    expect((await owner.put(`${BASE}/proposals/${p.id}`).send({ title: 'tamper' })).status).toBe(409);

    const a = await sentAgreement();
    const sig = { signerName: 'Jane', signerEmail: 'jane@client.test', signatureDataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    expect((await anon().post(`${BASE}/agreements/public/${a.token}/sign`).send({ ...sig, signatureDataUrl: 'javascript:alert(1)' })).status).toBe(422);
    expect((await anon().post(`${BASE}/agreements/public/${a.token}/sign`).send(sig)).status).toBe(200);
    expect((await anon().post(`${BASE}/agreements/public/${a.token}/sign`).send(sig)).status).toBe(409);
    expect((await owner.put(`${BASE}/agreements/${a.id}`).send({ title: 'tamper' })).status).toBe(409);
    expect((await owner.delete(`${BASE}/agreements/${a.id}`)).status).toBe(409);

    // Signed view: no signer IP / email / signature, no billing address, no staff ids.
    const view = data(await anon().get(`${BASE}/agreements/public/${a.token}`));
    expect(view.status).toBe('signed');
    expect(view.signerIp).toBeUndefined();
    expect(view.signerEmail).toBeUndefined();
    expect(view.signatureDataUrl).toBeUndefined();
    expect(view.createdBy).toBeUndefined();
    expect(view.client.billingAddress).toBeUndefined();
  });

  it('edits an accepted proposal but not a converted one, and deletes mistakes', async () => {
    const p = await sentProposal();
    // Accepted: still editable (the UI warns), because agencies do correct a
    // price or a date after a verbal yes.
    await db.update(proposals).set({ status: 'accepted' }).where(eq(proposals.id, p.id));
    expect(
      (await owner.put(`${BASE}/proposals/${p.id}`).send({ title: 'Corrected after accept' })).status,
    ).toBe(200);

    // Delete needs its own permission.
    const editor = await createMemberSession(owner, {
      grants: [g('proposals.view'), g('proposals.update')],
    });
    expect((await editor.agent.delete(`${BASE}/proposals/${p.id}`)).status).toBe(403);

    expect((await owner.delete(`${BASE}/proposals/${p.id}`)).status).toBe(200);
    expect((await owner.get(`${BASE}/proposals/${p.id}`)).status).toBe(404);
    // Its client review link dies with it.
    expect((await anon().get(`${BASE}/proposals/public/${p.token}`)).status).toBe(410);

    // Converted proposals back an agreement, so they are frozen both ways.
    const q = await sentProposal();
    await db.update(proposals).set({ status: 'converted' }).where(eq(proposals.id, q.id));
    expect((await owner.put(`${BASE}/proposals/${q.id}`).send({ title: 'nope' })).status).toBe(409);
    expect((await owner.delete(`${BASE}/proposals/${q.id}`)).status).toBe(409);
  });

  it('mints a fresh shareable link for staff who may send, retiring the previous one', async () => {
    const p = await sentProposal();
    const minted = await owner.post(`${BASE}/proposals/${p.id}/link`);
    expect(minted.status).toBe(200);
    const fresh = tokenOf(data(minted).url);
    expect(fresh).not.toBe(p.token);
    expect(data(minted).expiresAt).toBeTruthy();
    expect((await anon().get(`${BASE}/proposals/public/${fresh}`)).status).toBe(200);
    expect((await anon().get(`${BASE}/proposals/public/${p.token}`)).status).toBe(410);

    const a = await sentAgreement();
    const aLink = await owner.post(`${BASE}/agreements/${a.id}/link`);
    expect(aLink.status).toBe(200);
    const freshSign = tokenOf(data(aLink).url);
    expect((await anon().get(`${BASE}/agreements/public/${freshSign}`)).status).toBe(200);
    expect((await anon().get(`${BASE}/agreements/public/${a.token}`)).status).toBe(410);

    // Needs the send permission, not merely view.
    const viewer = await createMemberSession(owner, {
      grants: [g('proposals.view'), g('agreements.view')],
    });
    expect((await viewer.agent.post(`${BASE}/proposals/${p.id}/link`)).status).toBe(403);
    expect((await viewer.agent.post(`${BASE}/agreements/${a.id}/link`)).status).toBe(403);
  });

  it('public document links: hashed, expire, revoked on resend, validUntil enforced, legacy tokens migrate once', async () => {
    const p = await sentProposal();
    // Only the hash is stored.
    const rows = await db.select().from(documentLinks).where(eq(documentLinks.objectId, p.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(p.token);
    // Never returned by list APIs.
    expect(JSON.stringify(data(await owner.get(`${BASE}/proposals`)))).not.toContain(p.token);

    expect((await anon().get(`${BASE}/proposals/public/${p.token}`)).status).toBe(200);

    // Resend → old link revoked.
    const resent = await owner.post(`${BASE}/proposals/${p.id}/send`).send({ recipientEmail: 'buyer@client.test' });
    const fresh = tokenOf(data(resent).publicUrl);
    expect((await anon().get(`${BASE}/proposals/public/${p.token}`)).status).toBe(410);
    expect((await anon().get(`${BASE}/proposals/public/${fresh}`)).status).toBe(200);

    // Expired link.
    await db.update(documentLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(documentLinks.objectId, p.id));
    expect((await anon().get(`${BASE}/proposals/public/${fresh}`)).status).toBe(410);

    // validUntil passed → cannot accept even with a live link.
    const q = await sentProposal();
    await db.update(proposals).set({ validUntil: new Date(Date.now() - 1000) }).where(eq(proposals.id, q.id));
    expect((await anon().post(`${BASE}/proposals/public/${q.token}/accept`).send({ acceptedBy: 'B' })).status).toBe(409);

    // Unknown token.
    expect((await anon().get(`${BASE}/proposals/public/pzt_nope`)).status).toBe(404);

    // Legacy plaintext token on a sent proposal with no link rows → migrated once.
    const legacy = data(await owner.post(`${BASE}/proposals`).send({ title: 'Legacy', clientId, content: {} }));
    const raw = 'pzt_legacyplaintexttoken123456';
    await db.update(proposals).set({ token: raw, status: 'sent' }).where(eq(proposals.id, legacy.id));
    expect((await anon().get(`${BASE}/proposals/public/${raw}`)).status).toBe(200);
    const [after] = await db.select().from(proposals).where(eq(proposals.id, legacy.id));
    expect(after!.token).toBeNull();
    expect((await db.select().from(documentLinks).where(eq(documentLinks.objectId, legacy.id)))).toHaveLength(1);
    expect((await anon().get(`${BASE}/proposals/public/${raw}`)).status).toBe(200);

    // Drafts have no public view.
    const draft = data(await owner.post(`${BASE}/proposals`).send({ title: 'Draft', clientId, content: {} }));
    await db.update(proposals).set({ token: 'pzt_draftlegacy999' }).where(eq(proposals.id, draft.id));
    expect((await anon().get(`${BASE}/proposals/public/pzt_draftlegacy999`)).status).toBe(404);
  });

  it('send endpoints require *.send, and creating a portal login requires clients.manage_portal', async () => {
    const p = data(await owner.post(`${BASE}/proposals`).send({ title: 'Doc', clientId, content: {} }));
    await owner.put(`${BASE}/proposals/${p.id}`).send({ fileUrl: 'https://files.example.com/doc.pdf' });
    const noSend = await createMemberSession(owner, { grants: [g('proposals.view')] });
    expect((await noSend.agent.post(`${BASE}/proposals/${p.id}/send`).send({ recipientEmail: 'a@b.test' })).status).toBe(403);

    const sender = await createMemberSession(owner, {
      grants: [g('proposals.view'), g('proposals.send'), g('clients.view')],
    });
    expect(
      (await sender.agent.post(`${BASE}/proposals/${p.id}/send`).send({ recipientEmail: 'newlogin@client.test' })).status,
    ).toBe(403);
    // The owner can (creates the login); re-sending to the same address never resets it.
    expect((await owner.post(`${BASE}/proposals/${p.id}/send`).send({ recipientEmail: 'newlogin@client.test' })).status).toBe(200);
    expect(
      (await sender.agent.post(`${BASE}/proposals/${p.id}/send`).send({ recipientEmail: 'newlogin@client.test' })).status,
    ).toBe(200);
  });

  it('refuses Refrens sync/push for an agency not bound to the credentials', async () => {
    (env as any).REFRENS_AGENCY_ID = undefined;
    const res = await owner.post(`${BASE}/refrens/sync`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Refrens is not configured for this workspace');
    (env as any).REFRENS_AGENCY_ID = 'agy_someone_else';
    expect((await owner.post(`${BASE}/refrens/sync`).send({})).status).toBe(403);
    const inv = data(
      await owner.post(`${BASE}/invoices`).send({ clientId, items: [{ description: 'X', quantity: 1, rate: 1, gstRate: 0 }] }),
    );
    expect((await owner.post(`${BASE}/refrens/invoices/${inv.id}/push`).send({})).status).toBe(403);
    (env as any).REFRENS_AGENCY_ID = undefined;
  });

  it('rejects cross-tenant references in inputs', async () => {
    const other = await signupAgency();
    const foreignClient = data(await other.agent.post(`${BASE}/clients`).send({ name: 'Foreign' })).id;
    const foreignLead = data(await other.agent.post(`${BASE}/leads`).send({ name: 'Foreign lead' })).id;
    const foreignProject = data(
      await other.agent.post(`${BASE}/projects`).send({ name: 'Foreign project', clientId: foreignClient }),
    ).id;
    const item = [{ description: 'X', quantity: 1, rate: 1, gstRate: 0 }];

    expect((await owner.post(`${BASE}/invoices`).send({ clientId: foreignClient, items: item })).status).toBe(404);
    expect((await owner.post(`${BASE}/invoices`).send({ clientId, projectId: foreignProject, items: item })).status).toBe(404);
    expect((await owner.post(`${BASE}/proposals`).send({ title: 'x', leadId: foreignLead, content: {} })).status).toBe(404);
    expect((await owner.post(`${BASE}/proposals`).send({ title: 'x', clientId: foreignClient, content: {} })).status).toBe(404);
    expect(
      (await owner.post(`${BASE}/agreements`).send({ title: 'x', clientId, projectId: foreignProject, terms: {} })).status,
    ).toBe(404);
    expect((await owner.post(`${BASE}/expenses`).send({ amount: 1, clientId: foreignClient })).status).toBe(404);
    expect((await owner.post(`${BASE}/leads`).send({ name: 'x', ownerId: other.user.id })).status).toBe(400);
    // Foreign objects are invisible.
    expect((await owner.get(`${BASE}/leads/${foreignLead}`)).status).toBe(404);
  });

  it('intake: wrong key → 401; right key creates an unassigned lead in the configured agency', async () => {
    process.env.LEAD_INTAKE_SECRET = 'intake-secret-123';
    process.env.INTAKE_AGENCY_ID = tenant.agency.id;
    const wrong = await anon().post(`${BASE}/intake/lead`).set('x-intake-key', 'intake-secret-124').send({ name: 'W' });
    expect(wrong.status).toBe(401);
    expect((await anon().post(`${BASE}/intake/lead`).send({ name: 'W' })).status).toBe(401);

    const okRes = await anon().post(`${BASE}/intake/lead`).set('x-intake-key', 'intake-secret-123').send({ name: 'Web Lead' });
    expect(okRes.status).toBe(200);
    const lead = data(await owner.get(`${BASE}/leads/${data(okRes).leadId}`));
    expect(lead.name).toBe('Web Lead');
    expect(lead.ownerId).toBeNull();
    delete process.env.LEAD_INTAKE_SECRET;
    delete process.env.INTAKE_AGENCY_ID;
  });
});
