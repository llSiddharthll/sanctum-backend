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
  
  const { emailEnabled, env } = await import('../env.js');
  let smtpStatus = 'skip';
  let smtpError = null;
  if (_req.query.test_smtp === '1' && emailEnabled) {
    try {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: {
          user: env.EMAIL_USER,
          pass: (env.EMAIL_PASS ?? '').replace(/\s+/g, ''),
        },
      });
      await transporter.verify();
      smtpStatus = 'ok';
    } catch (err) {
      smtpStatus = 'error';
      smtpError = (err as Error)?.message || String(err);
    }
  }

  // Always 200 for liveness; report db status in the body.
  res.status(200).json({
    status: 'ok',
    service: 'sanctum-api',
    uptime: Math.floor(process.uptime()),
    db: database,
    email: emailEnabled,
    smtp: smtpStatus,
    smtpError,
    time: new Date().toISOString(),
  });
});
