import type { Role } from '../lib/jwt.js';

/** Authenticated agency-user context, derived from the verified access token. */
export interface AuthContext {
  userId: string;
  agencyId: string;
  role: Role;
}

/** Portal context, derived from a resolved opaque token -> exactly one client. */
export interface PortalContext {
  tokenId: string;
  agencyId: string;
  clientId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      portal?: PortalContext;
      requestId?: string;
    }
  }
}

export {};
