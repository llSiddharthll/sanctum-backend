import { Router } from 'express';
import { libsql } from '../db/client.js';
import { emailEnabled } from '../env.js';

/**
 * Public liveness probe (unauthenticated by design). It reports only coarse
 * status. The former `?test_smtp=1` SMTP verification was removed: it let
 * anyone trigger outbound SMTP logins and leaked provider error messages.
 */
export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  let database = 'skip';
  try {
    await libsql.execute('SELECT 1');
    database = 'ok';
  } catch {
    database = 'down';
  }

  // Always 200 for liveness; report db status in the body.
  res.status(200).json({
    status: 'ok',
    service: 'sanctum-api',
    uptime: Math.floor(process.uptime()),
    db: database,
    email: emailEnabled,
    time: new Date().toISOString(),
  });
});
