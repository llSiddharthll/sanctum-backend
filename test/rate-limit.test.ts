import express from 'express';
import cookieParser from 'cookie-parser';
import supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  authLimiter,
  globalIpLimiter,
  globalLimiter,
  loginLimiter,
  rateLimitConfig,
  refreshLimiter,
} from '../src/middleware/rate-limit.js';

/**
 * An office shares one public IP. Per-IP auth limits used to lock the whole
 * office out ("Too many attempts" on a first login) and per-IP API limits
 * emptied pages. Limits are now per person / per account.
 */
const OFFICE_IP = '203.0.113.7';
let prevEnv: string | undefined;

function app() {
  const a = express();
  a.set('trust proxy', 1);
  a.use(express.json());
  a.use(cookieParser());
  a.post('/login', authLimiter, loginLimiter, (_req, res) => { res.json({ ok: true }); });
  a.post('/refresh', refreshLimiter, (_req, res) => { res.json({ ok: true }); });
  a.get('/api', globalIpLimiter, globalLimiter, (_req, res) => { res.json({ ok: true }); });
  return a;
}

describe('rate limits are per person, not per office IP', () => {
  beforeAll(() => {
    prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // limiters only run in production
  });
  afterAll(() => {
    process.env.NODE_ENV = prevEnv;
  });

  it('lets a whole office log in from one IP', async () => {
    const a = app();
    for (let i = 0; i < 30; i++) {
      const r = await supertest(a).post('/login').set('X-Forwarded-For', OFFICE_IP).send({ email: `person${i}@agency.test`, password: 'x' });
      expect(r.status, `login ${i}`).toBe(200);
    }
  });

  it('still blocks repeated guessing on one account', async () => {
    const a = app();
    const statuses: number[] = [];
    for (let i = 0; i < rateLimitConfig.auth.max + 1; i++) {
      statuses.push((await supertest(a).post('/login').set('X-Forwarded-For', '198.51.100.9').send({ email: 'Target@Agency.test', password: `guess${i}` })).status);
    }
    expect(statuses.slice(0, rateLimitConfig.auth.max).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("doesn't count colleagues' token refreshes against each other", async () => {
    const a = app();
    for (let i = 0; i < 40; i++) {
      const r = await supertest(a).post('/refresh').set('X-Forwarded-For', OFFICE_IP).send({ refreshToken: `rft_colleague_${i}` });
      expect(r.status, `refresh ${i}`).toBe(200);
    }
  });

  it('gives each signed-in person their own API allowance', async () => {
    const a = app();
    // 15 colleagues × 40 requests = 600 from one IP (the old per-IP limit was 300/min).
    for (let person = 0; person < 15; person++) {
      for (let i = 0; i < 40; i++) {
        const r = await supertest(a).get('/api').set('X-Forwarded-For', OFFICE_IP).set('Authorization', `Bearer token-${person}`);
        if (r.status !== 200) throw new Error(`person ${person} request ${i} got ${r.status}`);
      }
    }
  });
});
