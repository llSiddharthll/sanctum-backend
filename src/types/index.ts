import type { Role } from '../lib/jwt.js';

/** Authenticated user context, derived from the verified access token. */
export interface AuthContext {
  userId: string;
  agencyId: string;
  role: Role;
  /** Present only for `client` role — the brand this client belongs to. */
  clientId?: string | null;
}

/**
 * Client-portal context (a logged-in `client` user): the brand they belong to
 * plus the set of project ids they may see. `allProjects` = every project of
 * the client (no per-project restriction was set at invite time).
 */
export interface ClientContext {
  userId: string;
  agencyId: string;
  clientId: string;
  projectIds: string[];
  allProjects: boolean;
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
      clientCtx?: ClientContext;
      requestId?: string;
    }
  }
}

export {};
