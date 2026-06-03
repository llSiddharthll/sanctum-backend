import { Router } from 'express';
import { libsql } from '../db/client.js';

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
    time: new Date().toISOString(),
  });
});
