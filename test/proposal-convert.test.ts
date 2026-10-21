import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import { app, BASE, signupAgency, data, type Agent } from './helpers';

/** Send (mints the public link) and accept through it, as the client would. */
async function sendAndAccept(owner: Agent, proposalId: string) {
  const sent = await owner
    .post(`${BASE}/proposals/${proposalId}/send`)
    .send({ recipientEmail: 'buyer@client.test' });
  expect(sent.status).toBe(200);
  const token = String(data(sent).publicUrl).split('/').pop();
  const acc = await supertest(app)
    .post(`${BASE}/proposals/public/${token}/accept`)
    .send({ acceptedBy: 'Buyer' });
  expect(acc.status).toBe(200);
}

/**
 * Proposal → Agreement conversion, end-to-end: a client-linked proposal converts
 * into a retrievable draft agreement (linked back), the proposal flips to
 * 'converted', and a lead-only proposal is rejected with a clear 400.
 */
describe('proposal → agreement conversion', () => {
  let owner: Agent;
  let clientId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Convert Co' })).id;
  });

  it('converts a client proposal into a retrievable draft agreement + links both ways', async () => {
    const proposal = data(
      await owner.post(`${BASE}/proposals`).send({
        title: 'Retainer Proposal',
        clientId,
        billingType: 'retainer',
        recurringPaise: 5_000_000,
        subtotalPaise: 2_000_000,
        taxPaise: 360_000,
        totalPaise: 2_360_000,
        content: {
          sections: [{ heading: 'Scope', html: '<p>Do the work</p>' }],
          scopeOverview: 'Scope\nDo the work',
          deliverables: [
            { title: 'Social Media Management', quantity: 1, rateRupees: 50000, pricePaise: 5_000_000, billing: 'monthly' },
          ],
          terms: ['Client owns assets on final payment'],
        },
      }),
    );

    // Only an accepted proposal converts.
    const early = await owner.post(`${BASE}/proposals/${proposal.id}/convert-to-agreement`).send({});
    expect(early.status).toBe(409);
    await sendAndAccept(owner, proposal.id);

    const res = await owner.post(`${BASE}/proposals/${proposal.id}/convert-to-agreement`).send({});
    expect([200, 201]).toContain(res.status);
    const { agreementId, agreementNumber } = data(res);

    // Exactly once.
    const again = await owner.post(`${BASE}/proposals/${proposal.id}/convert-to-agreement`).send({});
    expect(again.status).toBe(409);
    expect(agreementId).toBeTruthy();
    expect(agreementNumber).toMatch(/^AGR-/);

    // The agreement is retrievable, a draft, linked to the same client + proposal,
    // and carries the retainer + scope derived from the proposal.
    const agr = data(await owner.get(`${BASE}/agreements/${agreementId}`));
    expect(agr.clientId).toBe(clientId);
    expect(agr.status).toBe('draft');
    expect(agr.proposalId).toBe(proposal.id);
    expect(agr.retainerPaise).toBe(5_000_000);
    expect(typeof (agr.terms?.scope ?? '')).toBe('string');
    expect((agr.terms?.scope ?? '')).toContain('Do the work');
    expect(Array.isArray(agr.terms?.clauses)).toBe(true);

    // It also shows up in the list.
    const list = data(await owner.get(`${BASE}/agreements`));
    expect(list.some((a: any) => a.id === agreementId)).toBe(true);

    // The proposal is now 'converted' and points at the new agreement.
    const reload = data(await owner.get(`${BASE}/proposals/${proposal.id}`));
    expect(reload.status).toBe('converted');
    expect(reload.convertedAgreementId).toBe(agreementId);
  });

  it('converts a lead-only proposal by making the lead a client', async () => {
    // An agreement belongs to a client, but a proposal usually starts on a
    // lead — winning the deal IS the moment that lead becomes a client, so the
    // conversion does it rather than refusing (it used to 400 here).
    const lead = data(await owner.post(`${BASE}/leads`).send({ name: 'Prospect X' }));
    const proposal = data(
      await owner.post(`${BASE}/proposals`).send({
        title: 'Lead Proposal',
        leadId: lead.id,
        content: { sections: [], deliverables: [], terms: [] },
      }),
    );
    await sendAndAccept(owner, proposal.id);
    const res = await owner.post(`${BASE}/proposals/${proposal.id}/convert-to-agreement`).send({});
    expect(res.status).toBe(201);
    const { agreementId, convertedLead } = data(res);
    expect(convertedLead.leadId).toBe(lead.id);
    expect(convertedLead.clientName).toBe('Prospect X');

    const agreement = data(await owner.get(`${BASE}/agreements/${agreementId}`));
    expect(agreement.clientId).toBe(convertedLead.clientId);
    expect(data(await owner.get(`${BASE}/leads/${lead.id}`)).stage).toBe('converted');
  });

  it("carries the proposal's authored sections into the agreement's terms", async () => {
    const client = data(await owner.post(`${BASE}/clients`).send({ name: 'Sectioned Co' }));
    const proposal = data(
      await owner.post(`${BASE}/proposals`).send({
        title: 'Rich Proposal',
        clientId: client.id,
        content: {
          sections: [
            { heading: 'Scope of work', html: '<p>Monthly <strong>social</strong> management.</p>' },
            { heading: 'Ways of working', html: '<ul><li>Weekly calls</li></ul>' },
          ],
          scopeOverview: 'Monthly social management.',
          deliverables: [{ title: '12 reels' }, { title: '20 statics' }],
          terms: ['1. Payment: net 15.'],
        },
      }),
    );
    await sendAndAccept(owner, proposal.id);
    const res = await owner.post(`${BASE}/proposals/${proposal.id}/convert-to-agreement`).send({});
    expect(res.status).toBe(201);

    const agreement = data(await owner.get(`${BASE}/agreements/${data(res).agreementId}`));
    const sections = agreement.terms.sections as Array<{ heading: string; html: string }>;
    expect(sections[0]).toEqual({
      heading: 'Scope of work',
      html: '<p>Monthly <strong>social</strong> management.</p>',
    });
    expect(sections[1]!.heading).toBe('Ways of working');
    // Deliverables become their own section rather than being lost.
    const deliverables = sections.find((s) => s.heading === 'Deliverables');
    expect(deliverables?.html).toContain('<li>12 reels</li>');
    // The plain-text scope mirror survives for older viewers.
    expect(agreement.terms.scope).toContain('Monthly social management.');
    expect(agreement.terms.clauses).toContain('1. Payment: net 15.');
  });

  it('keeps editing the converted agreement open, including its sections', async () => {
    const client = data(await owner.post(`${BASE}/clients`).send({ name: 'Editable Co' }));
    const proposal = data(
      await owner.post(`${BASE}/proposals`).send({
        title: 'Editable Proposal',
        clientId: client.id,
        content: { sections: [{ heading: 'Scope', html: '<p>Original</p>' }] },
      }),
    );
    await sendAndAccept(owner, proposal.id);
    const { agreementId } = data(
      await owner.post(`${BASE}/proposals/${proposal.id}/convert-to-agreement`).send({}),
    );

    // Add a section and keep an unrelated key: both survive the round trip.
    const patched = await owner.put(`${BASE}/agreements/${agreementId}`).send({
      terms: {
        scope: 'Original',
        sections: [
          { heading: 'Scope', html: '<p>Original</p>' },
          { heading: 'Payment terms', html: '<p>50% upfront.</p>' },
        ],
        clauses: ['1. Term: 12 months.'],
        customKey: 'kept',
      },
    });
    expect(patched.status).toBe(200);
    const reloaded = data(await owner.get(`${BASE}/agreements/${agreementId}`));
    expect(reloaded.terms.sections).toHaveLength(2);
    expect(reloaded.terms.sections[1].heading).toBe('Payment terms');
    expect(reloaded.terms.customKey).toBe('kept');
  });
});
