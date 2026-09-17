# Sanctum Authorization Redesign

Status: **implemented on branch `authz-redesign`** in sanctum-backend, sanctum-frontend and sanctum-flutter. Nothing is pushed or deployed. See [Rollout runbook](#rollout-runbook) and [Implementation status](#implementation-status).

| Area | Verification |
|---|---|
| Backend | 508/508 tests, `tsc` clean, `pnpm authz:lint` clean, `pnpm authz:check` clean |
| Web frontend | `tsc` clean, `next build` succeeds; no automated UI tests |
| Flutter app | **Unverified**: no Flutter SDK was available. Run `flutter analyze` and `flutter test` before merging |

This document is the specification for Sanctum's authorization architecture. It replaces the module-level `none/view/edit/manage` RBAC and its role shortcuts.

The detailed, endpoint-by-endpoint audit this design is derived from is in [`audit/`](audit):

| File | Area | Endpoints |
|---|---|---|
| [01-projects.md](audit/01-projects.md) | projects, tasks, milestones, members, labels, timers, time logs, `/me`, analytics | 50 |
| [02-team-agency-auth.md](audit/02-team-agency-auth.md) | team, agency, roles, auth/session, notifications, push, uploads, health, intake, oauth | 51 |
| [03-clients-content-ai.md](audit/03-clients-content-ai.md) | clients, CRM, posts, approvals, reservations, media, social, AI | 74 |
| [04-attendance-messages-docs.md](audit/04-attendance-messages-docs.md) | attendance, leaves, regularizations, messages, documents, sheets, **Socket.IO** | 62 + 17 events |
| [05-business-finance.md](audit/05-business-finance.md) | leads, proposals, agreements, invoices, expenses, finance, Refrens, money fields | 57 |
| [06-client-portal.md](audit/06-client-portal.md) | `/client`, `/portal`, public document tokens, credential minting | 44 |

Line references in the audit files point at `main @ b2dcd73`.

---

## Contents

- [A. Current-state authorization map](#a-current-state-authorization-map)
- [B. Problems](#b-problems)
- [C. New authorization architecture](#c-new-authorization-architecture)
- [D. Permission catalog](#d-permission-catalog)
- [E. Scope model](#e-scope-model)
- [F. Role model](#f-role-model)
- [G. Policy model](#g-policy-model)
- [H. Data model](#h-data-model)
- [I. Authorization flow](#i-authorization-flow)
- [J. Migration plan](#j-migration-plan)
- [K. Refactoring plan](#k-refactoring-plan)
- [L. Security checklist](#l-security-checklist)
- [M. Test plan](#m-test-plan)
- [Decisions & defaults](#decisions--defaults)

---

## A. Current-state authorization map

### A.1 Mechanisms in use today

Nine separate mechanisms decide access, often several on one request.

| # | Mechanism | Where | What it decides |
|---|---|---|---|
| M1 | JWT role claim (`owner/admin/member/client`) | `lib/jwt.ts`, `middleware/auth.ts` | `requireRole`, `isPrivileged`, `canManageRole`, which role-default bucket applies. Trusted without DB check for 15 min. |
| M2 | Module level map (13 modules × `none/view/edit/manage`) | `lib/permissions.ts` `resolvePermissions` | Resolved per request: user JSON override › custom role JSON › agency role-default JSON › **built-in `manage`**. Finance/business forced `none` for non-owners. |
| M3 | Method→level gate | `requireModuleRW` | GET=view, POST/PUT/PATCH=edit, DELETE=manage. Used on ~25 routers. |
| M4 | Fixed level gate | `requireModule(module, level)` | Specific routes (archive, leaderboard, settings). |
| M5 | Custom router gates with **path substrings** | `projects.ts` (`/tasks`), `timers.ts` (`/logs`) | Task work allowed at view; structure at edit; delete at manage. |
| M6 | In-handler role shortcuts | ~60 sites (`isPrivileged`, `role === 'owner'`, `requirePrivileged`, `canApproveAttendance`) | Admin bypasses, owner-only data, approvals. |
| M7 | Ownership / membership checks | scattered (task assignee delete, comment author, message sender, thread participant, project member) | Object-level rules; many missing. |
| M8 | Serializer money redaction | 17 `ctx.role==='owner'` checks + 2 `finance:view` checks | Hides money fields. |
| M9 | Token capabilities | `requirePortalToken`, public proposal/agreement tokens, upload HMAC, intake secret, OAuth state | Non-user actors. |

Clients (web, Flutter, legacy Capacitor app) each re-implement M1/M2 locally from `GET /auth/me` (`role`, `persona`, `permissions` map). They add their own role shortcuts, persona checks and path-substring route guards.

### A.2 Resource map (condensed)

Legend:
- **Gate**: backend router/route gate.
- **Obj**: object-level check present?
- **UI (web / app)**: how the clients gate it.

| Resource | Actions found in code | Backend gate today | Scope rules today | Obj | Web / Flutter | Key inconsistencies |
|---|---|---|---|---|---|---|
| Projects | list, view, create, update, change status, delete, view/set money, overview, activity | M5 (projects), create: admin OR manage | "all projects" for anyone with view (member scoping is dead code) | partial (structure writes: member OR manage OR admin) | Web: create at `manage`; edit/delete ungated. App: `projects edit` | Admin bypasses tiers; money writable without finance; UI shows edit/delete to viewers |
| Project members / milestones / labels | add/remove member, CRUD milestones, CRUD labels | M5 edit + member-or-manage | project membership (free-text role) | partial | ungated (web) / `projects edit` (app) | Members can add anyone (incl. client users) and thereby grant structure rights |
| Tasks, subtasks, labels-on-task, dependencies, comments | list, view, create, bulk create, update (fields, status, assignees), delete, archive run, unarchive, comment CRUD | M5: **view** for all task writes | none (tenant only) | delete: assignee-or-manage (bypassable); comments: author | web ungated; app `projects edit` | **Any viewer can edit any task (IDOR)**; read scoping cosmetic; status=done stops others' timers & flips posts |
| Timers, time logs | start/stop, list active, edit note, per-user logs, summaries | M5-like (`/logs` edit) + self-or-privileged | own for start/stop | note edit: none | web/app mostly ungated | Anyone with edit can edit colleagues' log notes |
| Analytics | dashboard summary, team overview, leaderboard | dashboard / projects / projects:manage | org | — | persona dashboards | Leaderboard exposes HR attendance/leave data under projects permission |
| Team (users) | list, view, invite, update profile/salary/role/status/overrides, delete, reset password, activity, time logs, client assignments | team RW + owner/admin role + rank + ceiling (overrides only) | org | rank rules | web: `team manage`/`canManage` mixed; app: role owner/admin | Admin edits owner/admin profile & salary; client→staff conversion; reset URLs returned; ceiling ignores defaults |
| Client users (portal logins) | list, update, disable, delete, create login, email credentials, reset | owner/admin role | org | — | web team page | `mintClientPortalLogin` overwrites the oldest client user's email/password and re-enables it |
| Roles / role defaults / custom roles | view matrix, PUT defaults, custom role CRUD, assign | owner/admin + settings view/manage | org | **no ceiling, no rank** | web matrix + custom roles; app matrix (admin/member only) | **Custom role `baseRole` edit escalates holders to admin**; admins raise own defaults; lock-out possible |
| Agency / settings / usage / audit log / storage | view, update, usage, audit log, storage view/archive | auth-only / owner-admin / settings | org; **storage is host-wide** | — | web settings tabs by role | `GET /agency` readable by clients; storage archive crosses tenants; audit log returns oldest rows |
| Clients | list, view, create, update, archive, financial summary, activity, portal tokens, portal login, welcome, pinned messages | clients RW + role shortcuts + `projects:manage` (activity) | "assigned" scoping is dead code | partial (tenant) | web detail page gated by role, list by module | PATCH can archive/reactivate past quota, change portal settings; token list has no role check |
| CRM (contacts, notes, tags, deals, follow-ups, leads-board) | CRUD, deal value | clients RW; tags owner/admin | org | none on notes (anyone edits/deletes) | web `canManage('clients')` | Deal value writable by those who can't see it |
| Posts / approvals / reservations / media / social | CRUD, submit, schedule, publish now, auto-publish, approvals, comments, reservation CRUD, media attach/delete, social connect/disconnect | clients RW (stacked); `calendar` module **never checked** | org | child objects not bound to URL client (unarchive, reservation delete) | web calendar pages by `clients`; app content by `clients edit` | Posts can go live without approval; approved posts edited silently; **cross-tenant storage delete**; social connect at clients:edit |
| AI | generate content, captions, repurpose, chat assistant, generate document, task breakdown | ai RW (+clients when nested) | org | none | web ungated; app `ai` view | Task breakdown writes tasks into any project; chat leaks client notes to LLM without clients permission; quota bypass |
| Attendance / holidays / leave types / leaves / regularizations / checkout requests | check-in/out, today, calendar, summary, policy, holidays, mark, who's in, team summary/report, email reports, leave types, request/decide/cancel, balances | attendance RW + `requirePrivileged` + `canApproveAttendance` (priv OR manage) | own vs privileged | self checks | web tabs owner/admin OR manage; app `isApproverProvider` checks role `manager` (never true) | Self-approval; leave vs regularization approver rules differ; managers not notified; cross-tenant leave-type read |
| Messages / threads | list, view, send, edit, delete, pin, create thread, update, participants add/remove, delete thread, sockets | messages RW + participant | participant | sender edit; delete sender OR owner/admin | web ungated | **Socket bypasses module perms**; typing unscoped; any participant can take over thread; sockets never re-authorized |
| Documents / folders | list, view, sign upload, create, update, move, delete, client-visible, hide-from-team | documents RW + owner-only hidden | org | tenant; **storage key not bound to tenant** | web delete at edit | Upload creates business records (proposal/agreement/invoice) bypassing business perms; cross-tenant storage delete |
| Sheets | CRUD, import, publish | sheets RW | org | none | ungated | Publish creates projects/posts/tasks with sheets:edit only |
| Leads / proposals / agreements | CRUD, convert, send, templates, public view/accept/reject/sign | business RW (owner-only via backstop) + 12 owner serializer checks | org | none; public tokens plaintext, no expiry, no state guards | web owner-only pages | Signed/accepted records editable; public tokens permanent; send hijacks client logins |
| Invoices / expenses / finance / Refrens | CRUD, status, payments, send, overview, snapshot, reports, sync | finance RW + `requireRole('owner')` | org | none | owner-only | **Refrens sync crosses tenants**; status/payment integrity |
| Client portal (`/client`) | me, projects, team, files/folders/upload, calendar, comments, decisions, proposals accept/reject, agreements sign, invoices | `requireClientAuth` (role client + clientId) | brand; project subset only for projects/files (**empty = all**) | partial | web `/client` layout; app client shell | Project subset ignored for proposals/agreements/invoices/calendar; reviewer flag only gates approvals |
| Share-link portal (`/portal`) | resolve, post view/decision/comments, **exchange to full client session** | `requirePortalToken` | brand | — | web `/portal`, `/access` | **Revoking link doesn't end exchanged sessions**; links never expire by default |
| Realtime | handshake (user/portal), thread rooms, send, read, typing, open/close | handshake only | participant (partial) | — | — | No per-event re-authorization; no module permission; typing unscoped |
| Background jobs | monthly reports, archive sweep, timer sweep, media archive, Refrens pull, social publish | none (run as nobody or as impersonated member) | cross-agency | — | — | No system actor; no audit; timer sweep fabricates a `member` actor |

---

## B. Problems

Each problem is architectural; the individual bugs in the audit are symptoms of one or more of these.

| ID | Problem | Evidence (examples) |
|---|---|---|
| P1 | **Coarse module levels don't represent business actions.** `edit` means create+update of *everything* in a module; `manage` means delete. There is no way to express "archive but not delete", "view but not money", "approve leaves", "publish to social". | `requireModuleRW` everywhere; 40+ distinct sensitive operations collapse into 3 levels |
| P2 | **Role checks mixed with permissions.** Access = module level AND/OR role; admins bypass levels (`canSeeAllProjects`, create project, archive run); owner-only via hard backstop + serializer checks. | ~60 role sites, 17 serializer checks |
| P3 | **Fail-open defaults.** Unset module ⇒ `manage`; deleted user (missing row) ⇒ built-in defaults; clearing a custom role ⇒ full access; web `canView(undefined)=true`, `usePermissions` ⇒ `fullAccess()`; client project scope "no rows ⇒ all projects". | `permissions.ts:91`, `middleware/permissions.ts:61-77`, `middleware/client.ts:39-54` |
| P4 | **Mutable authorization in tokens.** Role in JWT trusted 15 min; no session store; refresh never revoked; logout doesn't end sessions; portal-link sessions survive revocation; sockets authorized once. | `requireAuth`, `/auth/refresh`, `portal.ts:86-113`, `socket.ts` |
| P5 | **Privilege escalation in permission administration.** No ceiling on role defaults or custom roles; `baseRole` re-tiers holders; admins edit roles they hold; client→staff conversion; overrides survive custom-role assignment. | `agencies.ts:284-439`, `users.ts:1084-1156` |
| P6 | **Rank-based hierarchy used as authorization.** `ROLE_RANK` decides who can manage whom regardless of actual permissions; a "manager" persona is derived from `projects === manage`. | `canManageRole`, persona derivation |
| P7 | **Missing object-level authorization (IDOR).** Task writes, time-log notes, reservations, post unarchive, CRM notes, storage keys, leave-type reads, thread participants. | audit 01 #17, 03 V-3/P-7, 04 #1 |
| P8 | **Tenant isolation holes** outside the query layer: storage deletes by caller-provided key, host-wide storage archive, server-wide Refrens credentials writing into caller's agency, IDs from other agencies accepted as foreign keys. | audit 03/04/05 |
| P9 | **Scope logic is dead or implicit.** Client assignments and project visibility helpers are computed but never restrict anything; scope is buried in route handlers. | `clients.ts:98`, `projects.ts:226-231` |
| P10 | **Path-substring authorization.** `req.path.includes('/tasks')`, `includes('/logs')` on the backend; `pathname` prefix matching on web. | `projects.ts:69`, `timers.ts:42`, web `moduleForPath` |
| P11 | **Cross-module side effects bypass the target module.** Document upload creates invoices/proposals; sheet publish creates projects/posts/tasks; AI task breakdown creates tasks; task completion flips posts; lead convert creates clients. | audit 04/05/03 |
| P12 | **Duplicated, divergent client logic.** Three clients each redefine modules, levels, `manage` semantics (`canManage` = edit vs `can(m,'manage')` = delete), role shortcuts, persona; Flutter checks role `manager` that never exists; web gates delete at edit. | ROLES-AND-PERMISSIONS §8.3 |
| P13 | **UI and backend disagree** in both directions (controls shown then 403; controls hidden though allowed). | web settings/team/documents; app team/settings |
| P14 | **Realtime is a parallel, weaker API.** No module permission, no per-event check, no eviction on membership/permission change. | `socket.ts:148-238` |
| P15 | **Background jobs have no actor.** Jobs act across agencies without a principal, without audit; timer sweep fabricates a member identity. | `scheduler.ts` |
| P16 | **Business state machines unguarded.** Re-signing agreements, rejecting accepted proposals, editing signed/paid documents, publishing unapproved posts, self-approval of leaves/regularizations/checkouts. | audit 05/06/04 |
| P17 | **Credential minting & takeover paths.** Admin-visible reset URLs, raw invite tokens, staff-chosen client passwords, `mintClientPortalLogin` overwriting accounts, non-expiring share links, plaintext public document tokens. | audit 02/06 |
| P18 | **Opaque JSON authorization storage.** Overrides, role defaults and custom-role maps are JSON blobs: not queryable, not constrained, `customRoleId` has no FK. | `schema.ts` users/agencies/custom_roles |
| P19 | **Inconsistent semantics & stale docs.** `manage` means "delete" on backend, "Full" in UI, "edit" in `canManage`; many comments/tests claim "writes need manage". | ROLES-AND-PERMISSIONS §8.2 G12 |
| P20 | **Audit gaps.** Role/custom-role edits, participant changes, invoice status changes, token exchange, logout — not audited or audit can't fire. | audit 02 §10 |
| P21 | **Transport-level auth weaknesses that defeat authorization.** Production CORS allows any `*.vercel.app` / `*.netlify.app` origin with credentials + `SameSite=None` cookies; one secret signs access tokens, upload tokens and OAuth state; unauthenticated SMTP test on `/health`. | `middleware/origin.ts`, audit 02 |
| P22 | **Email uniqueness per agency vs global login lookup** makes actor identity ambiguous across tenants. | `auth.ts:186`, schema unique index |

---

## C. New authorization architecture

### C.1 Conceptual model

```
Identity (Actor: staff user | client user | portal link | document link | system job | integration | anonymous)
   ↓  authenticated by Session (server-side, revocable)
Role Assignments (user_roles: many per user; roles are permission bundles per agency)
   ↓
Grants  (permission × scope)  =  ⋃ role grants  ∪  user grants  −  user denies
   ↓
Action on Resource   (permission key "resource.action" from the canonical catalog)
   ↓
Scope / Context      (does the object fall inside a granted scope? own | assigned | project | client | organization)
   ↓
Policy / Conditions  (object rules: no self-approval, state machine, cross-module requirements, tenant binding)
   ↓
ALLOW / DENY   (fail closed; 401 unauthenticated · 404 cannot see object · 403 can see but cannot act)
```

### C.2 Principles

1. **One catalog.** `src/authz/catalog.ts` is the only definition of permissions, scopes, categories, sensitivity, applicable actor types and dependencies. It is served at `GET /api/v1/authz/catalog` and generated into typed client files.
2. **Roles are data, not logic.** No code branches on role names. The *Owner* role is special only through its explicit, locked grant set and the "at least one owner" invariant.
3. **Grants are explicit.** No implication at evaluation time (`update` does not imply `view`). Dependencies (`requires`) are enforced when roles are *edited*, so bundles stay coherent.
4. **Scope is part of the grant**, evaluated against facts about the object (`createdBy`, assignees, project membership, client assignment, client/brand).
5. **Policies are code, registered per resource.** They cover rules a scope cannot express. They live in `src/authz/policies/`, not in route handlers.
6. **Queries are scoped.** List endpoints ask the engine for a scope filter and apply it in SQL. Nothing is filtered after the query.
7. **Fail closed everywhere.** Unknown actor, disabled/deleted user, revoked session, unknown permission, unknown scope, missing object facts ⇒ deny. The same applies in clients: missing authorization context ⇒ nothing is shown.
8. **Sessions are server-side.** Access tokens carry identity (`sub`, `sid`, `agencyId`, actor type), never role or permissions. Every request validates the session and user status. Permissions are resolved through a versioned cache.
9. **Administration of authorization is itself authorized**, with a grant-ceiling rule (§F.4) instead of role rank.
10. **Backend is final authority.** Clients get the actor's grants plus per-object `capabilities` computed by the backend engine, so they never re-implement policies.

### C.3 Components

| Component | Location | Responsibility |
|---|---|---|
| Catalog | `src/authz/catalog.ts` | Permission definitions, scopes, role templates, system role definitions |
| Actor | `src/authz/actor.ts` | Actor types; building an actor from a session/token/job |
| Sessions | `src/authz/sessions.ts` | Create, rotate, validate, revoke sessions; revocation fan-out (sockets) |
| Resolver | `src/authz/resolver.ts` | Load role grants + overrides from DB → `GrantSet`; versioned cache; invalidation |
| Engine | `src/authz/engine.ts` | `can`, `authorize`, `scopeOf`, `capabilities`, `explain` |
| Policies | `src/authz/policies/*.ts` | Per-resource fact loaders, scope relations, conditions, SQL scope filters |
| Admin guard | `src/authz/admin.ts` | Ceiling, self-modification, lock-out, target manageability, actor-type separation |
| HTTP adapter | `src/authz/http.ts` | `authenticate` middleware, `require(permission)`, `authorizeObject`, error mapping |
| Realtime adapter | `src/realtime/*` | Per-event authorization, room re-sync, disconnect on revoke |
| Audit | `src/services/audit.ts` (extended) | Structured before/after for every authorization change |
| Clients | `sanctum-frontend/lib/authz/*`, `sanctum-flutter/lib/authz/*` | Generated catalog, `can`/`<Can>`, route requirement tables, refresh on `authz:changed` |

### C.4 How this solves the problems

| Problem | Addressed by |
|---|---|
| P1, P19 | Action-based catalog (§D). Levels survive only as a UI "select all view/edit/delete" convenience in the role editor. |
| P2, P6, P13 | No role branches; admin shortcuts become grants; ceiling replaces rank; UI gates use the same grants/capabilities. |
| P3 | Explicit grants only; closed resolver; migration materializes today's effective access so nothing silently changes. |
| P4 | `sessions` table; `sid` in tokens; per-request session + status check; permission cache keyed by version; socket per-event checks and forced disconnect on revoke. |
| P5, P17 | Admin guard: ceiling on every resulting grant set, no self-modification, lock-out prevention; no `baseRole`; reset URLs never returned; invites/credentials only emailed. |
| P7, P9, P10 | Resource policies with fact loaders and SQL scope filters; explicit route permission declarations; no path matching. |
| P8 | Tenant binding in policies (storage keys prefixed per agency, FK validation helper `requireSameAgency`); Refrens bound to configured agency; storage endpoints platform-scoped. |
| P11 | Cross-module operations declare all required permissions (`authorizeAll`). |
| P12 | Generated catalog + `/auth/me.authorization` + per-object capabilities consumed by all clients. |
| P14 | Realtime adapter authorizes each event against the same engine; room membership recomputed on change. |
| P15 | `system` actor with an explicit, per-job permission list and audit. |
| P16 | Policy conditions for state machines & self-approval. |
| P18 | Normalized tables with FKs/uniques (§H). |
| P20 | Audit on every change, with before/after. |
| P21, P22 | Exact-origin CORS allow-list; separate signing secrets per purpose; `/health` SMTP test removed; login requires unambiguous email (global uniqueness enforced for new users; ambiguous logins denied). |

---

## D. Permission catalog

The canonical source is **`src/authz/catalog.ts`**. The generated [`catalog.md`](catalog.md) and [`catalog.json`](catalog.json) are produced by `pnpm authz:generate`. This section is the human specification.

Conventions:
- **Key** = `resource.action` in snake_case.
- **Scopes** = the scopes a grant for this permission may carry (§E).
- **Actors**: `S` = staff, `C` = client actors (client users and portal links).
- **⚠** = sensitive (audited on grant; highlighted in the role editor; never included in "select all" shortcuts).

Self-service operations need only authentication, no permission: `/auth/me`, change own password, own notifications, own push tokens, logout. They are declared `authenticated` in the route table.

### D.1 Organization & access control

| Key | Description | Scopes | Actors |
|---|---|---|---|
| `organization.view` | View agency profile & branding | organization | S |
| `organization.update` ⚠ | Update agency profile, branding, theme | organization | S |
| `organization.view_usage` | View plan usage & limits | organization | S |
| `organization.view_audit_log` ⚠ | View the security/audit log | organization | S |
| `storage.view` ⚠ | View storage status (platform agency only) | organization | S |
| `storage.archive` ⚠ | Run media archive/delete (platform agency only) | organization | S |
| `users.view` | View team members & profiles | organization | S |
| `users.invite` ⚠ | Invite staff members | organization | S |
| `users.update` | Update another member's profile fields | organization | S |
| `users.view_compensation` ⚠ | View salary / hourly rate | organization | S |
| `users.update_compensation` ⚠ | Change salary / hourly rate (never own) | organization | S |
| `users.disable` ⚠ | Disable / re-enable accounts | organization | S |
| `users.delete` ⚠ | Delete accounts | organization | S |
| `users.reset_password` ⚠ | Send a password reset email to a member | organization | S |
| `users.revoke_sessions` ⚠ | Sign a member out everywhere | organization | S |
| `users.view_activity` | View a member's activity feed | own, organization | S |
| `users.assign_roles` ⚠ | Assign/remove roles on members | organization | S |
| `users.manage_permissions` ⚠ | Add/remove per-user grant/deny overrides | organization | S |
| `roles.view` | View roles & their permissions | organization | S |
| `roles.create` ⚠ | Create custom roles | organization | S |
| `roles.update` ⚠ | Edit custom roles and editable system roles | organization | S |
| `roles.archive` ⚠ | Archive custom roles | organization | S |
| `client_users.view` | View client portal accounts | assigned, organization | S |
| `client_users.invite` ⚠ | Invite client portal users | assigned, organization | S |
| `client_users.update` | Update client users (name, projects, role) | assigned, organization | S |
| `client_users.disable` ⚠ | Disable / delete client users | assigned, organization | S |
| `client_users.reset_password` ⚠ | Email a reset link to a client user | assigned, organization | S |

### D.2 Clients & CRM

| Key | Description | Scopes | Actors |
|---|---|---|---|
| `clients.view` | View clients (directory, profile, follow-ups) | assigned, organization | S |
| `clients.create` | Create clients | organization | S |
| `clients.update` | Update client details | assigned, organization | S |
| `clients.archive` | Archive / restore clients | assigned, organization | S |
| `clients.view_financials` ⚠ | View billing details, outstanding, invoice counts | assigned, organization | S |
| `clients.view_activity` | View cross-module client activity feed | assigned, organization | S |
| `clients.manage_assignments` | Set account owner & assigned team | organization | S |
| `clients.manage_portal` ⚠ | Share links, portal settings, portal visibility | assigned, organization | S |
| `contacts.manage` | Create/update/delete client contacts | assigned, organization | S |
| `client_notes.create` | Add CRM notes/activities | assigned, organization | S |
| `client_notes.update` | Edit CRM notes | own, organization | S |
| `client_notes.delete` | Delete CRM notes | own, organization | S |
| `tags.manage` | Create/delete tag definitions | organization | S |
| `deals.view` | View deals & pipeline | assigned, organization | S |
| `deals.create` | Create deals | assigned, organization | S |
| `deals.update` | Update deals & stage | assigned, organization | S |
| `deals.delete` | Delete deals | assigned, organization | S |
| `deals.view_value` ⚠ | View deal values | assigned, organization | S |
| `deals.update_value` ⚠ | Set deal values | assigned, organization | S |

### D.3 Content calendar & social

| Key | Description | Scopes | Actors |
|---|---|---|---|
| `posts.view` | View calendar posts | assigned, organization, client | S, C |
| `posts.create` | Create posts & reservations | assigned, organization | S |
| `posts.update` | Edit posts & reservations (resets approval) | own, assigned, organization | S |
| `posts.delete` | Delete posts & reservations | own, assigned, organization | S |
| `posts.submit_for_approval` | Send posts to the client for approval | assigned, organization | S |
| `posts.schedule` | Schedule approved posts | assigned, organization | S |
| `posts.publish` ⚠ | Publish now / mark posted / enable auto-publish | assigned, organization | S |
| `posts.archive` | Run month archive sweep | organization | S |
| `posts.restore` | Restore archived posts | assigned, organization | S |
| `posts.approve` | Approve / request changes as the client | client | C |
| `post_comments.view` | View post comments | assigned, organization, client | S, C |
| `post_comments.create` | Comment on posts | assigned, organization, client | S, C |
| `media.upload` | Attach media to posts | assigned, organization | S |
| `media.delete` | Remove media from posts | own, assigned, organization | S |
| `social_accounts.view` | View connected social accounts | assigned, organization | S |
| `social_accounts.manage` ⚠ | Connect/disconnect accounts, auto-publish settings | assigned, organization | S |

### D.4 AI

| Key | Description | Scopes | Actors |
|---|---|---|---|
| `ai.generate_content` | Generate captions, ideas, month plans, repurpose (for clients in scope) | assigned, organization | S |
| `ai.use_assistant` | Chat assistant & document generation (context limited to what the actor can view) | organization | S |
| `ai.task_breakdown` | AI task breakdown (also needs `tasks.create` / `project_milestones.manage` on the target project) | project, organization | S |

### D.5 Projects, tasks & time

| Key | Description | Scopes | Actors |
|---|---|---|---|
| `projects.view` | View projects, overview & activity | assigned, organization, client | S, C |
| `projects.create` | Create projects | organization | S |
| `projects.update` | Update project details & status | assigned, organization | S |
| `projects.delete` ⚠ | Delete projects | organization | S |
| `projects.view_financials` ⚠ | View contract value & billing | assigned, organization | S |
| `projects.update_financials` ⚠ | Set contract value & billing | assigned, organization | S |
| `projects.manage_members` | Add/remove project members | assigned, organization | S |
| `projects.view_team` | View project team (client portal) | client | C |
| `project_milestones.manage` | Create/update/delete milestones | assigned, organization | S |
| `project_labels.manage` | Create/update/delete project task labels | assigned, organization | S |
| `tasks.view` | View tasks, subtasks, dependencies, history | own, assigned, project, organization | S |
| `tasks.create` | Create tasks & subtasks | project, organization | S |
| `tasks.update` | Edit tasks (fields, status, labels, dependencies) | own, assigned, project, organization | S |
| `tasks.assign` | Assign tasks to other people | project, organization | S |
| `tasks.delete` | Delete tasks | own, project, organization | S |
| `tasks.archive` | Run task month-archive sweep | organization | S |
| `tasks.restore` | Restore archived tasks | project, organization | S |
| `task_comments.create` | Comment on tasks | own, assigned, project, organization | S |
| `task_comments.update` | Edit task comments | own, organization | S |
| `task_comments.delete` | Delete task comments | own, organization | S |
| `timers.use` | Start/stop own timers | own | S |
| `timers.view` | See who is tracking time | project, organization | S |
| `time_logs.view` | View time logs | own, project, organization | S |
| `time_logs.create` | Log time manually | own, organization | S |
| `time_logs.update` | Edit time logs | own, organization | S |
| `time_logs.delete` | Delete time logs | own, organization | S |
| `reports.view_dashboard` | Agency dashboard analytics | organization | S |
| `reports.view_team_overview` | Team workload & utilization | organization | S |
| `reports.view_leaderboard` ⚠ | Performance leaderboard (includes attendance data) | organization | S |

### D.6 Attendance

| Key | Description | Scopes | Actors |
|---|---|---|---|
| `attendance.check_in` | Check in/out, own day status | own | S |
| `attendance.view` | View attendance calendar & summaries | own, organization | S |
| `attendance.view_live` | Who's in right now | organization | S |
| `attendance.view_reports` ⚠ | Team summaries & reports (incl. utilization) | organization | S |
| `attendance.email_reports` ⚠ | Email attendance reports | organization | S |
| `attendance.mark` ⚠ | Mark/override someone's attendance (never own) | organization | S |
| `attendance.manage_policy` ⚠ | Office hours, geofence, IP policy | organization | S |
| `holidays.manage` | Manage holidays | organization | S |
| `leave_types.manage` | Manage leave types & quotas | organization | S |
| `leaves.request` | Request leave | own | S |
| `leaves.view` | View leave requests & balances | own, organization | S |
| `leaves.approve` ⚠ | Approve/reject leave (never own) | organization | S |
| `leaves.cancel` | Cancel leave (own: pending or future only) | own, organization | S |
| `regularizations.request` | Request attendance regularization | own | S |
| `regularizations.view` | View regularization requests | own, organization | S |
| `regularizations.approve` ⚠ | Approve/reject regularizations (never own) | organization | S |
| `regularizations.cancel` | Cancel regularization (own: pending only) | own, organization | S |
| `checkout_requests.request` | Request an out-of-office checkout | own | S |
| `checkout_requests.view` | View checkout requests | own, organization | S |
| `checkout_requests.approve` ⚠ | Approve/reject checkout requests (never own) | organization | S |
| `checkout_requests.cancel` | Cancel checkout request (own: pending only) | own, organization | S |

### D.7 Messages, documents, sheets

| Key | Description | Scopes | Actors |
|---|---|---|---|
| `messages.view` | Read threads you participate in (organization = moderation read) | assigned, organization | S |
| `messages.send` | Send messages in threads you participate in | assigned | S |
| `messages.update` | Edit messages | own | S |
| `messages.delete` | Delete messages | own, organization | S |
| `messages.pin` | Pin/unpin messages | assigned, organization | S |
| `threads.create` | Start threads | organization | S |
| `threads.update` | Rename / re-link threads | own, organization | S |
| `threads.manage_participants` | Add/remove participants | own, organization | S |
| `threads.delete` | Delete threads | own, organization | S |
| `documents.view` | View documents & folders | organization, client | S, C |
| `documents.view_hidden` ⚠ | View documents hidden from the team | organization | S |
| `documents.upload` | Upload documents | organization, client | S, C |
| `documents.update` | Rename, recategorize, move documents | own, organization | S |
| `documents.delete` | Delete documents | own, organization | S |
| `documents.share_with_client` | Make documents visible in the client portal | organization | S |
| `documents.hide_from_team` ⚠ | Hide documents from the team | organization | S |
| `folders.create` | Create folders | organization, client | S, C |
| `folders.update` | Rename/move folders | organization | S |
| `folders.delete` | Delete folders | organization | S |
| `sheets.view` | View sheets | organization | S |
| `sheets.create` | Create & import sheets | organization | S |
| `sheets.update` | Edit sheets | own, organization | S |
| `sheets.delete` | Delete sheets | own, organization | S |
| `sheets.publish` | Publish sheet rows (also needs target create permissions) | organization | S |

### D.8 Business

| Key | Description | Scopes | Actors |
|---|---|---|---|
| `leads.view` | View leads & activities | own, organization | S |
| `leads.create` | Create leads | organization | S |
| `leads.update` | Update leads & activities | own, organization | S |
| `leads.delete` | Delete leads / activities | own, organization | S |
| `leads.assign` | Change lead owner | organization | S |
| `leads.convert` | Convert lead to client (also `clients.create`) | own, organization | S |
| `leads.view_value` ⚠ | View budgets & estimated values | own, organization | S |
| `proposals.view` | View proposals | own, organization, client | S, C |
| `proposals.create` | Create proposals | organization | S |
| `proposals.update` | Edit draft/sent proposals | own, organization | S |
| `proposals.send` ⚠ | Send proposals to clients | own, organization | S |
| `proposals.convert` | Convert accepted proposal to agreement (also `agreements.create`) | own, organization | S |
| `proposals.manage_templates` | Manage proposal templates | organization | S |
| `proposals.view_pricing` ⚠ | View pricing & totals | own, organization, client | S, C |
| `proposals.respond` | Accept/reject proposals as the client | client | C |
| `agreements.view` | View agreements | own, organization, client | S, C |
| `agreements.create` | Create agreements | organization | S |
| `agreements.update` | Edit unsigned agreements | own, organization | S |
| `agreements.delete` ⚠ | Delete unsigned agreements | own, organization | S |
| `agreements.send` ⚠ | Send agreements for signature | own, organization | S |
| `agreements.manage_templates` | Manage agreement templates | organization | S |
| `agreements.view_pricing` ⚠ | View agreement value & retainer | own, organization, client | S, C |
| `agreements.sign` | Sign agreements as the client | client | C |

### D.9 Finance

| Key | Description | Scopes | Actors |
|---|---|---|---|
| `invoices.view` | View invoices & payments | organization, client | S, C |
| `invoices.create` | Create invoices | organization | S |
| `invoices.update` | Edit unpaid invoices (incl. bank details) | organization | S |
| `invoices.change_status` ⚠ | Mark sent/paid/cancelled | organization | S |
| `invoices.record_payment` ⚠ | Record payments | organization | S |
| `invoices.send` ⚠ | Email invoices | organization | S |
| `invoices.sync` ⚠ | Refrens sync (agency bound to credentials only) | organization | S |
| `expenses.view` | View expenses | own, organization | S |
| `expenses.create` | Log expenses | organization | S |
| `expenses.update` | Edit expenses | own, organization | S |
| `expenses.delete` | Delete expenses | own, organization | S |
| `finance.view_overview` ⚠ | P&L overview, receivables | organization | S |
| `finance.view_reports` ⚠ | Finance reports | organization | S |

### D.10 Dependencies (`requires`)

Enforced when a role or override is saved; the engine never infers them.

- Every `x.<action>` requires `x.view` on the same or broader scope. Exceptions:
  - own-only self-service permissions (`attendance.check_in`, `leaves.request`, `regularizations.request`, `checkout_requests.request`, `timers.use`);
  - client response permissions, which require the corresponding `.view`.
- Specific requirements:
  - `*.view_value` / `*.view_financials` / `*.view_pricing` require the base `.view`.
  - `*.update_value` / `update_financials` require the matching view permission.
  - `users.assign_roles` requires `roles.view` and `users.view`.
  - `roles.update` requires `roles.view`.
  - `leads.convert` requires `clients.create`.
  - `proposals.convert` requires `agreements.create`.
  - `ai.task_breakdown` requires `tasks.create`.
  - `sheets.publish` requires `sheets.view`.

---

## E. Scope model

### E.1 Scopes

| Scope | Meaning (generic) | Applies to (relation definitions) |
|---|---|---|
| `own` | The actor created / authored / is the subject of the object | tasks (`createdBy`), task comments (author), time logs (`userId`), posts (`createdBy`), media (`uploadedBy`), messages (sender), threads (`createdBy`), documents (`uploadedBy`), sheets (`createdBy`), leads (`ownerId`), proposals/agreements (`createdBy`), expenses (`loggedBy`), leave/regularization/checkout requests (`userId`), attendance (`userId`), users activity (self), client notes (author) |
| `assigned` | The actor is explicitly attached to the object or its parent | **projects**: project member. **tasks**: primary assignee or in `task_assignees`. **clients** and client children (posts, media, deals, contacts, notes, social, AI, client users): in `client_assignments` or `clients.ownerId`. **threads/messages**: participant. |
| `project` | The object belongs to a project the actor is a member of | tasks, task comments, timers, time logs, AI task breakdown |
| `client` | Client actors only: the object belongs to the actor's brand **and** (for project-bound objects) to one of the actor's allowed projects | projects, posts, post comments, documents, folders, proposals, agreements, invoices |
| `organization` | Any object in the actor's agency | all staff permissions |

- **Team / department** scopes are *not* implemented: there is no team entity today (`users.department` is free text). The scope enum and policy registry are designed so a `team` scope can be added with a relation function and a SQL filter without schema changes to grants.
- **"Selected resources"** is covered by `assigned` (explicit membership / assignment tables). Adding object-specific grants later is a `role_permissions.resource_id` extension, intentionally not built now.

### E.2 Evaluation

For permission `p` and object `o`, the actor is allowed if **any** scope `s` in `grants[p]` satisfies `relation_s(actor, o)`. `organization` is satisfied iff `o.agencyId == actor.agencyId`; the tenant check is always applied first, for every scope.

For lists, `scopeFilter(actor, p, resource)` returns a SQL predicate:
- the `OR` of each granted scope's predicate;
- `AND`-ed with the tenant predicate;
- `FALSE` when there are no grants.

### E.3 Scope coverage (for ceilings)

A grant `(p, s)` is covered by `(p, s')` if `s' == s`, or `s' == organization` and `s ∈ {own, assigned, project}`. `client` is only covered by `client` (client-actor grants are managed by staff holding `client_users.update` plus the ceiling of the corresponding staff permissions, §F.4).

### E.4 Client actors

- A client actor carries `agencyId`, `clientId`, and `projectAccess: {mode: 'all' | 'selected', projectIds}`. `selected` with an empty list means **no** projects (fail closed).
- Portal-link actors carry the link's `clientId`, the link's role grants, and its project access.
- Project-less client objects (posts, proposals, agreements, invoices without a project) are visible to a client actor with `mode=selected` only if the object has no project **and** the link/user role grants the permission. Objects bound to a project outside the selection are never visible.

---

## F. Role model

### F.1 Roles

A role is a named, per-agency permission bundle: `roles(id, agency_id, key, name, kind, actor_type, is_locked, archived_at)` plus `role_permissions(role_id, permission, scope)`.

- **kind**: `system` (created by the platform; cannot be deleted; key immutable) or `custom` (fully editable, archivable).
- **actor_type**: `staff` or `client`. A role may only contain permissions whose catalog `actors` include its actor type. Staff roles can only be assigned to staff users, client roles to client users and portal links.
- **is_locked**: permissions cannot be edited (Owner only).

### F.2 System roles (seeded per agency)

| Key | Name | Actor | Locked | Default grants |
|---|---|---|---|---|
| `owner` | Owner | staff | yes | Every staff permission at its broadest scope, **auto-synced** when the catalog grows |
| `admin` | Administrator | staff | no | Everything except business, finance, compensation, audit log, storage, hidden documents, client financials, deal/lead values, pricing (mirrors today's admin, but explicit and editable) |
| `employee` | Employee | staff | no | The Employee template (§F.3) |
| `client_approver` | Client (approver) | client | no | `projects.view`, `projects.view_team`, `documents.view`, `documents.upload`, `folders.create`, `posts.view`, `post_comments.view`, `post_comments.create`, `posts.approve`, `proposals.view`, `proposals.view_pricing`, `proposals.respond`, `agreements.view`, `agreements.view_pricing`, `agreements.sign`, `invoices.view` (all `client` scope) |
| `client_reviewer` | Client (reviewer) | client | no | Same as approver without `posts.approve` |
| `share_link` | Share link | client | no | `posts.view`, `post_comments.view`, `post_comments.create`, `posts.approve` (only via link role choice; default link role is reviewer-equivalent below) |
| `share_link_reviewer` | Share link (review only) | client | no | `posts.view`, `post_comments.view`, `post_comments.create` |

The Owner role is the only way to hold the full catalog. There is no role-name bypass in code. Owner-ness matters only for:
- the invariant *"an agency always has ≥1 active user holding `owner`"*;
- the ceiling (Owner holders can manage anyone, because they hold every grant).

### F.3 Templates (not roles)

Templates pre-fill "Create role". They are catalog data, not DB rows: **Manager**, **Employee**, **Accountant**, **Content Manager**, **HR Manager**, **Viewer**. Manager and Employee reproduce today's presets as explicit grants. Accountant, Content Manager, HR Manager and Viewer are new convenience bundles.

### F.4 Assignment & administration rules (the admin guard)

Let `G(x)` be the effective grant set of actor or role `x`; `⊑` is coverage from §E.3.

| Operation | Required permission | Additional rules |
|---|---|---|
| Create/update role R | `roles.create` / `roles.update` | (1) every grant in the resulting R ⊑ `G(actor)`; (2) R not locked; (3) actor does not hold R (no self-escalation through own role), unless actor holds Owner; (4) the resulting state keeps ≥1 active Owner holder, and keeps ≥1 active user holding `roles.update` + `users.assign_roles`; (5) dependencies satisfied; (6) actor type compatibility |
| Archive role R | `roles.archive` | kind=custom; same (1),(3); holders lose the role (sessions notified) |
| Assign/remove role R on user U | `users.assign_roles` (staff) / `client_users.update` (client) | (1) U ≠ actor; (2) `G(R)` ⊑ `G(actor)`; (3) **U is manageable** by actor; (4) Owner role assignable/removable only by Owner holders; (5) the ≥1-Owner invariant; (6) actor type match |
| Add/remove override on U | `users.manage_permissions` | U ≠ actor; U manageable; grant overrides ⊑ `G(actor)`; deny overrides allowed for any permission the actor holds |
| Update profile/compensation, disable, delete, reset password, revoke sessions on U | the specific `users.*` permission | U ≠ actor (except profile-self via `/auth/me` endpoints); U manageable |

**U is manageable by actor** iff:
- `actor` holds Owner, or
- `G(U) ⊑ G(actor)` **and** `G(U) ≠ G(actor)` (strictly smaller).

Peers with identical authority cannot manage each other. Staff cannot manage Owners unless they are Owners. This replaces `ROLE_RANK`.

The guard validates the **complete resulting state** (all roles + overrides of the target, computed after the change), not individual fields.

### F.5 Multiple roles

Users may hold several roles (`user_roles` many-to-many). `G(U) = ⋃ roles' grants ∪ grant overrides − deny overrides`. The UI allows multiple roles from day one. The migration assigns one.

### F.6 Contextual role assignments

Not introduced. Project-level differentiation is expressed with the `assigned`/`project` scopes over existing membership tables. The schema leaves room to add `user_roles.context_type/context_id` later without changing grants or the engine API.

### F.7 Overrides & precedence

1. Start from the union of grants from all active (non-archived) roles.
2. Remove every **role-derived** scope of a permission that has a user **deny** override (deny is permission-wide over roles).
3. Add user **grant** overrides `(permission, scope)`.

There is no other merge. A deny removes what roles give; an explicit user grant is the only thing that can re-add a scope. This lets an exception *narrow* a role (deny `tasks.update`, grant `tasks.update:assigned`), which the legacy migration needs.

---

## G. Policy model

### G.1 Structure

Each protected resource registers a policy:

```ts
definePolicy('tasks', {
  // facts needed to evaluate scopes & conditions, loaded once per object (or per list row via SQL)
  load: (ctx, id) => TaskFacts | null,            // null → 404
  relations: {
    own:          (a, t) => t.createdBy === a.userId,
    assigned:     (a, t) => t.assigneeIds.includes(a.userId),
    project:      (a, t) => t.projectMemberIds.includes(a.userId),
    organization: () => true,
  },
  filters: { /* same relations as SQL predicates for list queries */ },
  conditions: {
    'tasks.assign': (a, t, input) => input.assigneeIds.every(isActiveStaffInAgency),
    'tasks.delete': (a, t) => ok,
  },
});
```

`authorize(actor, permission, resource)`:
1. Tenant check.
2. Scope relations.
3. The permission's conditions.
4. If denied: 404 when the actor cannot `<resource>.view` the object, else 403.

### G.2 Object & contextual rules (derived from the audit)

| Resource | Rule |
|---|---|
| Any child object | Must belong to the same agency **and** the parent in the URL (post→client, reservation→client, media→post, contact/note/deal→client, milestone/label/task→project, comment→task, message→thread). Mismatch ⇒ 404. |
| Foreign keys in input | Every referenced id (`clientId`, `projectId`, `ownerId`, `assigneeIds`, `leadId`, `proposalId`, folder ids) must exist in the actor's agency; user refs must be active staff (assignees, owners, members). Client users can never be project members/assignees. |
| Storage objects | `publicId`/`fileUrl` must be under `sanctum/<agencyId>/` (or the agency's local key prefix); otherwise rejected. Deletes only for keys recorded by the agency. |
| Tasks | Changing assignees requires `tasks.assign` unless setting only self; completing a task that stops other users' timers runs that side effect as the **system** actor (audited), not as the caller. Linked post status change requires `posts.publish` on the post, otherwise the post is not touched. |
| Projects | Money fields in create/update require `projects.update_financials`; responses include money only with `projects.view_financials`. |
| Project members | Adding members requires target to be active staff; project member role is an enum (`lead`, `member`), not free text. |
| Leaves / regularizations / checkout requests | Approver ≠ subject; subject must be manageable by approver (§F.4); decided requests are immutable; own cancel only while pending (leaves: or start date in future); cancelling an approved leave requires `leaves.approve`. |
| Attendance mark | Target ≠ actor; target manageable. |
| Posts | Update of `approved`/`scheduled`/`posted` resets status to `draft` (requires re-approval) unless the change is status-only by `posts.publish`. `schedule` only from `approved`. `publish` only from `approved`/`scheduled`. Client `approve` only from `pending_approval`. |
| Messages | All message and thread operations require participation, except `organization`-scope moderation reads/deletes; `messages.update` own only. |
| Threads | Removing participants other than self requires `threads.manage_participants`; a thread can never have zero participants. |
| Documents | Upload with business category (proposal/agreement/contract/nda/invoice) requires the corresponding `proposals.create`/`agreements.create`/`invoices.create`; `clientVisible=true` requires `documents.share_with_client`; hidden categories require `documents.hide_from_team`. |
| Sheets publish | Requires `projects.create`/`posts.create`/`tasks.create` for each target kind and scope on each target client/project. |
| AI | `ai.generate_content` scoped to clients in scope; assistant context built only from objects the actor can `view` (engine-filtered queries); task breakdown requires task/milestone permissions on the target project. |
| Proposals | Respond only from `sent`/`viewed` and before `validUntil`; edits only in `draft`/`sent`; convert only from `accepted` and once. |
| Agreements | Sign only from `sent`/`viewed`, once; update/delete only unsigned. |
| Invoices | Update only when not `paid`/`cancelled`; status transitions via an explicit state machine; payments ≤ balance and not on cancelled. |
| Users | Compensation updates never on self; client users cannot be converted to staff (separate actor type, immutable). |
| Leads | Convert requires `clients.create`; activities editable by author or `organization` scope. |
| Client actors | Every object must match `clientId`; project-bound objects must be in allowed projects; client-visible flags respected (documents `clientVisible`, post visible statuses). |
| Public document links | Capability for one object; hashed; expiry; revoked on resend/terminal status; state guards as above; minimal data exposure (no signer IP, no staff ids). |
| Share links | Mandatory expiry (default 30 days, max 90); link sessions bound to the link; revoke ends sessions and sockets. |

---

## H. Data model

New and changed tables (all prefixed with `TABLE_PREFIX`; all agency-owned rows carry `agency_id` with FK `ON DELETE CASCADE`).

```
roles
  id               text PK
  agency_id        text FK agencies NOT NULL
  key              text NULL               -- system role key; UNIQUE(agency_id, key)
  name             text NOT NULL           -- UNIQUE(agency_id, lower(name)) where archived_at IS NULL
  description      text
  kind             text CHECK IN ('system','custom') NOT NULL
  actor_type       text CHECK IN ('staff','client') NOT NULL
  is_locked        integer NOT NULL DEFAULT 0
  color_token      text NOT NULL DEFAULT 'pine'
  template_key     text NULL               -- template it was created from (informational)
  archived_at      integer NULL
  created_by       text FK users ON DELETE SET NULL
  created_at, updated_at
  INDEX (agency_id)

role_permissions
  role_id          text FK roles ON DELETE CASCADE
  permission       text NOT NULL           -- validated against catalog in code
  scope            text CHECK IN ('own','assigned','project','client','organization') NOT NULL
  PRIMARY KEY (role_id, permission, scope)

user_roles
  user_id          text FK users ON DELETE CASCADE
  role_id          text FK roles ON DELETE CASCADE
  agency_id        text FK agencies ON DELETE CASCADE
  assigned_by      text FK users ON DELETE SET NULL
  created_at
  PRIMARY KEY (user_id, role_id)
  INDEX (agency_id, role_id)

user_permission_overrides
  id               text PK
  agency_id        text FK agencies ON DELETE CASCADE
  user_id          text FK users ON DELETE CASCADE
  permission       text NOT NULL
  scope            text NULL               -- NULL only for effect='deny'
  effect           text CHECK IN ('grant','deny') NOT NULL
  reason           text
  created_by       text FK users ON DELETE SET NULL
  created_at
  UNIQUE (user_id, permission, effect, scope)
  INDEX (agency_id, user_id)

sessions
  id               text PK                 -- 'ses_…' (the `sid` claim)
  agency_id        text FK agencies ON DELETE CASCADE
  actor_type       text CHECK IN ('staff','client','portal_link') NOT NULL
  user_id          text FK users ON DELETE CASCADE NULL
  portal_token_id  text FK portal_tokens ON DELETE CASCADE NULL
  refresh_hash     text NOT NULL           -- sha256 of current refresh token
  prev_refresh_hash text NULL              -- reuse detection window
  created_at, last_seen_at, expires_at, revoked_at, revoked_reason
  ip, user_agent
  INDEX (user_id), INDEX (portal_token_id), UNIQUE (refresh_hash)

users  (changed)
  + kind            text CHECK IN ('staff','client') NOT NULL   -- replaces authority of `role`
  + authz_version   integer NOT NULL DEFAULT 1                  -- bumped on any change to this user's grants/status
  + client_project_access text CHECK IN ('all','selected') NULL -- client users only
  ~ role / permissions_json / custom_role_id  → kept read-only during migration phase, dropped in Phase 10

agencies (changed)
  ~ role_permissions_json → dropped in Phase 10

custom_roles → migrated into roles (kind='custom'), dropped in Phase 10

portal_tokens (changed)
  + role_id         text FK roles NOT NULL (after backfill)     -- client role granted by the link
  + project_access  text CHECK IN ('all','selected') NOT NULL DEFAULT 'all'
  + expires_at      NOT NULL after backfill (existing null → now + 90 days)
portal_token_projects (new)  token_id FK, project_id FK, PK(token_id, project_id)

project_tasks (changed)
  + created_by      text FK users ON DELETE SET NULL           -- enables `own` scope (NULL never matches)

project_members (changed)
  ~ role            text CHECK IN ('lead','member') DEFAULT 'member'

document_links (new; replaces proposals.token / agreements.token)
  id, agency_id, object_type CHECK IN ('proposal','agreement'), object_id, token_hash UNIQUE,
  expires_at NOT NULL, revoked_at, consumed_at, created_by, created_at

audit_log (existing, extended use)
  action, entity_type, entity_id, actor_type, actor_id, metadata { before, after, reason, sessionId }, ip
```

- **Constraints:** catalog validity of `permission` and `scope` against `supportedScopes` is enforced in code on every write, and verified by a startup self-check that logs and deletes unknown rows (fail closed).
- **Indexes:** role grant resolution is `user_roles ⋈ role_permissions` by `user_id` (PK prefix) → single indexed query.

---

## I. Authorization flow

### I.1 HTTP request

```
Request
  │
  ├─ CORS (exact origin allow-list) · rate limit · requestId
  │
  ├─ authenticate()                               src/authz/http.ts
  │     token = Bearer | cookie  → verify JWT (sub, sid, aid, typ, at)
  │     session = sessions[sid]  (cached ≤5 s, invalidated in-process on revoke)
  │     reject if missing / revoked / expired / agency mismatch           → 401
  │     user = users[sub]: must exist, status active, kind matches        → 401
  │     portal link: token row not revoked/expired                        → 401
  │     actor = { type, userId, agencyId, sessionId, clientId?, projectAccess?, version }
  │
  ├─ route declaration: requires('projects.update')     (explicit per route; `authenticated` for self-service)
  │     grants = resolver.get(actor)   (cache key: userId + authz_version (+ role versions))
  │     no grant at any scope → 403 (or 404 for object routes the actor cannot view)
  │
  ├─ handler: object routes
  │     obj = policy.load(id)                        null → 404
  │     engine.authorize(actor, 'projects.update', obj, input)
  │         tenant → scope relations → conditions → allow | 404 | 403
  │
  ├─ handler: list routes
  │     where = engine.scopeFilter(actor, 'tasks.view', 'tasks')  → SQL predicate
  │
  ├─ business service (no authorization logic)
  │
  └─ serialize(obj, engine.capabilities(actor, obj, [...actions]))   → `capabilities` in response
```

### I.2 Session lifecycle

| Event | Behaviour |
|---|---|
| Login / accept invite / reset password / portal-link exchange | Create `sessions` row. Issue access JWT (10 min; `sub`, `sid`, `aid`, `typ`) + opaque refresh token (30 days staff/client, ≤ link expiry and ≤7 days for portal links); store `sha256(refresh)` |
| Refresh | Look up by hash. If it matches `prev_refresh_hash` → **reuse detected** → revoke session. Check user active, link active. Rotate. |
| Logout | Revoke current session; disconnect its sockets. |
| Password change/reset | Revoke all sessions of the user except the current one (change) / all (reset). |
| Disable / delete user | Revoke all sessions; disconnect sockets. |
| Portal link revoke/expire | Revoke all sessions with that `portal_token_id`; disconnect link sockets. |
| Role/override change | Bump `authz_version` of affected users. The resolver cache misses on the next request. Emit `authz:changed` to affected users' sockets; server re-syncs their rooms. |
| Role edit | Bump `authz_version` for all holders (single `UPDATE … WHERE id IN (SELECT user_id FROM user_roles WHERE role_id=?)`). |

**Staleness bound:**
- Session revocation and user disable/delete take effect on the next request.
- Permission changes take effect immediately on the next request; the version comes from the per-request user row.
- Clients are told to refresh via `authz:changed`; the backend never depends on it.

### I.3 Realtime

- **Handshake:** same `authenticate()` (JWT `sid` or portal token) → actor; join `user:<id>` / `session:<sid>` / `portal:<clientId>`. Join thread rooms only for threads where the actor has `messages.view` in scope.
- **Every client→server event:** re-resolve the actor (session + version, cached), then `authorize` the event's permission on the object:

  | Event | Permission / check |
  |---|---|
  | `thread:open` | `messages.view` |
  | `message:send` | `messages.send` |
  | `message:read` | `messages.view` |
  | `typing` | `messages.send` |
  | `thread:close` | membership bookkeeping only |

- **Server-side changes:**
  - A participant add/remove, thread delete or `authz:changed` recomputes room membership for the affected users.
  - A session revocation calls `disconnectSockets` on `session:<sid>`.
- **Lifecycle:** sockets are disconnected when the access token they were opened with expires; the client reconnects with a fresh token.

### I.4 Background jobs & integrations

`systemActor(jobName, agencyId, permissions[])` gives an explicit, minimal permission list per job, audited as `actor_type='system'`:

| Job | Permissions (organization scope, per agency) |
|---|---|
| Monthly reports | `attendance.view_reports`, `time_logs.view`, `tasks.view`, `attendance.email_reports` |
| Month archive sweep | `tasks.archive`, `posts.archive` |
| Timer shift-end sweep | `time_logs.create` (for others; system only) |
| Media archive | `storage.archive` (platform agency) |
| Refrens pull | `invoices.sync` (bound agency only) |
| Social auto-publish | `posts.publish` |

Integration actors: the intake key → `integration` actor with `leads.create` for its configured agency. Its key is compared in constant time.

### I.5 Client contract

`GET /api/v1/auth/me`:

```jsonc
{
  "user": { "id", "email", "fullName", "kind": "staff" | "client", "clientId": null },
  "agency": { … },
  "authorization": {
    "version": 17,                                   // users.authz_version (+ catalog version)
    "actorType": "staff",
    "roles": [{ "id", "key": "admin", "name": "Administrator", "kind": "system" }],
    "grants": { "projects.view": ["organization"], "tasks.update": ["assigned", "project"] },
    "projectAccess": null                            // client actors: { mode, projectIds }
  }
}
```

- `GET /api/v1/authz/catalog` returns the catalog JSON (also generated into clients at build time).
- Object responses for authorizable resources include `capabilities: { "update": true, "delete": false, … }` computed by the engine for the actions the UI needs.
- Clients:
  - `can(p)` means the actor has `p` at any scope. Use it for navigation, pages and create buttons.
  - `can(p, obj)` uses `obj.capabilities[action]`. If absent, it is true only when the actor holds `p` at `organization` scope, which fails closed for scoped users.

---

## J. Migration plan

| Phase | Work | Compatibility |
|---|---|---|
| 1 | Inventory (done: `audit/`) | — |
| 2 | Catalog + templates + system role definitions (`src/authz/catalog.ts`), generator | — |
| 3 | Engine, resolver, policies, admin guard, HTTP adapter, unit tests | Not wired |
| 4 | Schema migration `0038_authorization` (tables in §H) + idempotent **backfill** `src/authz/migrate-legacy.ts` (see J.1). Runs at boot per agency until `agencies.authz_migrated_at` is set. | Old columns untouched |
| 5 | Sessions: new token format; `authenticate()` accepts **legacy** access tokens (no `sid`) only until they expire (≤15 min after deploy); legacy refresh tokens are exchanged once for a session on first refresh, then rejected. | Seamless re-login-free rollout |
| 6 | Backend routers migrated resource by resource to `requires` + policies + scope filters. Legacy gates deleted per router as it migrates. | `/auth/me` returns both `authorization` and a **derived legacy** `permissions` map and `role` (display) for old Flutter APKs |
| 7 | Web frontend: authorization provider, `<Can>`, route table, capabilities; role/permission admin UI rewritten | Uses new contract only |
| 8 | Flutter app: same contract; route table; capabilities; admin screens | Old APKs keep working via the legacy map until Phase 10 |
| 9 | Realtime per-event authorization & room sync | — |
| 10 | Remove legacy: `lib/permissions.ts` module levels, `requireModule*`, `requireRole`, `isPrivileged`, `canManageRole`, `users.role/permissions_json/custom_role_id`, `custom_roles`, `agencies.role_permissions_json`, legacy `/auth/me` fields; `sanctum-app` archived (decision below) | Requires a minimum Flutter app version |
| 11 | Security regression suite + second audit (§L) | — |

### J.1 Legacy → new mapping (backfill)

For each agency:

1. **Create system roles** from §F.2.
   - Administrator's grants are computed from the agency's stored admin role defaults. Legacy level → permissions are mapped with the table in `catalog.ts` (`legacy` field per permission; see J.2), then the admin-only privileges admins had through role checks are added.
2. **Create the custom role "Member (migrated)"** from the agency's member defaults (unset ⇒ `manage`, faithfully reproducing today's default). Existing members keep exactly their access. New invites default to Employee.
3. **Migrate each `custom_roles` row** to a custom staff role. The grants come from its level map. If `baseRole=admin`, the admin-only privileges are also included. The role gets a `name` suffix only on collision.
4. **Assign roles to users:**

   | Legacy user | New role |
   |---|---|
   | owner | Owner |
   | admin, no custom role | Administrator |
   | member, no custom role | Member (migrated) |
   | has a custom role | the migrated custom role |
   | client | `client_approver` or `client_reviewer`, from the brand's `portalRole` |

   Client users also get `kind='client'`. `client_project_access` is `selected` if they have `client_user_projects` rows, else `all` (preserves today's behaviour; fail-closed from now on).
5. **Convert per-user `permissions_json` overrides into grant/deny overrides.**
   - Compute legacy effective level per module → expected permission set E.
   - Compare with the role's grants R.
   - Add `grant` for E − R and `deny` for permissions in R − E.
6. **Migrate portal tokens.**
   - `role_id` = `share_link` for approver brands, `share_link_reviewer` for reviewer brands.
   - `expires_at` null → now + 90 days.
   - Existing exchanged sessions cannot be identified (no session table), so they end when their access token expires. Refresh tokens without `sid` are rejected for `portal.*` synthetic users. **Links keep working; exchanged sessions must re-open the link.**
7. **Move public document tokens.** Proposal/agreement tokens go to `document_links` (hashed). Existing URLs keep working because the hash of the raw token is looked up. `expires_at` = `validUntil`/`expirationDate` or now + 90 days.
8. Set `project_tasks.created_by` = NULL for history. It is not guessable; `own` never matches old tasks, which fails closed and is covered by `assigned`/`project`.

### J.2 Level → permission mapping rule

Each permission declares `legacy: { module, level, scope }[]` in the catalog. Examples:

| Permission | Legacy entries |
|---|---|
| `tasks.update` | `projects ≥ view → assigned` (restricted from today's IDOR), `projects ≥ manage → organization` |
| `projects.delete` | `projects ≥ manage → organization` |

**Intentional behaviour changes** (security fixes), listed in the release notes:

| Change | Before | After |
|---|---|---|
| View-only project users | could edit any task | own/assigned only |
| Admin with low module level | bypassed it | lose that bypass |
| Members | could raise their own authority via custom roles | cannot |
| Share-link sessions | full client portal | link's role only |
| Money fields | could be written without seeing them | require `*_financials` / `*_value` |
| Approvals | self-approval allowed | no self-approval |

---

## K. Refactoring plan

### K.1 Backend (`sanctum-backend`)

| Area | Files | Change |
|---|---|---|
| New | `src/authz/{catalog,actor,sessions,resolver,engine,admin,http,errors,system}.ts`, `src/authz/policies/*.ts`, `src/authz/migrate-legacy.ts`, `scripts/authz-generate.ts` | Create |
| Schema | `src/db/schema.ts`, `src/drizzle/0038_authorization.sql` | Tables §H |
| Auth | `routes/auth.ts`, `lib/jwt.ts`, `lib/cookies.ts`, `middleware/auth.ts` | Sessions, sid tokens, refresh rotation, logout revoke; `/auth/me` new contract |
| Gates removed | `middleware/permissions.ts`, `middleware/tenant.ts` (`isPrivileged`, `requireClientAccess`), `middleware/client.ts`, `lib/permissions.ts` | Replaced by `authz/http.ts` + policies |
| Routers | all 37 files in `src/routes/` | `requires(...)` per route; object `authorize`; list `scopeFilter`; serializers use capabilities & field permissions; delete role/level checks |
| Services | `services/messages.ts`, `archive.ts`, `sheet-publish.ts`, `social-publish.ts`, `refrens-sync.ts`, `attendance.ts`, `notifications.ts`, `client-notify.ts`, `storage.ts`, `media-archive.ts`, `scheduler.ts` | Accept an `Actor`; system actors for jobs; storage key tenant binding; notifications by permission instead of `role='owner'` |
| Team/roles admin | `routes/users.ts`, `routes/agencies.ts` | New endpoints: `GET/POST/PATCH /roles`, `POST /roles/:id/archive`, `PUT /team/:id/roles`, `PUT /team/:id/overrides`, `GET /team/:id/effective-permissions` (explain), `POST /team/:id/sessions/revoke`. Admin guard. No reset URLs/raw tokens in responses. |
| Realtime | `realtime/socket.ts`, `realtime/io.ts` | Actor-based handshake, per-event authorize, room sync, revoke disconnect |
| Transport | `middleware/origin.ts`, `middleware/cors.ts`, `env.ts`, `routes/health.ts`, `routes/uploads.ts`, `routes/oauth.ts` | Exact origins; separate secrets (`UPLOAD_TOKEN_SECRET`, `OAUTH_STATE_SECRET`) with fallback during rollout; remove SMTP test |
| Tests | `test/authz/*.test.ts` (new), update existing suites | §M |

### K.2 Web frontend (`sanctum-frontend`)

| Area | Files | Change |
|---|---|---|
| New | `lib/authz/catalog.generated.ts`, `lib/authz/index.ts` (`can`, `canAny`, `canAll`), `lib/authz/routes.ts` (explicit route → requirement table), `components/authz/can.tsx` (`<Can>`, `<CanAny>`, `<CanAll>`), `hooks/use-authorization.ts` | Create |
| Removed | `lib/permissions.ts` (levels, `canManage`, `moduleForPath`), `useCan`, `useIsOwner`, `usePersona`, `canManageTargetRole`, `app/(app)/session-context.tsx` permission helpers | Delete |
| Shell | `app/(app)/app-shell.tsx`, `lib/nav.ts`, `components/app/no-module-access.tsx` | Route requirements from `routes.ts` (matched by Next route pattern); nav items declare `requires`; fail closed |
| Pages/components | every page & component using role/persona/level checks (list in audit & ROLES-AND-PERMISSIONS §6.4) | Replace with `can(...)` / capabilities; gate every action individually |
| Admin UI | `components/app/role-permissions-matrix.tsx`, `permissions-editor.tsx`, `custom-roles-manager.tsx`, `invite-member-sheet.tsx`, `app/(app)/team/[memberId]/page.tsx`, `app/(app)/settings/page.tsx` | Role list/editor (grouped granular permissions + scope), clone/archive, multi-role assignment, overrides, effective-permissions explainer |
| Types/hooks | `lib/api/types.ts`, `hooks/use-me.ts`, `hooks/use-roles.ts`, `hooks/use-team.ts` | New contract; `authz:changed` socket → invalidate `me` |
| Dashboards | `app/(app)/dashboard/page.tsx` | Choose dashboard by capabilities (`reports.view_dashboard` → agency; `reports.view_team_overview` → team; else my day) instead of persona |

### K.3 Flutter (`sanctum-flutter`)

| Area | Files | Change |
|---|---|---|
| New | `lib/authz/catalog.g.dart`, `lib/authz/authz.dart` (`can`, `canAny`, `canAll`, capabilities), `lib/authz/routes.dart` | Create |
| Removed | `lib/core/permissions.dart`, `Me.can` level logic, `isAdmin/isOwner/isManager/isEmployee`, `isAdminProvider`, `isApproverProvider`, `_canManage` | Delete |
| Routing | `lib/app/route_guard.dart`, `router.dart`, `ui/workspace_hub.dart`, `app/shell.dart` | Requirement table; tabs by permission |
| Screens/state | all `lib/screens/*`, `lib/state/*` using role/level checks | `can(...)` / capabilities |
| Settings/team | `screens/settings_screen.dart`, `screens/team_screen.dart`, `state/settings.dart`, `state/team.dart` | Role list & assignment on the new API (full editor may deep-link to web) |
| Session | `lib/state/auth.dart`, `core/api.dart`, `core/socket.dart` | Refresh `me` on `authz:changed` and app resume; failed refresh → guest |

---

## L. Security checklist

| Area | Check | Verified by |
|---|---|---|
| Fail closed | Unknown/disabled/deleted actor, revoked/expired session, unknown permission/scope, missing object facts ⇒ deny | `test/authz/engine.test.ts`, `sessions.test.ts` |
| Tenant isolation | Every policy loader filters `agency_id`; every FK in input validated; storage keys tenant-prefixed; Refrens bound; storage platform-only | `tenant-isolation.test.ts` |
| IDOR | Child objects bound to URL parents; list scope filters in SQL | `objects.test.ts` per resource |
| Escalation | Role create/update ceiling; no self role/override changes; no editing own roles; peers & owners unmanageable; Owner invariant; client/staff actor types separate | `escalation.test.ts` |
| Credentials | No reset URLs/raw invite tokens/plaintext passwords in API responses; client portal logins via invite emails only; account overwrite removed | `credentials.test.ts` |
| Sessions | Logout, password change/reset, disable, delete, link revoke end sessions; refresh reuse detection; no role in tokens | `sessions.test.ts` |
| Stale authorization | Permission change effective on next request; `authz:changed` emitted | `sessions.test.ts`, realtime tests |
| Realtime | Per-event checks; eviction on participant removal; disconnect on revoke; typing scoped | `realtime.test.ts` |
| Background jobs | System actors with explicit permissions; audited | `system-actor.test.ts` |
| State machines | Posts approval, proposals, agreements, invoices, leaves, regularizations, checkout requests | per-resource tests |
| Sensitive data | Money, compensation, signer data, internal notes gated by field permissions | `field-visibility.test.ts` |
| Transport | CORS exact origins; secrets separated; `/health` minimal | `transport.test.ts` |
| Static search | No `role ===`, `isPrivileged`, `requireRole`, `requireModule`, `req.path.includes`, `isOwner`, `fullAccess()` fallbacks remain (CI grep script `scripts/authz-lint.ts`) | CI |
| Audit | Every authorization change writes before/after | `audit.test.ts` |

---

## M. Test plan

A dedicated `test/authz/` suite (vitest + supertest on the real app) plus unit tests for the engine, and a shared scenario file consumed by web/Flutter unit tests for cross-client consistency.

| Suite | Scenarios |
|---|---|
| `engine.test.ts` (unit) | grant/no grant; each scope relation true/false; union of roles; grant override; deny override beats roles; unknown permission ⇒ deny; unknown scope ⇒ deny; tenant mismatch ⇒ deny; 404 vs 403 mapping; capabilities; `explain` output |
| `sessions.test.ts` | anonymous 401; valid; expired access; revoked session; disabled user; deleted user; logout ends refresh; password change revokes other sessions; refresh rotation & reuse detection; legacy token transition; link revoke kills link sessions; permission change effective on next request |
| `roles.test.ts` | system role immutability (owner locked, system not archivable); custom CRUD/clone/archive; dependency validation; actor type validation; multiple roles union; role removal/replacement |
| `escalation.test.ts` | grant higher role; grant unheld permission; broader scope than held; modify own role; add override to self; edit role held by self; manage peer admin; manage owner; remove last owner; create privileged custom role; convert client→staff; assign staff role to client user; lock-out prevention |
| `tenant-isolation.test.ts` | cross-agency ids for every resource family (read, update, delete, as FK input); storage keys; refrens bound |
| `objects/*.test.ts` (per resource) | own vs other's object; assigned vs not; project member vs not; client in scope vs not; organization; list filtering returns only scoped rows; child/parent mismatch 404 |
| `policies/*.test.ts` | no self-approval (leaves/regularizations/checkouts/mark); post approval reset & transitions; proposal/agreement/invoice state machines; cross-module requirements (documents business upload, sheet publish, AI breakdown, task completion side effects) |
| `client-actors.test.ts` | client user all vs selected projects; empty selection = none; per-brand objects; approver vs reviewer; share-link role limits; document links expiry/revoke/state |
| `realtime.test.ts` | handshake auth; send without participation; send without permission; typing to foreign thread; removal evicts; revoke disconnects; `authz:changed` room resync |
| `system-actor.test.ts` | each job's permissions; jobs cannot exceed them; audit rows |
| `matrix.test.ts` | Drives the generated authorization matrix (`matrix.json`: role template × permission × scope × object relation ⇒ expected) against the engine |
| Frontend (`lib/authz/*.test.ts`) | `can`/`canAny`/`canAll`; fail-closed when context missing; route table resolution; capabilities fallback; same `scenarios.json` as backend |
| Flutter (`test/authz_test.dart`) | same scenarios; route guard; tabs; refresh on `authz:changed` |
| Existing suites | Updated to seed roles instead of `permissions` maps; stale assertions (finance for members) removed |

---

## Decisions & defaults

Taken to make progress; each is easy to revisit.

1. **Finance & business become grantable** permissions (only the Owner role has them by default). Today they are hard-coded owner-only.
2. **New invites default to the Employee role**, not full access. Existing users keep their access via migrated roles.
3. **No `team`/`department` scope** yet (no team entity). No contextual (per-project) role assignments yet.
4. **Share-link sessions are limited to the link's role** (calendar review ± approval), no longer the full client portal.
5. **`sanctum-app` (Capacitor)** is superseded by Flutter and would be **archived**, not migrated. It stops working when legacy `/auth/me` fields are removed in Phase 10.
6. **Storage view/archive** become platform-operator operations, restricted to the agency configured as `PLATFORM_AGENCY_ID`.
7. **Refrens** sync is bound to `REFRENS_AGENCY_ID`. Other agencies get 403.
8. **Peers with identical authority cannot manage each other**; only Owner holders manage Owner holders.

---

## Implementation status

| Definition-of-done item | Status |
|---|---|
| Every protected backend action has explicit authorization | Done. `pnpm authz:lint` fails on unguarded routes (reviewed exceptions are listed with reasons) |
| Object-level protection / IDOR | Done. Per-resource facts loaders bind child objects to URL parents and the tenant; SQL scope filters on lists |
| Tenant boundaries | Done. Tenant-bound storage keys, Refrens bound to `REFRENS_AGENCY_ID`, storage ops bound to `PLATFORM_AGENCY_ID`, FK input validation |
| Roles are permission bundles | Done. No role/persona/module-level checks remain (lint-enforced) |
| Granular action permissions, explicit scopes, policies | Done. 175 permissions, 5 scopes, state machines and no-self-approval policies |
| Custom roles cannot escalate; no self-escalation | Done. Grant ceiling, strict manageability, no editing roles you hold, Owner invariant (`test/authz/roles-admin.test.ts`) |
| Fail closed | Done. Unknown permission/scope/actor, deleted/disabled users, revoked sessions, empty client project selection |
| Frontend and apps use the same contract | Web done; Flutter written against the same contract, unverified |
| Backend authoritative | Done |
| Realtime | Done. Per-event authorization, room re-sync on changes, disconnect on revoke and token expiry |
| Background jobs | Done. System actors with explicit grants, audited as `system` |
| Permission changes propagate | Done. `authz_version` per request, `authz:changed` socket event, clients refetch |
| Auditable | Done. `auditAuthz` with before/after on every role/assignment/override/session change |
| Single source of truth for the catalog | Done. `src/authz/catalog.ts` generates docs, matrix and the web/Flutter catalogs (`pnpm authz:generate`) |
| Old RBAC removed | Code removed. Legacy **columns** (`users.role`, `users.permissions_json`, `users.custom_role_id`, `custom_roles`, `agencies.role_permissions_json`) and legacy `/auth/me` fields remain only for the rollout window (below) |
| Comprehensive authorization tests | Backend: `test/authz/*` (engine, sessions, roles/escalation, migration, and per-domain suites) plus updated domain suites. Web/Flutter: no automated UI tests |

### Known follow-ups
- `GET /me/tasks` rows have no `capabilities` (the app falls back to grant scopes).
- The AI quota check lives only in the month-generation route; extract it into a service if other AI endpoints should count against it.
- Rate limiting for `POST /attendance/email-reports` (only the range is capped).
- Decide whether project **leads** should differ from plain members (today every member is `assigned`; a `project` role distinction would need contextual assignments, §F.6).
- Share-link role selection has no staff→client ceiling (client permissions can never grant staff powers).
- Client portal lost the rich proposal view (it used the public token page); render `proposal.content` in `/client/proposals` if needed.
- `test/business_ui_test.dart` (Flutter) still expects a "Copy link" built from document tokens that the API no longer returns.

## Rollout runbook

1. **Configure environment** (backend):
   - `REFRENS_AGENCY_ID`: agency that owns the Refrens credentials. Without it, Refrens sync is refused for everyone.
   - `PLATFORM_AGENCY_ID`: agency allowed to use storage status/archive. Without it, nobody can.
   - Optional `OAUTH_STATE_SECRET` and `UPLOAD_TOKEN_SECRET` (≥32 chars). Without them, purpose-derived keys from `JWT_ACCESS_SECRET` are used.
   - `FRONTEND_ORIGIN` must list every production web origin. `*.netlify.app` / `*.vercel.app` are no longer trusted in production.
2. **Back up the production database.**
3. **Apply migration `0038_authorization.sql`** (additive: new tables and columns only).
4. **Deploy the backend.**
   - At boot it runs `migrateAllAgencies()` (per-agency, transactional, idempotent), syncs Owner roles with the catalog and purges invalid grants. Check the log line `[authz] migrated N agencies`.
   - Effects:
     - Existing users keep their effective access, except for the intentional fixes in §J.2.
     - Synthetic share-link users are disabled, so share-link visitors must reopen their link.
     - Share links without expiry get 90 days.
   - Legacy access tokens keep working until they expire (≤15 min). Legacy refresh tokens are exchanged once for a session.
   - Previously issued upload URLs and OAuth connect states stop verifying (new signing keys).
5. **Deploy the web frontend** (`sanctum-frontend`, Netlify).
6. **Ship the Flutter app** after `flutter analyze` and `flutter test` pass and a manual smoke test on a device (secure-storage token migration, resume refresh, socket reconnect after token expiry).
7. **Verify in production:**
   - Owner sees everything.
   - An employee cannot edit someone else's task.
   - An admin cannot open finance.
   - A share link can only review/approve posts.
   - Revoking a link ends its session.
   - Disabling a user signs them out immediately.
8. **After the rollout window** (≥30 days, and once old app builds are unsupported):
   - Remove the legacy `/auth/me` fields (`role`, `persona`, `permissions`) and `src/authz/compat.ts`.
   - Remove legacy token acceptance in `src/authz/http.ts` and `src/routes/auth.ts`, and `src/lib/jwt.ts`.
   - Add a migration dropping `users.permissions_json`, `users.custom_role_id`, `custom_roles` and `agencies.role_permissions_json`. Keep or drop `users.role` once nothing reads it.
   - Delete `src/authz/migrate-legacy.ts` together with the columns it reads.
