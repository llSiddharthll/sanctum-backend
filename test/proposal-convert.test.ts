import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, signupAgency, data, type Agent } from './helpers';

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

    const res = await owner.post(`${BASE}/proposals/${proposal.id}/convert-to-agreement`).send({});
    expect([200, 201]).toContain(res.status);
    const { agreementId, agreementNumber } = data(res);
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

  it('rejects converting a lead-only proposal (no client) with a clear 400', async () => {
    const lead = data(await owner.post(`${BASE}/leads`).send({ name: 'Prospect X' }));
    const proposal = data(
      await owner.post(`${BASE}/proposals`).send({
        title: 'Lead Proposal',
        leadId: lead.id,
        content: { sections: [], deliverables: [], terms: [] },
      }),
    );
    const res = await owner.post(`${BASE}/proposals/${proposal.id}/convert-to-agreement`).send({});
    expect(res.status).toBe(400);
    expect(String(res.body?.error?.message ?? '')).toMatch(/client/i);
  });
});
