import { describe, it, expect } from 'vitest';
import { normalizePlatform, normalizePlatforms } from '../src/lib/platforms.js';
import { parseDate } from '../src/services/sheet-publish';
import { BASE, signupAgency, data } from './helpers';

/** Posts imported from Google Sheets had "Instagram"-style platforms and 2001 dates. */
describe('platform names', () => {
  it('maps common spellings to canonical keys and drops unknown ones', () => {
    expect(normalizePlatforms(['Instagram', 'FB', 'Twitter', 'LinkedIn', 'YouTube Shorts', 'GMB', 'Snapchat', 'instagram'])).toEqual([
      'instagram',
      'facebook',
      'x',
      'linkedin',
      'youtube',
      'google_business',
    ]);
    expect(normalizePlatform(' Google Business Profile ')).toBe('google_business');
    expect(normalizePlatform('tik-tok')).toBe('tiktok');
  });

  it('serves and saves canonical platforms through the posts API (old data stays editable)', async () => {
    const { agent: owner } = await signupAgency();
    const clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Park Gate Hotel' })).id as string;
    const created = await owner
      .post(`${BASE}/clients/${clientId}/posts`)
      .send({ postType: 'post', platforms: ['Instagram', 'Facebook'], caption: 'Three years!', scheduledAt: '2026-12-04T05:30:00.000Z' });
    expect(created.status).toBe(201);
    expect(data(created).platforms).toEqual(['instagram', 'facebook']);
    const updated = await owner
      .patch(`${BASE}/clients/${clientId}/posts/${data(created).id}`)
      .send({ platforms: ['instagram', 'facebook'], caption: 'Three years of celebrations' });
    expect(updated.status).toBe(200);
    expect(data(updated).caption).toBe('Three years of celebrations');
  });
});

describe('sheet dates without a year', () => {
  const now = new Date();
  const year = now.getUTCFullYear();

  it('never invents 2001', () => {
    for (const raw of ['4 Nov', 'Nov 4', '4th November', 'November 4', '4/11', '4.11']) {
      const d = parseDate(raw);
      expect(d, raw).not.toBeNull();
      expect([year, year + 1], raw).toContain(d!.getUTCFullYear());
      expect(d!.getUTCMonth(), raw).toBe(10);
      expect(d!.getUTCDate(), raw).toBe(4);
    }
  });

  it('keeps dates that include a year exactly as typed', () => {
    expect(parseDate('4 Nov 2026')!.toISOString().slice(0, 10)).toBe('2026-11-04');
    expect(parseDate('2027-01-05')!.toISOString().slice(0, 10)).toBe('2027-01-05');
  });

  it('rejects text with no year that is not a date', () => {
    expect(parseDate('sometime soon')).toBeNull();
  });
});
