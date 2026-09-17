# 02 — Team / Agency / Auth / Platform endpoints: authorization inventory

Scope: `sanctum-backend/src/routes/{users,agencies,auth,push,notifications,uploads,health,intake,oauth}.ts`, plus `middleware/{auth,permissions,tenant,error,rate-limit,origin,cors}.ts`, `lib/{jwt,permissions,cookies,client-portal-login}.ts`, `services/{password-reset,audit,vault}.ts`. Supporting reads: `app.ts` (mounts), `realtime/socket.ts`, `routes/portal.ts` (token issue), `middleware/client.ts`, `services/{media-archive,storage-status,local-storage,meta,social-oauth}.ts`, `db/schema.ts`.

Read-only. No repo files were changed. Line numbers are from the current working tree.

**Endpoint count: 51** (users 15, agencies 12, auth 11, push 2, notifications 4, uploads 1, health 1, intake 1, oauth 4).

---

## 0. Primitives this inventory refers to

| Primitive | Location | Behaviour (verified) |
|---|---|---|
| `requireAuth` | middleware/auth.ts:12-45 | Reads the `sanctum_at` cookie, or else `Authorization: Bearer`. Only verifies the JWT (HS256, `type==='access'`). **No DB lookup**, so it does not check that the user exists, is active, or still has the same role. Fills `req.auth = {userId, agencyId, role, clientId}` from the claims. |
| `requireRole(...roles)` | middleware/auth.ts:48-56 | Compares against the **token** role, which can be up to 15 minutes old. |
| `canManageRole(caller, target)` | middleware/auth.ts:69-73 | Owner can manage anyone. A client can manage no one. Anyone else passes only when `rank(target) < rank(caller)`. Ranks: client 0, member 1, admin 2, owner 3. |
| `isPrivileged(role)` | middleware/tenant.ts:230-232 | owner or admin. Ignores module permissions. |
| `requireClientAccess(ctx, clientId)` | middleware/tenant.ts:257-269 | Only checks that the client belongs to the agency. Returns 404 otherwise. **Does not check assignments.** |
| `loadPermissions(req)` | middleware/permissions.ts:119-154 | Owner gets full access and client gets no access, both decided from the token role. Anyone else gets a **live DB read** of `users.permissionsJson + agencies.rolePermissionsJson + customRoles.permissionsJson`, memoized per request. **Fails open**: when the user row is missing (for example a deleted user with a live token), `resolvePermissions(role, null, null, null)` falls back to `DEFAULT_LEVEL='manage'` on every module except finance and business. |
| `requireModule(m, lvl)` / `requireModuleRW(m)` | middleware/permissions.ts:160-210 | The RW variant maps GET/HEAD/OPTIONS to view, POST/PUT/PATCH to edit, and DELETE to manage. |
| `resolvePermissions` | lib/permissions.ts:503-534 | Precedence: user override, then custom role, then agency role default, then built-in `manage`. `finance` and `business` are always forced to `none` for non-owners. |
| `assertPermissionCeiling` | routes/users.ts:47-61 | Owner skips it. Anyone else: each **explicit** override level in the request body must be ≤ the caller's own effective level. It does **not** check the permissions the target inherits from role defaults or custom roles. |
| `audit()` | services/audit.ts:9-30 | Best effort. Errors are swallowed. |

Mounts (app.ts): `/uploads` and `/health` sit at the app root, before JSON parsing, the global limiter and auth. Everything else sits under `/api/v1` with `globalLimiter` (300/min per IP, **skipped whenever NODE_ENV !== 'production'**). Routers: `/auth`, `/agency`, `/team` (users.ts), `/push`, `/intake`, `/notifications`, `/oauth`.

---

## 1. `/api/v1/team` — routes/users.ts

