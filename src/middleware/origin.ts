/**
 * Shared origin allow-check for both HTTP CORS and the Socket.IO handshake.
 * Configured origins are always allowed; in dev we also allow localhost and
 * private-LAN hosts so another device on the same network (e.g. a phone at
 * http://192.168.x.x:3000) can use the dev server without hardcoding its IP.
 */
const PRIVATE_HOST =
  /^(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

export function isAllowedOrigin(
  origin: string,
  allowList: ReadonlySet<string>,
  allowPrivateLan: boolean,
): boolean {
  if (allowList.has(origin)) return true;

  try {
    const host = new URL(origin).hostname;
    if (
      host === 'thecreativemonk.in' ||
      host.endsWith('.thecreativemonk.in') ||
      host === 'creativemonk.in' ||
      host.endsWith('.creativemonk.in')
    ) {
      return true;
    }
    // Shared hosting platforms: anyone can deploy a site there, so a credentialed
    // wildcard would let third-party pages act as the signed-in user. Previews
    // are allowed only outside production (allowPrivateLan is dev-only).
    // Production previews must be added explicitly to FRONTEND_ORIGIN.
    if (allowPrivateLan && (host.endsWith('.netlify.app') || host.endsWith('.vercel.app'))) {
      return true;
    }
  } catch {
    // Ignore invalid URL
  }

  if (!allowPrivateLan) return false;
  try {
    return PRIVATE_HOST.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

