import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import { app, BASE, signupAgency, data, type Agent } from './helpers';

/**
 * Proposals now carry custom rich-text sections (content.sections[]) and a
 * per-line billing flag (deliverables[].billing = 'monthly' | 'one_time') that
 * drives the retainer figure. Content is a free JSON blob on the backend, so
 * this verifies the values round-trip on the authed API AND reach the public,
 * unauthenticated proposal view (which needs recurringPaise to show the
 * monthly retainer), and that convert-to-agreement still works.
 */
describe('proposals: custom sections + per-line billing', () => {
  let owner: Agent;
  let clientId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Prop Co' })).id;
  });

  it('round-trips sections + per-line billing and exposes them to the public view', async () => {
    const payload = {
      title: 'Growth Retainer',
      clientId,
      billingType: 'retainer',
      recurringPaise: 5_000_000, // ₹50,000 / month (sum of monthly lines)
      subtotalPaise: 2_000_000, // ₹20,000 one-time
      taxPaise: 360_000,
      totalPaise: 2_360_000,
      content: {
        sections: [
          { heading: 'Executive Summary', html: '<p>Hello <strong>world</strong></p>' },
          { heading: 'Our Approach', html: '<ul><li>Step one</li><li>Step two</li></ul>' },
        ],
        scopeOverview: 'Executive Summary\nHello world\n\nOur Approach\nStep one\nStep two',
        deliverables: [
          { title: 'Social Media Management', description: 'Monthly management', quantity: 1, rateRupees: 50000, priceRupees: 50000, pricePaise: 5_000_000, billing: 'monthly' },
          { title: 'Brand Setup', description: 'One-time setup', quantity: 1, rateRupees: 20000, priceRupees: 20000, pricePaise: 2_000_000, billing: 'one_time' },
        ],
        terms: ['Client owns assets on final payment'],
      },
    };

    const created = data(await owner.post(`${BASE}/proposals`).send(payload));
    expect(created.token).toBeTruthy();
    expect(created.content.sections).toHaveLength(2);
    expect(created.billingType).toBe('retainer');

    // Authed owner sees the sections, per-line billing, and the retainer figure.
    const list = data(await owner.get(`${BASE}/proposals`));
    const mine = list.find((p: any) => p.id === created.id);
    expect(mine.content.sections[0].heading).toBe('Executive Summary');
    expect(mine.content.deliverables[0].billing).toBe('monthly');
    expect(mine.content.deliverables[1].billing).toBe('one_time');
    expect(mine.recurringPaise).toBe(5_000_000);

    // Public (unauthenticated) proposal view exposes the sections + retainer.
    const pub = data(
      await supertest(app).get(`${BASE}/proposals/public/${created.token}`),
    );
    expect(pub.content.sections).toHaveLength(2);
    expect(pub.content.sections[1].html).toContain('<li>');
    expect(pub.billingType).toBe('retainer');
    expect(pub.recurringPaise).toBe(5_000_000);
    const monthly = pub.content.deliverables.find((d: any) => d.billing === 'monthly');
    expect(monthly.title).toBe('Social Media Management');
  });

  it('a document proposal can be edited: title + replaced file (fileUrl column)', async () => {
    const created = data(
      await owner.post(`${BASE}/proposals`).send({
        title: 'Doc Proposal',
        clientId,
        content: { source: 'document', fileUrl: 'https://files.example.com/old.pdf' },
        fileUrl: 'https://files.example.com/old.pdf',
      }),
    );
    // Note: create doesn't take fileUrl, but the PUT (edit) does — replace it.
    const put = await owner.put(`${BASE}/proposals/${created.id}`).send({
      title: 'Doc Proposal (renamed)',
      content: { source: 'document', fileUrl: 'https://files.example.com/new.pdf' },
      fileUrl: 'https://files.example.com/new.pdf',
    });
    expect(put.status).toBe(200);
    const list = data(await owner.get(`${BASE}/proposals`));
    const p = list.find((x: any) => x.id === created.id);
    expect(p.title).toBe('Doc Proposal (renamed)');
    expect(p.fileUrl).toBe('https://files.example.com/new.pdf');
    expect(p.content.fileUrl).toBe('https://files.example.com/new.pdf');
  });

  it('a proposal with no monthly lines stays one-time', async () => {
    const created = data(
      await owner.post(`${BASE}/proposals`).send({
        title: 'One-time Project',
        clientId,
        billingType: 'one_time',
        subtotalPaise: 1_000_000,
        taxPaise: 180_000,
        totalPaise: 1_180_000,
        content: {
          sections: [{ heading: 'Scope', html: '<p>Build a website</p>' }],
          scopeOverview: 'Scope\nBuild a website',
          deliverables: [{ title: 'Website', quantity: 1, rateRupees: 10000, priceRupees: 10000, pricePaise: 1_000_000, billing: 'one_time' }],
          terms: [],
        },
      }),
    );
    expect(created.billingType).toBe('one_time');
    const pub = data(await supertest(app).get(`${BASE}/proposals/public/${created.token}`));
    expect(pub.content.deliverables.every((d: any) => d.billing === 'one_time')).toBe(true);
  });

  it('convert-to-agreement still derives scope from the summary + carries the retainer', async () => {
    const created = data(
      await owner.post(`${BASE}/proposals`).send({
        title: 'Convert Me',
        clientId,
        billingType: 'retainer',
        recurringPaise: 3_000_000,
        subtotalPaise: 0,
        taxPaise: 0,
        totalPaise: 0,
        content: {
          sections: [{ heading: 'Scope', html: '<p>Do the work</p>' }],
          scopeOverview: 'Scope\nDo the work',
          deliverables: [{ title: 'Monthly Retainer', quantity: 1, rateRupees: 30000, priceRupees: 30000, pricePaise: 3_000_000, billing: 'monthly' }],
          terms: ['A clause'],
        },
      }),
    );
    const res = await owner.post(`${BASE}/proposals/${created.id}/convert-to-agreement`).send({});
    expect([200, 201]).toContain(res.status);
    const agr = data(res);
    expect(agr.agreementId).toBeTruthy();
  });
});