Router-level gates, applied to every route below: `requireAuth` (L67) and `requireModuleRW('team')` (L69). So GET needs team:view, POST/PATCH need team:edit, and DELETE needs team:manage. The comment on L68 says "writes need manage", which is wrong: POST and PATCH only need edit.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks (lines) | Tenant filter? | Object scoping | Sensitive fields in response | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy / escalation rule |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | GET | /team | List staff members with workload, utilization and today's presence | router: auth + team:view | None. `showFinance = finance>=view` (L341). Finance is forced to none for non-owners, so **only the owner** sees pay. | Yes: `users.agencyId` + `role != client` (L219). Every aggregate query is also agency-filtered. | n/a (list) | `hourlyRate` and `monthlySalaryPaise` are nulled unless showFinance. Returned to anyone with team:view: email, phone, lastLoginAt, the **full effective permission map of every user**, attendance check-in times, weekly logged minutes. | Every member with team:view (the built-in default) sees each colleague's permission map, contact details, attendance and utilization. There is no field-level split between the directory and HR data. | `users.view`; `users.view_compensation` (pay fields); `users.view_activity` or `attendance.view` (presence and utilization); `roles.view` (permission maps) | organization (directory); own for compensation otherwise | Permission maps and pay are returned only when the caller holds `roles.view` or `users.view_compensation`. Presence and utilization need `attendance.view` at organization scope. |
| 2 | GET | /team/client-users | List client-portal login accounts | router + `requireRole(owner,admin)` (L382) | none | Yes: agencyId + role=client (L398); scope counts also agency-filtered (L412) | n/a | email, lastLoginAt, clientName | Gated by the **team** module although the data belongs to clients. A Manager preset holder with clients:manage cannot see it, but any admin with team:view can. | `client_users.view` | organization, or client (only logins for clients in the caller's scope) | Filter to the clients the caller can see |
| 3 | PATCH | /team/client-users/:id | Edit a client login (name, email, status). An email change mints a reset link. | router team:edit + `requireRole(owner,admin)` (L490) | none beyond role | Yes (L499-505: id + agencyId + role=client) | Loaded with tenant filter and verified | **`resetUrl` returned to the caller** (L554) | (a) Disabling the account (`status=disabled`) does not revoke live access tokens (≤15 min) or open sockets. The refresh check does block. (b) The admin receives a working reset link for the new email, so the admin can take over the client account. (c) The duplicate-email check is **global** (L519), unlike invite, which checks per agency. (d) The audit metadata records only `emailChanged`, not the status change. | `client_users.update`; `client_users.disable`; `client_users.reset_password` | organization / client | Email change and reset-password send the link **only by email**. The URL is never returned unless the caller also holds `users.reset_password` in break-glass mode. Disabling the account revokes its sessions. |
| 4 | DELETE | /team/client-users/:id | Hard-delete a client login and its project scope | router team:manage + `requireRole(owner,admin)` (L563) | none | Yes (L571-575) | Verified | none | Deletion does not invalidate outstanding access tokens. For ≤15 min, the deleted client's token hits `loadPermissions`, which takes the client branch and returns noAccess, so this path is safe. Client-portal routes that don't re-read the user may still pass. | `client_users.delete` | organization / client | Revoke all sessions. Audit it (already done). |
| 5 | POST | /team/invite | Create an **active** user (staff or client) with a random password, plus an invite token | router team:edit + `requireRole(owner,admin)` (L630) | L637: non-owner must pass `canManageRole(ctx.role, body.role)`, so an admin can invite member or client but not admin. L640: `assertPermissionCeiling` on explicit `permissions`. L645-670: for a client invite, the client and projects must belong to the agency and to that client. | Yes: brand (L650), projects (L660), duplicate check per agency (L676-681) | clientId/projectIds verified | **`inviteUrl` containing the raw token** (L804). The `member` echo uses the default `showFinance=true`, so it echoes the `hourlyRate`/`monthlySalaryPaise` from the request. | (a) **Ceiling bypass via defaults**: an invite with no `permissions` inherits agency role defaults or the built-in `manage` on every module, even when the admin's own access is lower. (b) The account is `status:'active'` before acceptance, so forgot-password works on it. (c) The duplicate check is per agency while login is global, so the **same email can exist in two agencies** and login/forgot-password pick an arbitrary row (auth.ts L186-190). (d) An admin can set compensation without holding any finance permission (write without read). (e) No plan `maxTeamMembers` check. (f) A client invite is gated by the team module, not clients. (g) No endpoints to revoke or resend an invite. | `users.invite` (staff); `client_users.invite` (client logins); `users.update_compensation` when the pay fields are present; `roles.assign` when `permissions` is present | organization (staff); client (client logins) | Role rank strictly below the caller's. The effective permissions the invitee will have (overrides, role defaults, built-in) must be ≤ the caller's for every non-owner caller. The email must be globally unique or login must be agency-qualified. The invite URL is emailed only; the account stays `pending` until accepted. |
| 6 | GET | /team/:userId | Member detail: profile, projects, active tasks, the last 20 time logs, totals, presence | router team:view | **None** (no self-or-privileged check). showFinance applies (L957). | Yes: user (L822), all sub-queries agency-filtered | Loaded with tenant filter. **Does not exclude role=client users.** | Pay fields filtered. **Time-log notes, task titles, project names** and the permission map are exposed. | **Inconsistent with #11**: GET /:userId/time-logs requires self or privileged, but this endpoint returns the same logs (20 most recent, with notes) to anyone with team:view. It also returns client-login users through the staff detail view. | `users.view` (profile); `time_logs.view` (logs, with scope); `tasks.view` | profile: organization; time logs and tasks: own / project / organization | Include `timeLogs`/`activeTasks` only when the caller has `time_logs.view` at a scope covering the target (own, shared project, or organization). Reject role=client targets (use client_users). |
| 7 | PATCH | /team/:userId | Change role, custom role, status, permission overrides, and profile/HR/compensation fields | router team:edit + `requireRole(owner,admin)` (L1048) | `touchesPrivilege` = role / customRoleId / status / permissions (L1065-1069). (1) Self plus privileged fields is refused (L1073). (2) Owner target plus privileged fields gives 409 (L1079). (3) Non-owner must pass `canManageRole(ctx.role, target.role)` **only when touchesPrivilege** (L1084). (4) Only the owner can grant owner (L1088). (5) Non-owner must pass `canManageRole(ctx.role, body.role)` (L1092). (6) `assertPermissionCeiling` (L1100). Custom role: must belong to the agency (L1110-1117), and a non-owner must pass `canManageRole(ctx.role, cr.baseRole)` (L1120). | Yes (L1055-1060) | Verified via tenant filter | Response is `{updated:true}` only | (a) **Profile and compensation edits skip the rank check**: an admin can change the owner's or another admin's `hourlyRate`, `monthlySalaryPaise`, name, phone, designation and capacity (and can edit their own salary). (b) **Converting a client to staff**: target role=client is manageable (rank 0), so `role:'member'` turns a client-portal login into staff with the default `manage` everywhere while keeping `clientId`. (c) **Custom-role assignment skips the ceiling**: `cr.permissionsJson` is never compared with the caller's permissions (L1105-1128). (d) Clearing a custom role (`customRoleId:null`) leaves `permissionsJson` null (it was wiped on assignment, L1128), so the user falls back to role defaults or `manage` everywhere. (e) Setting status to disabled or changing role doesn't revoke tokens or sockets. A demoted admin keeps the admin token role for ≤15 min, but `loadPermissions` reads live overrides. (f) Setting compensation needs no finance permission. (g) The audit records `team.update` with no diff. | Split by field group: `users.update_profile`; `users.update_compensation`; `users.disable` (status); `roles.assign` (role, customRoleId, permissions) | update_profile: own (limited fields) / organization; compensation: organization; disable and assign: organization | Every mutation, not only privileged ones, requires target rank < caller rank unless the target is the caller (own profile only). Owner is immutable except by the owner for profile. `roles.assign` is refused on self. The resulting effective permission map must be ≤ the caller's (built-in roles, custom roles and overrides alike). Client-role targets are refused (use client_users). Changes bump `users.perm_version`. Disabling revokes sessions. |
| 8 | DELETE | /team/:userId | Hard-delete a member (FK cascade) | router team:manage + `requireRole(owner,admin)` (L1177) | Self is refused (L1187). Owner gives 409 (L1190). Non-owner must pass `canManageRole` (L1194). | Yes (L1184, L1202) | Verified | none | **Fail-open after deletion**: the deleted user's access token stays valid ≤15 min, and `loadPermissions` finds no row and resolves to `manage` on every module (permissions.ts L134-150). Also accepts role=client targets, which duplicates #4. Sockets stay connected. | `users.delete` | organization | Rank strictly below the caller's. Not self, not owner. Revoke all sessions. `loadPermissions` must fail closed. Prefer soft delete (disable plus anonymize). |
| 9 | POST | /team/:userId/reset-password | Admin-initiated password reset link | router team:edit + `requireRole(owner,admin)` (L1222) | L1241: self, or owner, or `canManageRole(ctx.role, member.role)`. L1244: target must be active. | Yes (L1236) | Verified | **`resetUrl` returned** (L1258) | Returning the link lets an admin **take over any lower-ranked account** without trace beyond the `team.password_reset` audit entry (impersonation). Existing sessions of the target are not revoked. Outstanding reset tokens aren't invalidated when a new one is issued. | `users.reset_password` | organization | Rank strictly below the caller's. The link goes to the target's email only. Returning the URL needs a separate `users.impersonate`/break-glass permission, owner only. On reset, revoke the target's sessions. |
| 10 | POST | /team/:userId/time-logs | Log time for a user | router **team:edit** | L1291: self, or `isPrivileged`. L1294: target in agency. L1298-1327: project and task belong to the agency; task belongs to project. | Yes | Target and project/task verified for tenant only | none | (a) Members need **team:edit** just to log their own time (the Employee preset has team:view, so it cannot). The team module is the wrong gate. (b) No check that the user is a member of or assigned to the project. (c) Admins can log time as the owner or other admins (no rank check). (d) `isPrivileged` ignores module permissions. | `time_logs.create` | own; project (lead logs for project members); organization | Self: must be a member of the project or task (or have project:view). Others: need `time_logs.create` at project scope covering the target's membership, or organization scope. |
| 11 | GET | /team/:userId/time-logs | List a user's recent time logs (50) | router team:view | L1383: self, or `isPrivileged`. L1386: target in agency. | Yes (L1401) | Verified | note text | Bypassed through #6. Employees without team:view cannot read their own logs. | `time_logs.view` | own / project / organization | Same scope resolution as #10 |
| 12 | GET | /team/:userId/activity | The audit-log events this user performed | router team:view | L1432: self, or `isPrivileged`. L1435: target in agency. | Yes (L1449) | Verified | Full audit `metadata` (can include emails and roles of invitees) | An admin can read the owner's and other admins' activity (no rank check). The metadata is unfiltered. | `users.view_activity` (others); own activity is implicit | own / organization | Viewing others needs rank ≥ target's or `audit_log.view`. Redact metadata for non-auditors. |
| 13 | GET | /team/clients/:clientId/assignments | List which staff are assigned to a client | router team:view + `requireRole(owner,admin)` (L1484) | L1487: `requireClientAccess` (agency only) | Yes (L1496) | Client verified for tenant | none | Gated by the team module rather than clients. Note: assignments barely affect access. `requireClientAccess` ignores them, and they are only consulted in `clients.ts` L110 when the caller lacks clients:view. | `client_assignments.view` | organization / client | Filter by the caller's client scope |
| 14 | POST | /team/clients/:clientId/assignments | Assign a user to a client | router team:edit + `requireRole(owner,admin)` (L1509) | L1512: `requireClientAccess`. L1516-1523: user in agency. | Yes | Client and user verified for tenant | none | Doesn't check that the user is **staff** (a client-role user can be assigned), active, or rank-manageable. `onConflictDoNothing` still writes `client.assign` to the audit log. | `client_assignments.manage` (or `.create`) | organization / client | Target must be active staff. If assignments are to become a scope source (the "assigned" scope), the caller needs the client in their own scope. |
| 15 | DELETE | /team/clients/:clientId/assignments/:userId | Unassign | router team:manage + `requireRole(owner,admin)` (L1553) | L1556: `requireClientAccess` | Yes (L1561) | Tenant-filtered delete; no existence check | none | **No audit.** Returns success even when nothing was deleted. | `client_assignments.manage` (or `.delete`) | organization / client | Audit `client.unassign` |

---

## 2. `/api/v1/agency` — routes/agencies.ts

Router-level gate: `requireAuth` only (L39). There is **no router-level module gate**, and each route adds its own.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter? | Object scoping | Sensitive fields in response | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy / escalation rule |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 16 | GET | /agency/storage | Disk usage, backups, alerts | `requireRole(owner,admin)` + settings:view (L45-46) | none | **No.** `getStorageStatus()` takes no agency (services/storage-status.ts L37) | Host-global | Host disk and backup details | **Cross-tenant info leak** in any multi-agency deployment: admins of any agency see server-wide storage. | `storage.view` | platform (not tenant); in a single-tenant deployment, organization | Platform operators only, or restrict to agencies flagged `isPlatformOwner` |
| 17 | POST | /agency/storage/archive | Run the media archive/retention job (`dryRun`, `olderThanDays`) | `requireRole(owner,admin)` + settings:manage (L61-62) | none | **No.** `runMediaArchive` scans every agency's `documents` and media (media-archive.ts L91-120+) | Global | Counts | **Critical: cross-tenant destructive action.** Any agency's admin can pass `olderThanDays:0` to archive and delete the local copies of **all tenants'** media (when a backup remote exists). No audit. Admin-reachable, not owner only, although the comment says "(owner)". | `storage.archive` | platform | Platform-operator only. Require an explicit confirmation token. Audit it. Don't let the request override retention without a separate permission. |
| 18 | GET | /agency | Current agency profile (name, slug, logo, theme, status) | requireAuth only | none | Yes (L79) | Own agency | none | Reachable by the **client** role too. Harmless (branding). | none (implicit for any authenticated principal), or `organization.view_basic` | organization | none |
| 19 | PATCH | /agency | Edit branding and theme | `requireRole(owner,admin)` + settings:manage (L106-107) | none | Yes (L117) | Own agency | none | **No audit.** `logoUrl` accepts any URL (tracking pixel / mixed content). Needs **manage** where edit would be the natural level. | `organization.update` (settings) | organization | Audit `organization.update` with a diff |
| 20 | GET | /agency/usage | Plan usage, AI/storage counters, rate-limit config | `requireRole(owner,admin)` (L135). **No module gate.** | none | Yes (L143, L160, L171, L182, L189) | Own agency | `env.AI_PROVIDER`, `env.GEMINI_MODEL`, rate-limit config | No settings-module gate, unlike its sibling endpoints. Leaks deployment config (low). The team count includes client logins. | `usage.view` | organization | none |
| 21 | GET | /agency/audit-log | The agency's audit events | `requireRole(owner,admin)` (L227). **No module gate.** | none | Yes (L233) | Own agency | Full metadata (emails, roles) | (a) **Bug**: `.orderBy(auditLog.createdAt)` is ascending with `limit(100)`, so it returns the **oldest** 100 events, not the most recent. (b) An unguarded `JSON.parse` returns 500 on a malformed row. (c) Admins see the owner's actions. No pagination or filtering. | `audit_log.view` | organization | Owner, or anyone granted `audit_log.view` |
| 22 | GET | /agency/roles | Module catalog, per-role default matrix, presets | `requireRole(owner,admin)` + settings:view (L262-263) | none | Yes (L269) | Own agency | none | none significant | `roles.view` | organization | none |
| 23 | PUT | /agency/roles | Merge-update the admin/member role-default maps | `requireRole(owner,admin)` + settings:manage (L291-292) | **none** | Yes (L300, L318) | Own agency | none | **Privilege escalation**: (a) An admin can raise the **admin** defaults, i.e. **their own** permissions, undoing the owner's restrictions. (b) An admin can raise member defaults above their own access. No ceiling check and no self-exemption. (c) Changes take effect immediately (live read) but aren't versioned. (d) The audit has no diff. | `roles.update` | organization | Only the owner can change admin-tier defaults. For member defaults, each level must be ≤ the caller's. Never allowed for defaults that apply to the caller. Bump the agency `perm_version`. Audit the before and after. |
| 24 | GET | /agency/custom-roles | List custom roles | `requireRole(owner,admin)` + settings:view (L353-354) | none | Yes (L360) | Own agency | none | none | `roles.view` | organization | none |
| 25 | POST | /agency/custom-roles | Create a custom role (baseRole admin or member, plus a permission map) | `requireRole(owner,admin)` + settings:manage (L375-376) | Duplicate name only (L380-385) | Yes | n/a | none | **An admin can create a baseRole='admin' role** and set a permission map above their own. Assigning it is blocked by users.ts L1120, but see #26. No ceiling check. | `roles.create` | organization | A non-owner can only create `baseRole` strictly below their own tier, with a permission map ≤ their own |
| 26 | PATCH | /agency/custom-roles/:id | Rename or recolor a role, change its baseRole or permission map. **Re-tiers all holders.** | `requireRole(owner,admin)` + settings:manage (L412-413) | **none** | Update is tenant-filtered (L427, L433). **The re-select at L435 is NOT** (`where id` only). | Not verified before the update. The response reads by id alone. | none | **Most serious escalation path in this file group**: (a) An admin can PATCH a member-tier role to `baseRole:'admin'`, which promotes **every holder** to admin (L429-434). This bypasses the rank checks in users.ts. (b) An admin holding a custom role can edit **that role's permissions**, a self-escalation that bypasses the users.ts self-edit guard (L1073). (c) An admin can demote admin-tier roles and their holders (other admins). (d) **Cross-tenant IDOR read**: a PATCH with another agency's role id is a no-op update, but L435 returns that role's name and permissions (ids are random, so exploitability is low). (e) **No audit.** (f) No 404 before the writes. | `roles.update` | organization | The role must belong to the agency (load and verify first). A non-owner can only edit roles with baseRole below their tier and cannot set baseRole ≥ their tier. The permission map must be ≤ theirs. The caller must not hold the role. Bump perm_version for the holders. Audit with a diff. |
| 27 | DELETE | /agency/custom-roles/:id | Delete a custom role and detach its holders | `requireRole(owner,admin)` + settings:manage (L443-444) | **none** | Yes (L452, L455) | Tenant-filtered writes, no existence check | none | (a) **Escalation by deletion**: holders' `permissionsJson` was wiped on assignment (users.ts L1128), so after detachment they fall back to role defaults or the built-in `manage` on every module. (b) An admin can delete admin-tier roles. (c) **No audit.** (d) Always returns `{deleted:true}`. | `roles.delete` | organization | Refuse while the role has holders, or require a replacement role. A non-owner can only delete roles below their tier. Bump perm_version. Audit it. |

---

## 3. `/api/v1/auth` — routes/auth.ts

No router-level gates. `authLimiter` is 20 requests per 15 min per IP and is **disabled when NODE_ENV != production**.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter? | Object scoping | Sensitive fields in response | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy / escalation rule |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 28 | POST | /auth/signup | Create an agency plus its owner, then sign in | authLimiter | `env.ALLOW_SIGNUP` check (L91). Global email-uniqueness check (L102-109). | n/a (creates a tenant) | n/a | **access and refresh tokens in the body** (L172) plus cookies | The tokens in the body make the SPA store them in JS-reachable storage, so XSS leads to a 30-day refresh-token theft. | public (feature flag) | none | Create a server-side session row |
| 29 | POST | /auth/login | Password login | authLimiter | Status must be active (L193). Password verified (L196). | Email lookup is **global, `limit 1`** (L186-190) | The user row is chosen arbitrarily when the email exists in more than one agency | tokens in the body | (a) **Multi-agency ambiguity**: the unique index is `(agencyId, lower(email))` (schema.ts L137) while login is global. An attacker agency can invite a victim's email, and the victim's logins or resets may resolve to the wrong row (DoS or confusion). (b) No per-account lockout; only the IP limiter, which is off outside production. (c) Failed logins are not audited. | public | none | Make email globally unique, or add an agency selector. Audit `auth.login_failed`. Create a session row. |
| 30 | GET | /auth/invite?token= | Preview an invite (email, role, agency name, full name) | none (not even authLimiter) | Token must be pending and unexpired (L235-256) | By token | Token hash | email, agencyName | No rate limit. The 256-bit opaque token makes brute force impractical. | public (token-bound) | invite | none |
| 31 | POST | /auth/accept-invite | Set a password on the invited account and sign in | authLimiter | Pending invite (L303). Member found by `(invite.agencyId, invite.email)` (L259-271) and active (L307). | Yes (agency from invite) | Member found by email, not by id | tokens | (a) The invite token is returned to the inviting admin (#5), so the admin can set the invitee's password. (b) The lookup is by email: if the account's email changed (client-users PATCH), the invite no longer maps to that account, or maps to a different user who later took the email. (c) Doesn't check that `invite.role` matches `member.role` (the role may have been changed since). (d) Other invites or sessions are not revoked. | public (token-bound) | invite | Bind the invite to `userId`, not email. Mark the user `pending` until accepted. |
| 32 | POST | /auth/forgot-password | Email a reset link (always 200) | authLimiter | Active user only (L364) | **Global `limit 1`** (L358-362) | Arbitrary row on a duplicate email | none (the link goes only by email) | Same multi-agency ambiguity as #29. Response time differs when the user exists (DB insert plus audit), a minor enumeration channel. Earlier reset tokens stay valid. | public | none | Invalidate earlier tokens when issuing a new one |
| 33 | GET | /auth/reset-password?token= | Validate a reset token and return its email | none | Valid token (L380-394) | By token | Token hash | email | No rate limit (token entropy makes this acceptable) | public (token-bound) | reset token | none |
| 34 | POST | /auth/reset-password | Consume the token, set the password, sign in | authLimiter | Valid token. User active (L425). Burns all outstanding tokens (L435-443). | By token | Verified by `reset.userId` | tokens | **Existing sessions and refresh tokens are not revoked** after a password reset, so an attacker's stolen 30-day refresh token survives the reset. | public (token-bound) | reset token | Revoke all of the user's sessions (bump `session_version`) |
| 35 | POST | /auth/change-password | Change your own password | `requireAuth` (L480) | Current password verified (L490) | Looks up the user by id only (L486) | own | none | Other sessions are not revoked. No rate limiter, so the current password can be brute-forced by a holder of a stolen access token (bounded by globalLimiter 300/min). | none (implicit own), or `account.update_password` | own | Revoke other sessions. Add authLimiter. |
| 36 | POST | /auth/refresh | Rotate access and refresh tokens | authLimiter | Refresh JWT verified (L528). User exists with matching agencyId and status active (L534-544). **Role and clientId are re-read from the DB** (L546-553). | Yes (L538) | own | tokens | (a) **No server-side state**: old refresh tokens remain valid for their full 30 days after rotation (no rotation invalidation, no reuse detection). (b) Logout and password changes cannot kill a refresh token. (c) The token is accepted from the cookie, the body or Bearer. (d) authLimiter at 20/15min per IP on refresh can lock out offices behind NAT. | public (token-bound) | own session | Server-side session with rotation, reuse detection and a `session_version` check |
| 37 | POST | /auth/logout | Clear cookies | **none** (no requireAuth) | `if (req.auth)` audit (L560) is **dead code**, because `req.auth` is never populated on this route | n/a | n/a | none | (a) **No server-side revocation**: the access token stays valid 15 min and the refresh token 30 days (they are also stored in the SPA). (b) The `auth.logout` audit never fires. (c) Push tokens aren't detached server-side (the client must call #40). | none (own session) | own | Revoke the session by `sid` (from the access or refresh token). Audit it. |
| 38 | GET | /auth/me | Current user, agency, plan, effective permissions, persona | `requireAuth` (L573) | none | Yes (L578, L585, L592, L613) | own | none | Returns `permissions` computed from `user.role` in the **DB**, while middleware gates on the **token** role, so the UI and API can disagree for ≤15 min after a role change. The persona heuristic `projects==='manage'` means manager. | none (own) | own | Include `perm_version`, so the client can refetch when it changes |

---

## 4. `/api/v1/push` — routes/push.ts

Router gate: `requireAuth` (L15). No module gate, by design.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter? | Object scoping | Sensitive fields | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 39 | POST | /push/register | Upsert the device's FCM token for the caller | requireAuth | none | Stores ctx.agencyId | Token is the PK | none | `onConflictDoUpdate` on `token` **rebinds an existing token to the caller**. Anyone who learns another user's FCM token can hijack that device registration (the victim stops getting their pushes and receives the attacker's). Low likelihood. Client-role users are also allowed (intended). | `push.manage_own` (implicit) | own | On conflict, only rebind when the device is signing in to a new account. Accept it as a known tradeoff, or require the prior owner's session to be ended. |
| 40 | DELETE | /push/register?token= | Detach a device token | requireAuth | Deletes only when `userId = ctx.userId` (L50) | n/a (user-bound) | Verified by userId | none | none | `push.manage_own` | own | none |

## 5. `/api/v1/notifications` — routes/notifications.ts

Router gate: `requireAuth` (L11).

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter? | Object scoping | Sensitive fields | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 41 | GET | /notifications | List the caller's notifications | requireAuth | none | Filters by userId only (globally unique id) | own (L18) | Notification bodies | Notifications created before a permission downgrade stay readable (for example lead titles after losing business access). Acceptable. | `notifications.view_own` (implicit) | own | none |
| 42 | GET | /notifications/unread-count | Unread count | requireAuth | none | userId | own | none | none | implicit own | own | none |
| 43 | POST | /notifications/:id/read | Mark one as read | requireAuth | Update filtered by `userId` (L50) | userId | Verified in the WHERE clause; a silent no-op otherwise | none | none (returns `{read:true}` even for a foreign id, so no information leak) | implicit own | own | none |
| 44 | POST | /notifications/read-all | Mark all as read | requireAuth | userId | userId | own | none | none | implicit own | own | none |

## 6. Root-mounted and public endpoints

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter? | Object scoping | Sensitive fields | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 45 | PUT | /uploads/local?key&exp&sig | Receive raw upload bytes for a presigned key | None (mounted before cookies and limiter). HMAC token only (uploads.ts L29). | `verifyUploadToken` does a timing-safe HMAC over `key.exp` (local-storage.ts L38-47). `safeKey` rejects `..` and NUL (L22-24). | Implicit in the signed key | Key bound by signature | publicUrl | (a) The HMAC key is **`JWT_ACCESS_SECRET`** (local-storage.ts L32), so rotating the JWT secret for mass revocation also breaks upload tokens, and the secret is reused across purposes. (b) The Content-Type is client-controlled and files are served statically from `/files`, a stored-XSS risk if HTML or SVG is served inline. (c) Not rate limited (outside `/api/v1`). (d) A token can be replayed until `exp` (overwrite). | none (capability URL). The token is minted under `media.upload` / `documents.create` elsewhere. | object (key) | Use a dedicated secret. Put the agency id in the key prefix and check it. Force `Content-Disposition: attachment` for non-image types. |
| 46 | GET | /health[?test_smtp=1] | Liveness, DB status, email flag, optional SMTP verify | none | none | n/a | n/a | **`smtpError` raw message**, `email` flag, uptime | **Unauthenticated `?test_smtp=1`** opens an outbound SMTP connection and authenticates with the stored credentials on every call (abuse, account lockout at the provider, error text that can reveal the host or user). No rate limit. | public (basic liveness); `platform.diagnostics` for test_smtp | platform | Move SMTP verification behind platform-admin auth |
| 47 | POST | /api/v1/intake/lead | Website contact form creates a lead in `INTAKE_AGENCY_ID` | Shared secret header `x-intake-key` (intake.ts L22) | none | Agency fixed from env | n/a | leadId | Secret compared with `!==` (not constant time, low impact). globalLimiter applies in production only. No audit. | machine credential: `leads.create` via an API key | organization (fixed) | Replace with per-agency API keys (hashed, revocable, scoped to `leads.create`) |
| 48 | GET | /api/v1/oauth/meta/callback | Facebook Login redirect: exchange the code and store an encrypted connect session | Signed state JWT (`verifyOAuthState`, key `JWT_ACCESS_SECRET:meta-oauth-state`, with audience) | State must be valid (L13-20) | Agency, client and user taken from the signed state | Not re-verified | Redirect carries `meta_session` id or `meta_error` text | Doesn't re-check that `state.userId` is still active and allowed on `state.clientId` at callback time (the state lifetime bounds this). JWT_ACCESS_SECRET is reused again. The session payload is sealed with the vault (AES-GCM). | public (state-bound). The state is minted under `social_accounts.connect`. | client | Re-validate the user, and the user's permission on the client, when consuming the connect session |
| 49 | POST | /api/v1/oauth/meta/deauthorize | Meta callback: revoke social accounts for a Meta user | `signed_request` HMAC with `META_APP_SECRET` (meta.ts L437-453, timing-safe) | none | **Cross-tenant by design** (all agencies with that metaUserId) | metaUserId | none | Acceptable (platform-driven). No audit. | platform webhook | platform | Audit per affected agency |
| 50 | POST | /api/v1/oauth/meta/data-deletion | Meta callback: delete social accounts for a Meta user | Same HMAC | none | Cross-tenant by design | metaUserId | Confirmation URL | No audit. The confirmation code isn't stored, so #51 is a static response. | platform webhook | platform | Audit it |
| 51 | GET | /api/v1/oauth/meta/deletion-status?code= | Static "completed" status page | none | none | n/a | n/a | Echoes `code` as JSON (not HTML) | Always reports completed for any code (a compliance nicety, not a security issue) | public | none | none |

---

## 7. Cross-cutting findings (middleware and lib)

1. **CORS lets any `*.vercel.app` and `*.netlify.app` origin make credentialed requests** (origin.ts L20-28), in production too. Combined with `SameSite=None; Secure` cookies (cookies.ts L10-16) and no CSRF token check (the `X-CSRF-Token` header is allowed but never validated anywhere), **a page hosted by anyone on vercel.app can make authenticated API calls as a logged-in user and read the responses**. This is the most severe issue in scope. Allow only exact origins.
2. **`loadPermissions` fails open** when the user row is missing (permissions.ts L134-150 → lib/permissions.ts L526, default `manage`). Any valid access token for a deleted user grants manage on every module for ≤15 minutes.
3. **`requireAuth` makes no DB check** (auth.ts L12-45): disabled or deleted users and stale roles work until the access token expires. `requireRole` and `isPrivileged` use the token role, while module permissions use live DB data, which produces mixed-freshness decisions.
4. **Sockets** authenticate only at the handshake (realtime/socket.ts L100-112) and are never re-checked. A disabled, deleted or demoted user keeps receiving realtime events until they disconnect.
5. **The built-in `DEFAULT_LEVEL='manage'`** (lib/permissions.ts L421) means every path that clears overrides (custom role delete or clear, new invite without a map, client converted to member) **escalates** to full module access.
6. **Rate limiting and error redaction depend on `NODE_ENV==='production'`** (rate-limit.ts L11; error.ts L87-91). A misconfigured deployment has no auth limiter and leaks internal error messages.
7. **Multi-purpose secrets**: `JWT_ACCESS_SECRET` signs access JWTs, upload HMACs and the Meta OAuth state. Revocation by secret rotation has side effects.
8. **Tokens are returned in JSON bodies** (auth.ts L172, 226, 346, 470, 554; portal.ts L89-95) and stored by the SPA, which widens XSS impact and makes server-side revocation mandatory.
9. **`ROLE_PRESETS.employee`** omits the `business` key (lib/permissions.ts L693-706). The backstop forces it to none, so there is no impact, but custom role maps missing a key inherit `manage`.
10. **Assignments are nearly decorative**: `requireClientAccess` ignores them (tenant.ts L250-256). An "assigned" scope in the new model will need real enforcement points.

---

## 8. Auth and session lifecycle (as implemented)

### 8.1 Token issuance
- **Access token**: HS256 JWT signed with `JWT_ACCESS_SECRET`. Claims: `sub=userId`, `agencyId`, `role`, `clientId?` (client role only), `type:'access'`, `iat`, `exp=15m` (lib/jwt.ts L4, L45-62). **No `jti`, `sid`, session version or permission version.**
- **Refresh token**: HS256 JWT signed with `JWT_REFRESH_SECRET`. Claims: `sub`, `agencyId`, `type:'refresh'`, `exp=30d` (lib/jwt.ts L5, L64-74). **No `jti`, `sid` or version.**
- Issued by `issueSession()` (auth.ts L53-78) in: signup (L154), login (L204), accept-invite (L322), reset-password (L445), refresh (L546). **Also issued outside `issueSession`** by `POST /api/v1/portal/session` (portal.ts L88-95), which exchanges a share-link portal token for a full `client` session. Those tokens are not tied to the `portalTokens` row, so revoking the link does **not** end sessions already obtained with it.
- Delivery: httpOnly cookies `sanctum_at` (maxAge 15m) and `sanctum_rt` (maxAge 30d), `Secure` and `SameSite=None` in production and `Lax` in dev, `path=/` (lib/cookies.ts). The tokens are **also in the response body** for Bearer use on iOS.

### 8.2 Verification
- HTTP: `requireAuth` takes the cookie first, then Bearer. It checks the signature, `exp` and `type` only.
- Socket.IO: cookie `sanctum_at`, or `handshake.auth.token`, then `verifyAccessToken`, plus a name lookup that doesn't check status (socket.ts L93-112). There is a separate portal-token branch.
- Authorization data: role and clientId from the token. Module permissions are read live from the DB per request (`loadPermissions`).

### 8.3 Refresh
`POST /auth/refresh` accepts the refresh token from the cookie, the body `refreshToken`, or Bearer. It verifies the JWT, loads the user by `(sub, agencyId)`, requires `status==='active'`, and issues a **new pair with role and clientId re-read from the DB**. The old refresh token is **not** invalidated (stateless).

### 8.4 Logout
`POST /auth/logout` only clears cookies. There is no requireAuth, so the audit branch is unreachable. Nothing is revoked server-side, and Bearer-stored tokens survive untouched.

### 8.5 What is stored server-side
- `users.passwordHash`, `status`, `role`, `customRoleId`, `permissionsJson`, `lastLoginAt`.
- `password_resets` (sha256 token hash, 1h TTL, `usedAt`). `invites` (sha256 token hash, 7d, status).
- `portal_tokens` (hash, revoked, expiresAt, lastUsedAt).
- `audit_log` rows.
- **No session, refresh-token or device table, and no deny list.** The only mass revocation available is rotating `JWT_REFRESH_SECRET` (and `JWT_ACCESS_SECRET`, which also breaks upload URLs and OAuth state).

### 8.6 Effective revocation latency today
| Event | Access token | Refresh token | Socket |
|---|---|---|---|
| Status set to disabled (team PATCH / client-users PATCH) | ≤15 min | Blocked at next refresh (status check) | Until disconnect |
| User deleted | ≤15 min, **with fail-open manage-all** | Blocked (user not found) | Until disconnect |
| Role change | ≤15 min with the old role (`requireRole`) | New role on refresh | Old role until reconnect |
| Permission override, role default or custom role change | Immediate (live read) | n/a | Socket handlers that check modules: depends on the handler |
| Password reset or change | **Not revoked** | **Not revoked (30d)** | Not revoked |
| Logout | **Not revoked (15m)** | **Not revoked (30d)** | Not revoked |
| Portal share link revoked | Sessions minted via /portal/session **not revoked** | Not revoked (30d; client user stays active) | Portal sockets: verified at the handshake only |

---

## 9. Changes required for session revocation and permission-version invalidation

### 9.1 Schema
1. New `sessions` table: `id` (sid), `userId`, `agencyId`, `kind` (`password` / `invite` / `reset` / `portal_link` / `signup`), `portalTokenId?`, `refreshTokenHash`, `refreshFamilyId`, `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt`, `revokedReason`, `ip`, `userAgent`. Indexes on `(userId)` and `(agencyId)`.
2. `users.session_version INTEGER NOT NULL DEFAULT 0`. Bumping it kills every session of the user.
3. `users.perm_version INTEGER NOT NULL DEFAULT 0` for user-level grants, **and** `agencies.perm_version` for role defaults and custom roles (or bump each holder's `users.perm_version` in the same transaction).
4. Optional: bind `invites.userId` so acceptance doesn't depend on email. Add `invites.status` `revoked` endpoints.
5. Separate `UPLOAD_HMAC_SECRET` and `OAUTH_STATE_SECRET` from `JWT_ACCESS_SECRET`.

### 9.2 Tokens (lib/jwt.ts)
- Access claims: add `sid`, `sv` (session_version), `pv` (user perm_version, optionally combined with the agency version), and `jti`.
- Refresh claims: add `sid` and `jti`. Store only the hash of the refresh token in `sessions` and rotate it on every refresh.

### 9.3 Issuance points that must create a session row (all of them)
- auth.ts `issueSession` (signup L154, login L204, accept-invite L322, reset-password L445, refresh L546).
- **portal.ts L88-95** (`POST /portal/session`) must go through the same issuer and record `portalTokenId`.
- Any future impersonation or break-glass feature.

### 9.4 Verification points
- `middleware/auth.ts requireAuth`: after the JWT check, look up `(sid, userId)` together with `users.status`, `session_version`, `perm_version` and `role` (cache per request, plus a short in-process LRU of about 5-30s). Reject when revoked, disabled, deleted or `sv` mismatches. When `pv` or the role differs, either reject with `401 PERMISSIONS_CHANGED` so the client refreshes, or overwrite `req.auth.role` with the DB role.
- `middleware/permissions.ts loadPermissions`: **fail closed** when the row is missing. Use the DB role, not the token role, when choosing the owner/client short-circuits.
- `realtime/socket.ts` handshake: the same checks. Also subscribe each socket to a `user:{id}` revocation channel and call `socket.disconnect(true)` on revoke or pv bump, or re-validate periodically.
- `middleware/tenant.ts requirePortalToken` and the socket portal branch: already check `revoked`. Make sessions created from a portal token also revoked when it is (cascade via `sessions.portalTokenId`).
- `POST /auth/refresh`: look up the session by `sid`, compare the hash of the presented token, detect reuse (a hash mismatch within the family revokes the whole family), check `session_version`, rotate the hash, update `lastUsedAt`.

### 9.5 Mutation sites that must revoke sessions or bump versions
| Site | File:line | Action |
|---|---|---|
| PATCH /team/:userId, status → disabled | users.ts L1137 | bump `session_version` (revoke all) |
| PATCH /team/:userId, role / customRoleId / permissions | users.ts L1105-1156 | bump `perm_version`; if the role changed, also force re-issue (role is in the token) |
| DELETE /team/:userId | users.ts L1200 | revoke all sessions (the cascade removes them if FK); disconnect sockets |
| POST /team/:userId/reset-password | users.ts L1248 | optionally revoke; at minimum revoke when the reset is consumed |
| PATCH /team/client-users/:id, status or email | users.ts L511-525 | bump `session_version` |
| DELETE /team/client-users/:id | users.ts L588 | revoke all |
| PUT /agency/roles | agencies.ts L312 | bump `agencies.perm_version` |
| PATCH /agency/custom-roles/:id | agencies.ts L424-434 | bump pv for holders (and session/role re-issue when baseRole changes) |
| DELETE /agency/custom-roles/:id | agencies.ts L449-455 | bump pv for holders |
| POST /auth/reset-password | auth.ts L429 | bump `session_version` (all sessions), then issue a fresh one |
| POST /auth/change-password | auth.ts L493 | revoke all sessions except the current `sid` |
| POST /auth/logout | auth.ts L558 | revoke the current `sid` (read it from the access or refresh token even when expired); fix the audit |
| lib/client-portal-login.ts `mintClientPortalLogin` (resets password and reactivates) | L96-102 | bump `session_version` of the existing client user |
| clients.ts portal-login routes, and proposals/agreements/invoices callers of `mintClientPortalLogin` (outside this scope) | — | same as above |
| Portal token revoke (outside this scope, clients.ts) | — | revoke sessions with that `portalTokenId` |
| Agency status suspended (if it exists) | — | bump all users' session_version, or check agency status in requireAuth |

### 9.6 Client (frontend) contract changes
- Handle `401 SESSION_REVOKED` (go to login) and `401 PERMISSIONS_CHANGED` (call `/auth/refresh`, then refetch `/auth/me`).
- `/auth/me` returns `permVersion`; socket event `session:revoked` and `perms:changed`.
- New endpoints: `GET /auth/sessions` (own), `DELETE /auth/sessions/:sid` (own), `DELETE /team/:userId/sessions` (`users.revoke_sessions`, rank-checked).

---

## 10. audit() call sites in scope

| File:line | Action | Entity | Notes |
|---|---|---|---|
| users.ts L542 | `team.client_user.update` | user | metadata `{emailChanged}` only; the status change is not recorded |
| users.ts L590 | `team.client_user.delete` | user | |
| users.ts L747 | `team.invite` | user | metadata `{email, role}`; the permissions granted are not recorded |
| users.ts L1159 | `team.update` | user | **no diff** (role, status, permissions or compensation changes indistinguishable) |
| users.ts L1204 | `team.delete` | user | |
| users.ts L1249 | `team.password_reset` | user | the URL was also returned to the actor, which is not noted |
| users.ts L1342 | `team.time_log.create` | user | metadata `{timeLogId, minutes}` |
| users.ts L1536 | `client.assign` | client | metadata `{userId}`; logged even when it was a no-op |
| agencies.ts L320 | `roles.update` | agency | no diff |
| agencies.ts L395 | `role.create` | custom_role | metadata `{name, baseRole}`. Note the inconsistent prefix, `role.` vs `roles.`. |
| auth.ts L159 | `agency.signup` | agency | |
| auth.ts L210 | `auth.login` | — (no entity) | successful logins only |
| auth.ts L328 | `team.invite.accept` | user | |
| auth.ts L366 | `auth.password_reset.request` | user | |
| auth.ts L452 | `auth.password_reset` | user | |
| auth.ts L497 | `auth.password_change` | user | |
| auth.ts L561 | `auth.logout` | — | **unreachable** (`req.auth` is never set on this route) |

No audit calls exist in push.ts, notifications.ts, uploads.ts, health.ts, intake.ts or oauth.ts, or in any middleware or lib file in scope.

**Missing audits (security relevant):** DELETE /team/clients/:clientId/assignments/:userId; PATCH /agency; POST /agency/storage/archive; PATCH /agency/custom-roles/:id; DELETE /agency/custom-roles/:id; failed login; refresh or session reuse; the oauth deauthorize and data-deletion webhooks; intake lead creation.

Proposed normalized action names: `users.invite`, `users.update_profile`, `users.update_compensation`, `users.disable`, `users.delete`, `users.reset_password`, `roles.assign`, `roles.create/update/delete`, `role_defaults.update`, `client_users.update/disable/delete`, `client_assignments.create/delete`, `organization.update`, `storage.archive`, `auth.login`, `auth.login_failed`, `auth.logout`, `auth.session_revoked`, `auth.refresh_reuse_detected`, `time_logs.create`.

---

## 11. Proposed permission keys derived from this scope (minimal set)

| Key | Replaces today | Default holders (suggested) |
|---|---|---|
| `users.view` | team:view | owner, admin, member |
| `users.invite` | team:edit + role owner/admin | owner, admin |
| `users.update_profile` | team:edit + role owner/admin (profile fields) | owner, admin; own subset for self |
| `users.update_compensation` | (none; ungated today) | owner |
| `users.view_compensation` | finance:view (effectively owner) | owner |
| `users.disable` | PATCH status | owner, admin |
| `users.delete` | team:manage + role | owner, admin |
| `users.reset_password` | team:edit + role | owner, admin |
| `users.view_activity` | isPrivileged | owner, admin |
| `users.revoke_sessions` | (new) | owner, admin |
| `roles.view` | settings:view + role | owner, admin |
| `roles.create` / `roles.update` / `roles.delete` | settings:manage + role | owner (admin with ceiling rules) |
| `roles.assign` | team:edit + role + rank checks | owner, admin |
| `client_users.view` / `.invite` / `.update` / `.disable` / `.delete` / `.reset_password` | team module + role | owner, admin (plus client-scoped managers) |
| `client_assignments.view` / `.manage` | team module + role | owner, admin |
| `time_logs.create` / `time_logs.view` | team:edit or team:view + isPrivileged | everyone (own), project leads (project), admin (organization) |
| `organization.view` / `organization.update` | settings:view / settings:manage | view: all staff; update: owner, admin |
| `usage.view` | role owner/admin | owner, admin |
| `audit_log.view` | role owner/admin | owner |
| `storage.view` / `storage.archive` | settings + role | **platform operator only** |
| `notifications.*`, `push.*`, `account.*` | requireAuth | implicit own for every principal |

Global escalation rules to encode once, in a policy module rather than per handler:
1. **Rank rule**: every mutation of another user (profile, compensation, status, role, reset, delete, sessions, activity view) requires `rank(target) < rank(caller)`, unless the caller is the owner.
2. **No self-grant**: `roles.assign`, `users.disable` and `users.delete` are refused when the target is the caller. `roles.update` is refused for a role the caller holds, and for role defaults that apply to the caller's tier.
3. **Effective-permission ceiling**: any operation that changes a user's effective permission set (override, custom role assign, custom role edit, role default edit, custom role delete, role change) must produce an effective set ≤ the caller's for every non-owner caller, **computed after defaults are applied**.
4. **Owner immutability**: the owner cannot be demoted, disabled, deleted or reset by anyone else.
5. **Type separation**: client-role principals are only mutable through `client_users.*`, and staff only through `users.*`. There is no role crossover through PATCH.
6. **Fail closed**: a missing user, missing agency or unparseable permission data means no access.
7. **Version bump** on every change listed in section 9.5.
