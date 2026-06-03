import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { corsMw } from './middleware/cors.js';
import {
  errorHandler,
  notFoundHandler,
  requestId,
} from './middleware/error.js';
import { globalLimiter } from './middleware/rate-limit.js';

import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { agenciesRouter } from './routes/agencies.js';
import { usersRouter } from './routes/users.js';
import { clientsRouter } from './routes/clients.js';
import { postsRouter } from './routes/posts.js';
import { approvalsRouter } from './routes/approvals.js';
import { mediaRouter } from './routes/media.js';
import { aiRouter } from './routes/ai.js';
import { analyticsRouter } from './routes/analytics.js';
import { portalRouter } from './routes/portal.js';

export function createApp() {
  const app = express();

  // Behind Render's proxy — trust it for req.ip / secure cookies.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(corsMw);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestId);

  // Liveness — mounted before rate limiting / auth gating.
  app.use('/health', healthRouter);

  const api = express.Router();
  api.use(globalLimiter);

  api.use('/auth', authRouter);
  api.use('/agency', agenciesRouter);
  api.use('/team', usersRouter);
  api.use('/clients', clientsRouter);

  // Nested content routes under a client.
  api.use('/clients/:clientId/posts', postsRouter);
  api.use('/clients/:clientId/posts/:postId', approvalsRouter);
  api.use('/clients/:clientId/ai', aiRouter);

  api.use('/media', mediaRouter);
  api.use('/analytics', analyticsRouter);

  // Public client portal (token-auth, no cookies).
  api.use('/portal', portalRouter);

  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
