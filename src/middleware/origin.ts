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
  if (!allowPrivateLan) return false;
  try {
    return PRIVATE_HOST.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}
