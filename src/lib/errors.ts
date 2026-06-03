/**
 * Typed application errors mapping to a single JSON error envelope.
 * Throw these from anywhere; the error middleware serializes them.
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'GONE'
  | 'VALIDATION_ERROR'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'NOT_IMPLEMENTED'
  | 'AI_UPSTREAM_ERROR'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  GONE: 410,
  VALIDATION_ERROR: 422,
  QUOTA_EXCEEDED: 402,
  RATE_LIMITED: 429,
  NOT_IMPLEMENTED: 501,
  AI_UPSTREAM_ERROR: 503,
  INTERNAL: 500,
};

export interface ErrorDetail {
  path?: string;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[] | Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: ErrorDetail[] | Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

// Convenience constructors
export const badRequest = (m = 'Malformed request.') =>
  new AppError('BAD_REQUEST', m);
export const unauthenticated = (m = 'Authentication required.') =>
  new AppError('UNAUTHENTICATED', m);
export const invalidCredentials = (m = 'Invalid email or password.') =>
  new AppError('INVALID_CREDENTIALS', m);
export const forbidden = (m = 'You do not have permission to do that.') =>
  new AppError('FORBIDDEN', m);
export const notFound = (m = 'Resource not found.') =>
  new AppError('NOT_FOUND', m);
export const conflict = (m = 'Conflicting state.') =>
  new AppError('CONFLICT', m);
export const invalidState = (m = 'Illegal state transition.') =>
  new AppError('INVALID_STATE', m);
export const gone = (m = 'This link is no longer valid.') =>
  new AppError('GONE', m);
export const quotaExceeded = (
  m: string,
  details?: Record<string, unknown>,
) => new AppError('QUOTA_EXCEEDED', m, details);
export const notImplemented = (m = 'Not implemented.') =>
  new AppError('NOT_IMPLEMENTED', m);
export const aiUpstreamError = (m = 'AI upstream failed.') =>
  new AppError('AI_UPSTREAM_ERROR', m);
