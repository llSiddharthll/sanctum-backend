import type {
  NextFunction,
  Request,
  Response,
  ErrorRequestHandler,
} from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { isProd } from '../env.js';

/** Attach a per-request id, surfaced in logs and the X-Request-Id header. */
export function requestId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const id = `req_${Math.random().toString(36).slice(2, 10)}`;
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/** 404 handler for unmatched routes. */
export function notFoundHandler(
  req: Request,
  res: Response,
): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      requestId: req.requestId,
    },
  });
}

/** Central error serializer -> single JSON error envelope. */
export const errorHandler: ErrorRequestHandler = (
  err,
  req,
  res,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next,
) => {
  const requestId = (req as Request).requestId;

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
        requestId,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
        requestId,
      },
    });
    return;
  }

  if (err instanceof Error && err.message === 'CORS_NOT_ALLOWED') {
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Origin not allowed.', requestId },
    });
    return;
  }

  // Unexpected — log server-side, never leak internals to the client.
  // eslint-disable-next-line no-console
  console.error('[unhandled error]', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: isProd
        ? 'Something went wrong.'
        : err instanceof Error
          ? err.message
          : String(err),
      requestId,
    },
  });
};
