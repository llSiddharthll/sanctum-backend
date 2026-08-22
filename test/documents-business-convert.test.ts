import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import { app, BASE, signupAgency, data, type Agent } from './helpers';

/**
 * Uploading a document as a proposal / agreement / invoice spawns the matching
 * Business record so it appears in that tab. When the document is marked
 * client-visible the record is created 'sent' and shows in the client's portal
 * tab (with its fileUrl); otherwise it stays 'draft' (agency-only).
 */
async function makeClient(owner: Agent, name: string, contactEmail: string) {
  return data(await owner.post(`${BASE}/clients`).send({ name, contactEmail }));
}

/** POST /documents metadata directly (skips the storage upload step). */
async function uploadDoc(
  owner: Agent,
  opts: { category: string; clientId?: string; clientVisible?: boolean },
) {
  const res = await owner.post(`${BASE}/documents`).send({
    name: `${opts.category} file`,
    category: opts.category,
    fileUrl: `https://files.example.com/${opts.category}-${Date.now()}.pdf`,
    clientId: opts.clientId,
    clientVisible: opts.clientVisible ? 1 : 0,
  });
  return data(res);
}

describe('documents → proposals / agreements / invoices', () => {
  let owner: Agent;
  let clientId: string;
  let clientEmail: string;
  let clientAt: string; // client-login access token

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientEmail = `docbiz.${Date.now()}@client.test`;
    clientId = (await makeClient(owner, 'Doc Biz Co', clientEmail)).id;
    // Provision a client login so we can hit the /client/* portal endpoints.
    const creds = data(
      await owner.post(`${BASE}/clients/${clientId}/portal-login`).send({}),
    );
    const login = await supertest(app)
      .post(`${BASE}/auth/login`)
      .send({ email: creds.email, password: creds.password });
    clientAt = login.body.data.tokens.access;
  });

  const clientGet = (path: string) =>
    supertest(app).get(`${BASE}${path}`).set('Authorization', `Bearer ${clientAt}`);
  const clientPost = (path: string, body?: object) =>
    supertest(app).post(`${BASE}${path}`).set('Authorization', `Bearer ${clientAt}`).send(body ?? {});

  it('proposal upload → sent proposal in the agency tab AND the client portal (with fileUrl)', async () => {
    const doc = await uploadDoc(owner, {
      category: 'proposal',
      clientId,
      clientVisible: true,
    });
    expect(doc.converted?.type).toBe('proposal');
    const propId = doc.converted.id;

    // Agency Proposals tab lists it with the file + 'sent' status.
    const agency = data(await owner.get(`${BASE}/proposals`));
    const ap = agency.find((p: any) => p.id === propId);
    expect(ap, 'proposal should appear in the agency tab').toBeTruthy();
    expect(ap.status).toBe('sent');
    expect(ap.fileUrl).toBe(doc.fileUrl);

    // Client portal sees it (not a draft) with the fileUrl to open.
    const client = data(await clientGet('/client/proposals'));
    const cp = client.find((p: any) => p.id === propId);
    expect(cp, 'proposal should appear in the client portal').toBeTruthy();
    expect(cp.fileUrl).toBe(doc.fileUrl);

    // A document proposal has no review token, but the client can request
    // changes OR approve it in place from the portal (by id).
    const reject = await clientPost(`/client/proposals/${propId}/reject`, { reason: 'Lower the price' });
    expect(reject.status).toBe(200);
    expect(data(await clientGet('/client/proposals')).find((p: any) => p.id === propId).status).toBe('rejected');

    const accept = await clientPost(`/client/proposals/${propId}/accept`);
    expect(accept.status).toBe(200);
    const after = data(await clientGet('/client/proposals'));
    expect(after.find((p: any) => p.id === propId).status).toBe('accepted');
  });

  it('agreement upload (client-visible) → agency + client agreement tab', async () => {
    const doc = await uploadDoc(owner, {
      category: 'contract',
      clientId,
      clientVisible: true,
    });
    expect(doc.converted?.type).toBe('agreement');
    const agrId = doc.converted.id;

    const agency = data(await owner.get(`${BASE}/agreements`));
    expect(agency.some((a: any) => a.id === agrId && a.fileUrl === doc.fileUrl)).toBe(true);

    const client = data(await clientGet('/client/agreements'));
    const ca = client.find((a: any) => a.id === agrId);
    expect(ca?.fileUrl).toBe(doc.fileUrl);

    // The client can e-sign the document agreement in place (by id, no token).
    const sign = await clientPost(`/client/agreements/${agrId}/sign`, {
      signerName: 'Client Boss',
      signerEmail: 'boss@client.test',
      signatureDataUrl: 'signed:Client Boss',
    });
    expect(sign.status).toBe(200);
  });

  it('invoice upload appears in the Invoices tab; client visibility follows the toggle', async () => {
    // NOT client-visible → agency-only draft, hidden from the client.
    const draft = await uploadDoc(owner, {
      category: 'invoice',
      clientId,
      clientVisible: false,
    });
    expect(draft.converted?.type).toBe('invoice');
    const draftId = draft.converted.id;

    const agencyInv = data(await owner.get(`${BASE}/invoices`));
    const ai = agencyInv.find((i: any) => i.id === draftId);
    expect(ai, 'invoice should appear in the agency Invoices tab').toBeTruthy();
    expect(ai.rawStatus).toBe('draft');
    expect(ai.fileUrl).toBe(draft.fileUrl);

    let clientInv = data(await clientGet('/client/invoices'));
    expect(clientInv.some((i: any) => i.id === draftId)).toBe(false); // hidden

    // Client-visible → shows in the client's Invoices tab with the file.
    const sent = await uploadDoc(owner, {
      category: 'invoice',
      clientId,
      clientVisible: true,
    });
    const sentId = sent.converted.id;
    clientInv = data(await clientGet('/client/invoices'));
    const ci = clientInv.find((i: any) => i.id === sentId);
    expect(ci, 'client-visible invoice should reach the client').toBeTruthy();
    expect(ci.fileUrl).toBe(sent.fileUrl);
  });

  it('agreement / invoice without a client are not converted', async () => {
    const agr = await uploadDoc(owner, { category: 'agreement', clientVisible: true });
    expect(agr.converted).toBeNull();
    const inv = await uploadDoc(owner, { category: 'invoice', clientVisible: true });
    expect(inv.converted).toBeNull();
  });
});
