/**
 * Authorization lint (design §L "Static search"). Fails when:
 *  1. a route handler has no `requires(...)` / `requiresAny(...)` guard and is
 *     not in the reviewed EXCEPTIONS list below (each with a reason);
 *  2. a forbidden legacy pattern reappears anywhere in src/.
 *
 * Run: pnpm authz:lint
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** file:METHOD path → why it has no route-level permission guard. */
const EXCEPTIONS: Record<string, string> = {
  'agreements.ts:GET /public/:token': 'anonymous document link (hashed, expiring capability)',
  'agreements.ts:POST /public/:token/sign': 'anonymous document link + state guard',
  'proposals.ts:GET /public/:token': 'anonymous document link',
  'proposals.ts:POST /public/:token/accept': 'anonymous document link + state guard',
  'proposals.ts:POST /public/:token/reject': 'anonymous document link + state guard',
  'auth.ts:POST /signup': 'public',
  'auth.ts:POST /login': 'public',
  'auth.ts:GET /invite': 'invite token',
  'auth.ts:POST /accept-invite': 'invite token',
  'auth.ts:POST /forgot-password': 'public (no enumeration)',
  'auth.ts:GET /reset-password': 'reset token',
  'auth.ts:POST /reset-password': 'reset token',
  'auth.ts:POST /change-password': 'self-service (authenticated)',
  'auth.ts:POST /refresh': 'refresh token',
  'auth.ts:POST /logout': 'session token',
  'auth.ts:GET /me': 'self-service (authenticated)',
  'auth.ts:GET /sessions': 'self-service (authenticated)',
  'auth.ts:DELETE /sessions/:id': 'self-service, own sessions only',
  'client-portal.ts:GET /me': 'self-service for client-side actors',
  'health.ts:GET /': 'liveness',
  'intake.ts:POST /lead': 'integration key → integrationActor with leads.create',
  'notifications.ts:GET /': 'self-service (own notifications)',
  'notifications.ts:GET /unread-count': 'self-service',
  'notifications.ts:POST /:id/read': 'self-service',
  'notifications.ts:POST /read-all': 'self-service',
  'oauth.ts:GET /meta/callback': 'signed single-use state; re-checks initiator permission',
  'oauth.ts:POST /meta/deauthorize': 'Meta signed_request',
  'oauth.ts:POST /meta/data-deletion': 'Meta signed_request',
  'oauth.ts:GET /meta/deletion-status': 'public static status',
  'portal.ts:POST /session': 'share-link token → portal_link session',
  'portal.ts:GET /resolve': 'share-link grants enforced in SQL filters',
  'portal.ts:GET /posts/:postId': 'share-link; authorize() in handler',
  'portal.ts:POST /posts/:postId/decision': 'share-link; authorize(posts.approve)',
  'portal.ts:POST /posts/:postId/comments': 'share-link; authorize(post_comments.create)',
  'portal.ts:GET /posts/:postId/comments': 'share-link; authorize(post_comments.view)',
  'posts.ts:POST /:postId/transition': 'permission depends on target status; authorizePost() in handler',
  'push.ts:POST /register': 'self-service (own device)',
  'push.ts:DELETE /register': 'self-service (own device)',
  'roles.ts:GET /catalog': 'catalog metadata for any authenticated actor',
  'uploads.ts:PUT /local': 'purpose-bound HMAC upload token, tenant-prefixed key',
};

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\brequireRole\(/, 'role gate'],
  [/\bisPrivileged\(/, 'role shortcut'],
  [/\brequireModule(RW)?\(/, 'module-level gate'],
  [/\bloadPermissions\(/, 'legacy permission map'],
  [/\bcanManageRole\(/, 'role rank'],
  [/\bROLE_RANK\b/, 'role rank'],
  [/req\.auth\b/, 'legacy auth context'],
  [/req\.path\.includes\(/, 'path-substring authorization'],
  [/\.role\s*===?\s*['"](owner|admin|member|manager)['"]/, 'role comparison'],
  [/\bagencyOwners\(|\bagencyApprovers\(/, 'role-based recipients'],
  [/fullAccess\(\)/, 'implicit full access'],
];
/** Files allowed to mention legacy concepts (migration + compat + catalog DSL + seed). */
const FORBIDDEN_ALLOW = new Set([
  'src/authz/migrate-legacy.ts',
  'src/authz/compat.ts',
  'src/authz/catalog.ts',
  'src/seed.ts',
  'src/seed-finance.ts',
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const problems: string[] = [];
const seen = new Set<string>();

for (const file of walk(path.join(root, 'src/routes'))) {
  const src = readFileSync(file, 'utf8');
  const name = path.basename(file);
  const re = /\w+Router\.(get|post|put|patch|delete)\(\s*'([^']*)'([\s\S]*?)(async\s*\(|\(\s*_?req)/g;
  for (let m; (m = re.exec(src)); ) {
    const key = `${name}:${m[1]!.toUpperCase()} ${m[2]}`;
    if (/\brequires(Any)?\(/.test(m[3]!)) continue;
    seen.add(key);
    if (!EXCEPTIONS[key]) {
      const line = src.slice(0, m.index).split('\n').length;
      problems.push(`unguarded route ${key} (src/routes/${name}:${line}) — add requires(...) or a reviewed exception`);
    }
  }
}
for (const key of Object.keys(EXCEPTIONS)) {
  if (!seen.has(key)) problems.push(`stale exception (route now guarded or removed): ${key}`);
}

for (const file of walk(path.join(root, 'src'))) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (FORBIDDEN_ALLOW.has(rel)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line) || /authz-lint-allow: \S/.test(line)) return;
    for (const [re, why] of FORBIDDEN) {
      if (re.test(line)) problems.push(`${rel}:${i + 1} forbidden ${why}: ${line.trim()}`);
    }
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\nauthz lint: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log('authz lint: ok');
