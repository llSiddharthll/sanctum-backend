# 03 — Clients, CRM, Content (posts/approvals/reservations/media/social) & AI — Authorization Inventory

Scope: `sanctum-backend/src/routes/{clients,crm,posts,approvals,reservations,media,social,ai,ai-assistant}.ts`, plus `oauth.ts` / `uploads.ts` callbacks and the services `social-publish`, `social-oauth`, `meta`, `client-notify`, `client-discussion`, `archive`, `media-archive`, `storage`, `local-storage`, `messages.listPinnedForClient`, `scheduler`.
Read-only review; line numbers are from the files as they are today.

Counts: **69 authenticated endpoints** (clients 15, crm 20, posts 7, approvals 3, reservations 3, media 3, social 9, ai 2, ai-assistant 7), plus **5 public endpoints** (4 Meta OAuth/webhooks + 1 local upload PUT), for 74 in total.

---

## 0. Legend & mount facts (verified)

`src/app.ts`:
- `:86` `api.use('/clients', clientsRouter)` is mounted **before** the nested routers at `:103-107`. These are `/clients/:clientId/posts`, `/clients/:clientId/posts/:postId` (approvals), `/clients/:clientId/reservations`, `/clients/:clientId/ai` and `/clients/:clientId/social`.
- `clientsRouter.use(requireAuth)` and `clientsRouter.use(requireModuleRW('clients'))` (`clients.ts:49-50`) have no path, so they run for **every** `/api/v1/clients/*` request. No clientsRouter route matches a nested path such as `/:clientId/posts`, so the request falls through to the nested router, which runs its own gates again.
- The approvals paths `/clients/:c/posts/:p/comments|approvals` also pass through `postsRouter`'s router-level gates first (`posts.ts:19-22`), because postsRouter is mounted at the prefix `/clients/:c/posts`. On those paths the `clients` RW gate is evaluated 3 times. The permission map is memoised, so the repeats cost nothing.
- `/api/v1/media` (`:113`), `/api/v1/crm` (`:120`) and `/api/v1/ai` (`:111`) are **not** under `/clients`, so only their own gates apply.

Abbreviations used in the tables:

| Code | Meaning |
|---|---|
| **CL** | Stacked clientsRouter gate: `requireAuth` + `requireModuleRW('clients')` (clients.ts:49-50) |
| **RW(m)** | Method-derived module tier: GET=view, POST/PUT/PATCH=edit, DELETE=manage (permissions.ts `levelForMethod`) |
| **RCA** | `requireClientAccess(ctx, clientId)` (tenant.ts:47-58). It checks only `clients.id = ? AND clients.agencyId = ?` and returns 404 otherwise. There is **no assignment check**; the comment says access is agency-wide by design. |
| **Role(o,a)** | `requireRole('owner','admin')`. It reads the JWT role claim, which can be up to 15 minutes stale. |
| Tenant filter | The SQL for this endpoint filters by `agencyId` |
| Obj scope | The child object (post, contact, deal…) is proven to belong to the path's client and agency, and to the caller's scope |

Relevant permission facts:
- Built-in `member` has no agency config, so it resolves to `DEFAULT_LEVEL = 'manage'` on every module (`lib/permissions.ts:91,196`). Unless the agency configures role defaults, a plain member has `clients:manage` and `ai:manage`.
- The **Employee preset** has `clients: view` and `calendar: edit`. **No route checks the `calendar` module**, and content posts are gated by `clients`. An "Employee" therefore **cannot create or edit calendar posts**, even though the preset description says they can (`permissions.ts:360-376`).
- `client_assignments` exists, but in these routers it is used only for notification and discussion fan-out (`client-discussion.ts:181-189`). `assignedClientIds` / `isPrivileged` are imported by `clients.ts`, but the assignment branch is dead code (see C-1).

Proposed scopes vocabulary: **organization** (all clients in the agency), **assigned** (clients where the user has a `client_assignments` row, is `clients.ownerId`, or, optionally, is a member of one of the client's projects), and **own** (rows the user created or authored). Recommendation: make **assigned** a real, enforced scope. The table already exists and is maintained by `/team/clients/:clientId/assignments*`. The discussion mirror already treats "assigned + project members + owners" as the working set. Every nested content route would resolve the client through one helper, `authorizeClient(ctx, clientId, permission)`, that applies the scope.

---

## 1. `clients.ts` — mounted at `/api/v1/clients`

Every row below also has **CL** (router gate).

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (line) | Tenant filter | Object scoping | Sensitive data | Issues | Proposed permission | Proposed scope | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C-1 | GET | /api/v1/clients | List client directory | CL → clients:view | `seeAll = isPrivileged(role) \|\| meetsLevel(perms.clients,'view')` (:98). This is **always true** because the gate already required view, so the assignment branch at :110-121 is dead. | yes (:104) | n/a (list) | Every client's `internalNotes`, `gstNumber`, billing address, `paymentTermsDays`, `relationshipHealth`, `portalRole` (serializeClient :52-82) | Dead assignment-scoping code. The comment (:92-94) admits a full directory for view. Internal notes and GST/billing data go to anyone with view. | `clients.view` (+ `clients.view_financials` for billing/GST/terms, `clients.view_internal_notes` or fold into view_financials) | assigned / organization | Filter the list by scope. Redact billing/internal fields without the sub-permission. |
| C-2 | POST | /api/v1/clients | Create client | CL → clients:edit | `enforceClientLimit` plan quota only (:180) | yes (insert with ctx.agencyId) | n/a | — | Stale comment ":140 create (owner/admin)". Create is actually clients:edit (:174-175). `ownerId` is **not validated** as an agency user (:208); compare crm `assertAgencyUser`. `portalRole` can be set here, although it is a portal-access decision. | `clients.create` | organization | `ownerId` must be an active staff user in the agency. Setting `portalRole` needs `clients.manage_portal_access`. |
| C-3 | GET | /api/v1/clients/:clientId | Client detail + counts | CL → clients:view | RCA (:263). `invoiceCount`/`outstanding` shown only if `ctx.role==='owner'` (:340-349). | yes | clientId→agency only | Outstanding receivables (paise), invoice count (owner-only), internal notes, billing | The finance redaction uses a role literal, not the finance permission. `projectCount`/`documentCount` count everything regardless of project membership. | `clients.view`; `clients.view_financials` (or `finance.view`) for outstanding/invoiceCount | assigned / organization | `client ∈ scope`. Financial fields need view_financials. |
| C-4 | PATCH | /api/v1/clients/:clientId | Update client profile / status / portal settings | CL → clients:edit | RCA (:363) | yes (:405) | clientId→agency | Billing, GST, portalRole, portalVisibleStatuses | (a) `status`/`isActive:false` **archives through PATCH with only edit**, bypassing `/archive`'s `clients:manage` (:395-397). (b) Re-activating an archived client via `status:'active'` **bypasses `enforceClientLimit`** (plan-quota bypass). (c) `ownerId` is not validated against the agency. (d) `portalRole` (approver↔reviewer) and `portalVisibleStatuses` change what the client can approve and see, with only clients:edit. | `clients.update`; `clients.archive` for status changes; `clients.manage_portal_access` for portalRole/portalVisibleStatuses; `clients.manage_assignments` for ownerId | assigned / organization | Field-level checks. Re-activation must re-run the quota check. |
| C-5 | POST | /api/v1/clients/:clientId/archive | Archive client | CL → clients:edit **+** `requireModule('clients','manage')` (:415) | RCA (:418), audit | yes | clientId→agency | — | Inconsistent with C-4, which reaches the same outcome at edit. There is no unarchive endpoint (PATCH does it). | `clients.archive` | organization (or assigned) | `client ∈ scope` |
| C-6 | POST | /api/v1/clients/:clientId/portal-tokens | Mint portal share token (raw token returned once) | CL → clients:edit + Role(o,a) (:448) | RCA (:451), audit | yes | clientId→agency | **Raw portal token** | Tokens can be non-expiring (`expiresInDays` optional). The role gate uses the JWT role. | `clients.manage_portal_access` | organization | `client ∈ scope`. Require or default an expiry. |
| C-7 | GET | /api/v1/clients/:clientId/portal-login | Status of client portal login account | CL → clients:view + Role(o,a) (:501) | RCA (:504) | yes (via findClientLogin agencyId) | clientId→agency | Client login email, last login | — | `clients.manage_portal_access` (read) | organization | `client ∈ scope` |
| C-8 | POST | /api/v1/clients/:clientId/portal-login | Create/reset client login; **plaintext password returned** | CL → clients:edit + Role(o,a) (:525) | RCA (:528), audit | yes | clientId→agency | **Plaintext password** (shown once), email | The caller can set an arbitrary `email`. Resetting silently rotates the client's password. | `clients.manage_portal_access` | organization | `client ∈ scope`. Email uniqueness is already enforced in the lib. |
| C-9 | POST | /api/v1/clients/:clientId/portal-login-email | Email credentials to client | CL → clients:edit + Role(o,a) (:575) | RCA (:578), audit | yes | clientId→agency | **Plaintext password in the body and in the email** | `sendTo` is **any address** (:569,:581). Branded agency email carrying credentials can go to an arbitrary recipient. The password is caller-supplied and never checked against the real one, so this is a phishing/spam vector. | `clients.manage_portal_access` | organization | Restrict `sendTo` to the client's contacts, or require explicit confirmation. |
| C-10 | GET | /api/v1/clients/:clientId/pinned | Pinned messages across the client's threads | CL → clients:view | RCA (:626) | yes (`messages.ts:1080`) | clientId→agency. **The caller is not checked as a participant of those threads.** | Message bodies + attachments from **private threads** (DMs/groups tagged with clientId) | **Cross-thread leak.** `listPinnedForClient` (`messages.ts:1055-1093`) ignores `thread_participants`. Anyone with clients:view reads pins from threads they are not in, including project-only threads. | `messages.view` + `clients.view` | assigned; thread participation | Return only pins in threads where the caller is a participant, or threads explicitly marked client-visible-to-team. |
| C-11 | POST | /api/v1/clients/:clientId/pinned/summary | AI summary of pinned messages | CL → clients:**edit** (a read operation, but POST) | RCA (:634) | yes | as C-10 | Same leak as C-10; the content also goes to the external LLM | **No `ai` module check, no `aiLimiter`, no AI quota.** Unmetered AI use by anyone with clients:edit. | `ai.use_assistant` + `messages.view` | assigned | As C-10, plus the AI rate limit and quota |
| C-12 | GET | /api/v1/clients/:clientId/activity | Audit feed across the client's projects | CL → clients:view + `requireModule('projects','manage')` (:672) | RCA (:675) | yes (:705) | clientId→agency. Projects are not filtered by membership. | Audit metadata (actor, entity ids, metadata JSON) | Acceptable as an oversight feed. Metadata JSON is returned raw and could carry finance fields such as contract value (not verified). | `clients.view_activity` (or `audit.view`) | assigned / organization | `client ∈ scope`. Redact finance metadata. |
| C-13 | GET | /api/v1/clients/:clientId/portal-tokens | List portal tokens (no hashes) | CL → clients:view | RCA (:747) | yes (:753) | clientId→agency | Token labels, last used, expiry | Inconsistent: create/revoke are owner/admin, but anyone with view can list. Low impact. | `clients.manage_portal_access` (read) | organization | — |
| C-14 | POST | /api/v1/clients/:clientId/portal-tokens/:tokenId/revoke | Revoke token | CL → clients:edit + Role(o,a) (:773) | RCA (:776). Update is scoped by token id + agency + client (:781-785), audit. | yes | token→client→agency ✔ | — | — | `clients.manage_portal_access` | organization | — |
| C-15 | POST | /api/v1/clients/:clientId/send-welcome | Mint a **non-expiring** token and email the portal link | CL → clients:edit + Role(o,a) (:806) | RCA (:809), audit | yes | clientId→agency | Raw token in the email URL | Each call mints another permanent token. Old ones are never revoked (token sprawl). | `clients.manage_portal_access` | organization | Default expiry; revoke earlier welcome tokens |

---

## 2. `crm.ts` — mounted at `/api/v1/crm`

Router gate: `requireAuth` + `requireModuleRW('clients')` (crm.ts:26-28). The comment at :27, "writes=manage", is **stale**: POST/PATCH need only edit. `scopedClientIds()` is a stub that always returns `null` (:35-37), so the "member-scoped" comments at :438 and :603 are stale.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (line) | Tenant filter | Object scoping | Sensitive data | Issues | Proposed permission | Proposed scope | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R-1 | GET | /api/v1/crm/clients/:clientId/contacts | List contacts | clients:view | RCA (:69) | yes | clientId→agency | Contact PII (email/phone/notes) | — | `contacts.view` | assigned / organization | `client ∈ scope` |
| R-2 | POST | /api/v1/crm/clients/:clientId/contacts | Create contact (clears other primary/billing flags) | clients:edit | RCA (:86), audit | yes | clientId→agency | PII | Setting `isPrimary` changes who receives portal links and welcome emails (client-notify.ts:14-36, clients.ts:812). That is a portal-access side effect of plain edit. | `contacts.create` | assigned / organization | Setting `isPrimary` should need `clients.manage_portal_access`, or be audited |
| R-3 | PATCH | /api/v1/crm/contacts/:id | Update contact | clients:edit | `contactWithAccess` loads by id+agency, then RCA (:137-152) | yes | contact→agency→client ✔ | PII | Same primary-flag side effect. **No audit.** | `contacts.update` | assigned / organization | as R-2 |
| R-4 | DELETE | /api/v1/crm/contacts/:id | Delete contact | clients:manage | contactWithAccess (:172) | yes | ✔ | — | No audit | `contacts.delete` | assigned / organization | — |
| R-5 | GET | /api/v1/crm/clients/:clientId/notes | Notes/activity timeline | clients:view | RCA (:207) | yes | clientId→agency | Internal notes | — | `activities.view` | assigned / organization | `client ∈ scope` |
| R-6 | POST | /api/v1/crm/clients/:clientId/notes | Create note/call/meeting/task | clients:edit | RCA (:226), audit | yes | clientId→agency | — | — | `activities.create` | assigned / organization | author = caller |
| R-7 | PATCH | /api/v1/crm/notes/:id | Edit/complete/pin note | clients:edit | `noteWithAccess` (:258-273) | yes | ✔ | — | **No author check.** Anyone with edit can rewrite other people's notes, which are an activity record. No audit. | `activities.update` | own (update body) / assigned (complete, pin) | Only the author (or `activities.manage`) edits the body. Anyone in scope can mark a task complete. |
| R-8 | DELETE | /api/v1/crm/notes/:id | Delete note | clients:manage | noteWithAccess (:299) | yes | ✔ | — | No author check, no audit | `activities.delete` | own / organization | author or manage |
| R-9 | GET | /api/v1/crm/tags | List tag definitions | clients:view | — | yes (:316) | n/a | — | — | `tags.view` (or `clients.view`) | organization | — |
| R-10 | POST | /api/v1/crm/tags | Create tag definition | clients:edit + Role(o,a) (:326) | dupe check | yes | n/a | — | Role gate plus module gate: two systems | `tags.manage` | organization | — |
| R-11 | DELETE | /api/v1/crm/tags/:id | Delete tag definition | clients:manage + Role(o,a) (:346) | — | yes (:350) | ✔ | — | Links are not cleaned up (orphan `client_tag_links`). Always returns `deleted:true`, even when no row matched. | `tags.manage` | organization | — |
| R-12 | GET | /api/v1/crm/clients/:clientId/tags | Tags on a client | clients:view | RCA (:356) | yes | clientId→agency | — | — | `clients.view` | assigned / organization | — |
| R-13 | POST | /api/v1/crm/clients/:clientId/tags/:tagId | Link tag | clients:edit | RCA (:373). Tag verified in agency (:374-379). | yes | ✔ | — | — | `clients.update` (tag assignment) | assigned / organization | — |
| R-14 | DELETE | /api/v1/crm/clients/:clientId/tags/:tagId | Unlink tag | clients:**manage** | RCA (:389) | yes | ✔ | — | Asymmetric: linking needs edit, unlinking needs manage | `clients.update` | assigned / organization | — |
| R-15 | GET | /api/v1/crm/deals | Full pipeline | clients:view | `scopedClientIds` stub → null (:441). `valuePaise` only if role==='owner' (:455). | yes | n/a | Deal value (owner-only), notes, lost reason | **Stale "member-scoped" comment.** Every deal in the agency is visible to anyone with clients:view. | `deals.view` (+ `deals.view_value`) | assigned / organization | filter by client scope; redact value |
| R-16 | GET | /api/v1/crm/clients/:clientId/deals | Deals for a client | clients:view | RCA (:461); owner-only value (:462) | yes | clientId→agency | as R-15 | — | `deals.view` | assigned / organization | as R-15 |
| R-17 | POST | /api/v1/crm/clients/:clientId/deals | Create deal | clients:edit | RCA (:496); `assertAgencyUser(ownerId)` (:498) | yes | ✔ | valuePaise written | Non-owners **can set `valuePaise`** but can never read it back (a blind write to financial data) | `deals.create` (+ `deals.edit_value`) | assigned / organization | — |
| R-18 | PATCH | /api/v1/crm/deals/:id | Update deal / move stage | clients:edit | `dealWithAccess` (:550-560); assertAgencyUser (:566), audit | yes | ✔ | valuePaise | Non-owner can **overwrite `valuePaise` blind** (:569). Marking a deal won/lost is not a separate permission. | `deals.update`; `deals.close` (won/lost); `deals.edit_value` | own (ownerId=caller) / assigned / organization | `valuePaise` changes need edit_value |
| R-19 | DELETE | /api/v1/crm/deals/:id | Delete deal | clients:manage | dealWithAccess (:597) | yes | ✔ | — | No audit | `deals.delete` | organization | — |
| R-20 | GET | /api/v1/crm/follow-ups | Clients with upcoming follow-ups | clients:view | scopedClientIds stub (:607) | yes (:609) | n/a | relationshipHealth, owner name | Stale "member-scoped" comment | `follow_ups.view` (or `clients.view`) | own (ownerId=caller) / assigned / organization | filter by scope |

---

## 3. `posts.ts` — mounted at `/api/v1/clients/:clientId/posts`

Gates on every row: **CL** + postsRouter `requireAuth` + `requireModuleRW('clients')` (posts.ts:19-22). The comment at :21, "writes=manage", is stale: POST/PATCH need edit.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (line) | Tenant filter | Object scoping | Sensitive data | Issues | Proposed permission | Proposed scope | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P-1 | GET | /clients/:clientId/posts | Calendar list (+hero media, archive view) | CL + clients:view ×2 | RCA (:93) | yes (:97, media :153) | client ✔ | — | Content calendar needs `clients:view`. The `calendar` module is unused. | `posts.view` | assigned / organization | `client ∈ scope` |
| P-2 | POST | /clients/:clientId/posts | Create post (status `draft` **or `scheduled`**) | CL + clients:edit ×2 | RCA (:205), audit | yes | client ✔ | — | **Can create directly as `scheduled`** (:199). The auto-publisher then publishes it with no client approval (see S-9 / J-1). | `posts.create`; `posts.schedule` if status=scheduled | assigned / organization | status=scheduled needs posts.schedule and an approval rule (below) |
| P-3 | GET | /clients/:clientId/posts/:postId | Post detail + media | CL + clients:view ×2 | RCA (:263); `getScopedPost` id+agency+client (:239-257) | yes | post→client→agency ✔ | Storage public ids | — | `posts.view` | assigned / organization | — |
| P-4 | PATCH | /clients/:clientId/posts/:postId | Edit caption/type/platforms/schedule | CL + clients:edit ×2 | RCA (:305); getScopedPost (:306) | yes | ✔ | — | **Editable in any status, including `approved`, `scheduled` and `posted`, without resetting approval.** Content can change after the client approves and still auto-publish. No audit. | `posts.update` | own / assigned / organization | Editing an approved or scheduled post puts it back to `pending_approval` (or needs `posts.update_approved`). `posted` is immutable. |
| P-5 | DELETE | /clients/:clientId/posts/:postId | Delete post | CL + clients:manage ×2 | RCA (:342); getScopedPost (:343), audit | yes | ✔ | — | Post media assets are not deleted from storage (orphans). Publication history cascade not checked. | `posts.delete` | own (draft) / organization | Authors may delete their own drafts. Deleting other statuses needs posts.delete. |
| P-6 | POST | /clients/:clientId/posts/:postId/transition | Staff status change (submit, schedule, mark posted, revert) | CL + clients:edit ×2 | RCA (:382); getScopedPost; TRANSITIONS table (:33-40); audit | yes | ✔ | Side effect: `notifyClientReviewReady` **mints a new non-expiring portal token** (client-notify.ts:58-73) | (a) `draft→scheduled` and `pending_approval→scheduled` **skip client approval** (:34-35). Combined with auto-publish, unapproved content goes live. (b) `scheduled→posted` lets anyone with edit mark a post published by hand. (c) Every submit batch mints an extra permanent portal token (sprawl) without the owner/admin gate that C-6 requires. (d) One permission covers submit, schedule and mark-posted. | `posts.submit_for_approval` (→pending_approval); `posts.schedule` (→scheduled); `posts.mark_posted` (→posted); `posts.update` (→draft) | assigned / organization | → `scheduled` only from `approved`, unless the caller has `posts.approve` (internal override, audited) or the client's approval is not required (agency setting). Notification tokens get an expiry. |
| P-7 | POST | /clients/:clientId/posts/:id/unarchive | Restore archived post | CL + clients:edit ×2 (the comment at :454 says "clients:manage", which is **stale**) | RCA on the **path** client only (:458). `unarchivePost(agencyId, id)` does **not** filter by clientId (archive.ts:285-294). | agency only | **✘ post not bound to :clientId** | — | **Cross-client IDOR within the agency.** Any post id in the agency is un-archived and returned in full, and the portal refresh goes to the wrong client. Also does not check the post was archived (returns 200 for active posts). No audit. | `posts.restore` | assigned / organization | post.clientId = :clientId ∈ scope, and post.archivedAt not null |

## 4. `approvals.ts` — mounted at `/api/v1/clients/:clientId/posts/:postId`

Gates: **CL** + postsRouter gate (posts.ts:19-22) + approvalsRouter `requireAuth` + `requireModuleRW('clients')` (approvals.ts:18-19).

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (line) | Tenant filter | Object scoping | Sensitive data | Issues | Proposed permission | Proposed scope | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A-1 | GET | /clients/:clientId/posts/:postId/comments | Read post comment thread (staff + client) | CL + clients:view ×3 | `scopedPost` = RCA + post id/agency/client (:21-40) | yes | ✔ | Client comments | — | `post_comments.view` | assigned / organization | — |
| A-2 | POST | /clients/:clientId/posts/:postId/comments | Staff comment (visible to client portal) | CL + clients:edit ×3 | scopedPost (:76), audit | yes | ✔ | — | Client-visible output from anyone with edit. No edit/delete endpoints exist. | `post_comments.create` | assigned / organization | — |
| A-3 | GET | /clients/:clientId/posts/:postId/approvals | Approval decision history | CL + clients:view ×3 | scopedPost (:108) | yes | ✔ | Reviewer labels/notes | — | `posts.view` | assigned / organization | — |

Out of scope, but they act on the same objects: `portal.ts:349,384,490,550` (token-auth post view, decision, comments) and `client-portal.ts:676,819,853,895` (client-role calendar, comments, decision). **Approval decisions are made only by clients.** There is no staff `approve` endpoint (TRANSITIONS never targets `approved`), so `posts.approve` is only needed if an internal-approval override is added.

## 5. `reservations.ts` — mounted at `/api/v1/clients/:clientId/reservations`

Gates: **CL** + `requireAuth` + `requireModuleRW('clients')` (reservations.ts:19-20).

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (line) | Tenant filter | Object scoping | Sensitive data | Issues | Proposed permission | Proposed scope | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| V-1 | GET | /clients/:clientId/reservations | List reserved days | CL + clients:view ×2 | RCA (:26) | yes | ✔ | — | — | `reservations.view` (or `posts.view`) | assigned / organization | — |
| V-2 | POST | /clients/:clientId/reservations | Reserve a day | CL + clients:edit ×2 | RCA (:50) | yes | ✔ | — | No audit. No duplicate-date check. | `reservations.manage` | assigned / organization | — |
| V-3 | DELETE | /clients/:clientId/reservations/:id | Remove reservation | CL + clients:manage ×2 | RCA on path client (:70). Delete is by `id + agencyId` **only** (:71-75). | agency only | **✘ not bound to :clientId** | — | **Cross-client delete within the agency.** Also returns `deleted:true` when nothing matched, and refreshes the wrong portal. | `reservations.manage` | assigned / organization | reservation.clientId = :clientId ∈ scope |

## 6. `media.ts` — mounted at `/api/v1/media`

Gates: `requireAuth` + `requireModuleRW('clients')` (media.ts:17-19). Not under `/clients`, so CL does not apply. The comment at :18, "writes=manage", is stale.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (line) | Tenant filter | Object scoping | Sensitive data | Issues | Proposed permission | Proposed scope | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M-1 | POST | /api/v1/media/sign | Get signed upload URL/params | clients:edit | RCA on body.clientId (:33). Optional postId verified client+agency (:36-49). | yes | ✔ | Upload signature (1h). The key is server-generated under `agency/<a>/client/<c>/post/...` (storage.ts:39-43). | Allowed for posts in any status, including `posted` | `media.upload` | assigned / organization | post not `posted` (or needs posts.update) |
| M-2 | POST | /api/v1/media/posts/:postId | Register uploaded asset on a post | clients:edit | RCA on body.clientId (:79). Post verified id+agency+client (:81-92). | yes | post ✔. **Asset ✘** | Storage `cloudinaryPublicId`, `secureUrl` | **Client-controlled `cloudinaryPublicId` / `secureUrl` / `bytes`** (:64-74), none validated. (a) A publicId/key belonging to **another agency or client** (or a Documents key) can be registered, and M-3 then **deletes that foreign object** from Cloudinary/R2/local disk: a cross-tenant destructive IDOR. (b) Arbitrary `secureUrl` is served to the client portal and **handed to Meta for publishing** (social-publish.ts:360-363). (c) Self-reported `bytes` games the storage quota (:112-125). No audit. | `media.upload` | assigned / organization | Asset key must start with `agency/<ctx.agency>/client/<clientId>/post/`. `secureUrl` must be derived server-side from the key. Size is read from storage (HEAD). |
| M-3 | DELETE | /api/v1/media/:mediaId | Delete media + storage object | clients:manage | Loads by id+agency (:143-153); RCA on media.clientId (:156). Comment ":155 member assignment check" is **stale**. | yes | row ✔, underlying object ✘ (see M-2) | — | Destroys whatever key was registered (storage.ts:115-132), so the M-2 poisoning makes this a cross-tenant delete. Deleting media from a `posted`/approved post is not restricted. No audit. | `media.delete` | own (uploader) / assigned / organization | Key prefix check before `deleteAsset`. Block on posted posts. |

## 7. `social.ts` — mounted at `/api/v1/clients/:clientId/social`

Gates: **CL** + `requireAuth` + `requireModuleRW('clients')` (social.ts:41-44). The comment at :42-43 says "connect / disconnect / publish = manage", which is **stale**: connect and publish are POST, so they need edit.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (line) | Tenant filter | Object scoping | Sensitive data | Issues | Proposed permission | Proposed scope | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S-1 | GET | /clients/:clientId/social | Connected accounts + config flags | CL + clients:view ×2 | RCA (:150) | yes (:86-93) | ✔ | Tokens are **not** serialized (serializeAccount :48-64 omits `accessTokenEnc` and `metaUserId`) ✔. Shows `lastError`. | — | `social_accounts.view` | assigned / organization | — |
| S-2 | POST | /clients/:clientId/social/meta/connect | Start Meta OAuth (signed state) | CL + clients:edit ×2 | RCA (:163). State carries agency/client/user (:169). | yes | ✔ | Signed state JWT | Connecting a publishing credential is gated only at edit | `social_accounts.connect` | assigned / organization | — |
| S-3 | GET | /clients/:clientId/social/meta/sessions/:sessionId | List Pages offered by the OAuth session | CL + clients:view ×2 | RCA (:195); `loadSession` id+agency+client+expiry (:173-189) | yes | session→client ✔. **Session→user ✘** | Page names (tokens stay sealed) ✔ | Session is not bound to the user who started it (`socialConnectSessions.userId` is stored but never checked). Low impact. | `social_accounts.connect` | own (session.userId) | session.userId = caller |
| S-4 | POST | /clients/:clientId/social/meta/sessions/:sessionId/select | Link chosen Pages (stores sealed Page tokens); mirrors handles onto client | CL + clients:edit ×2 | RCA (:272); loadSession (:274), audit | yes | session ✔ / user ✘ | **Page access tokens** (sealed via vault) | Any teammate with edit and the session id can finish another user's connection. Overwrites `clients.handlesJson`. | `social_accounts.connect` | own session + assigned client | session.userId = caller |
| S-5 | PATCH | /clients/:clientId/social/:accountId | Toggle auto-publish | CL + clients:edit ×2 | RCA (:337); getAccount id+agency+client (:95-109), audit | yes | ✔ | — | Turning on autoPublish arms the scheduler to publish every approved/scheduled post, but needs only edit | `social_accounts.manage` (or `posts.publish`) | assigned / organization | — |
| S-6 | POST | /clients/:clientId/social/:accountId/refresh | Re-read profile from Meta (uses stored token) | CL + clients:edit ×2 | RCA (:361); getAccount | yes | ✔ | Uses decrypted token server-side | Write gate for what is effectively a read/sync. No audit. | `social_accounts.view` (sync) | assigned / organization | — |
| S-7 | DELETE | /clients/:clientId/social/:accountId | Disconnect (wipe token, status revoked) | CL + clients:manage ×2 | RCA (:410); getAccount, audit | yes | ✔ | — | Does not revoke the token at Meta. Local wipe only. | `social_accounts.disconnect` | assigned / organization | — |
| S-8 | GET | /clients/:clientId/social/posts/:postId/publications | Publication status of a post | CL + clients:view ×2 | RCA (:432); getPost id+agency+client (:111-125) | yes | ✔ | Permalinks, errors | — | `posts.view` | assigned / organization | — |
| S-9 | POST | /clients/:clientId/social/posts/:postId/publish | "Publish now" to Instagram/Facebook | CL + clients:**edit** ×2 | RCA (:441); getPost; status ∈ approved/scheduled/posted (:444-446), audit | yes | ✔ | Uses sealed tokens | (a) **Publishing to a client's real social account needs only clients:edit.** (b) `scheduled` is accepted, but `scheduled` is reachable without approval (P-2/P-6), so unapproved content can be published. (c) `manual:true` ignores the account's autoPublish switch and the retry cap. (d) `posted` is accepted, which lets someone retry a partial publish (idempotent per account, so acceptable). | `posts.publish` | assigned / organization | post.status = approved (or scheduled **with** an approval record), account active |

## 8. `ai.ts` — mounted at `/api/v1/clients/:clientId/ai`

Gates: **CL** (clients RW) + `requireAuth` + `requireModuleRW('ai')` (ai.ts:23-24). Both modules apply.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (line) | Tenant filter | Object scoping | Sensitive data | Issues | Proposed permission | Proposed scope | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| I-1 | POST | /clients/:clientId/ai/generate-month | Generate a month of draft posts via LLM | CL clients:edit + ai:edit + `aiLimiter` (:43) | RCA (:46). Plan quota: counts `succeeded` runs where **`period = body.month`** (:67-86). Audit. | yes | ✔ | Brand strategy sent to the LLM | **Quota bypass**: the quota is keyed on the *requested* month, not the current billing period, so generating for other months resets the limit. Check-then-insert race (concurrent runs pass the check). Creates up to 31 posts. | `ai.generate_content` + `posts.create` | assigned / organization | Quota keyed on the current period (`currentPeriod()`), counted atomically |
| I-2 | GET | /clients/:clientId/ai/generations | Generation history | CL clients:view + ai:view | RCA (:233) | yes | ✔ | Token usage | — | `ai.generate_content` (read) or `posts.view` | assigned / organization | — |

## 9. `ai-assistant.ts` — mounted at `/api/v1/ai`

Gates: `requireAuth` + `requireModuleRW('ai')` (ai-assistant.ts:41-42). All routes are POST, so they need **ai:edit**, plus `aiLimiter` on each. There is **no plan quota** on any of these.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (line) | Tenant filter | Object scoping | Sensitive data | Issues | Proposed permission | Proposed scope | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| I-3 | POST | /api/v1/ai/generate-document | Generate document text from user context | ai:edit + aiLimiter | audit (:107) | n/a | n/a | — | No quota | `ai.use_assistant` | organization | — |
| I-4 | POST | /api/v1/ai/chat | Chat with agency-grounded context | ai:edit + aiLimiter | `getScopedProjectRow` agency-only (:266). `buildChatContext` (:138-258). | yes (agency) | project/client→agency only. **No project membership, no clients/projects module check.** | **Client `internalNotes`, relationshipHealth** (:229-253); names/statuses of the first 10 projects and clients in the agency; project description, milestones, task counts | **Data leak via AI.** A user with ai:edit but `clients:none`/`projects:none` (or not a project member) can pull internal client notes and project details by passing any `clientId`/`projectId`. The data also goes to the external LLM. No audit. | `ai.use_assistant` (+ the underlying `clients.view` / `projects.view` for grounding) | grounding limited to caller's scope | Include a client/project in the context only if the caller can view it; drop internalNotes unless permitted |
| I-5 | POST | /api/v1/ai/task-breakdown | Generate milestones+tasks and **write them into a project** | ai:edit + aiLimiter | `getScopedProjectRow` agency-only (:293), audit | yes | **project membership ✘, projects module ✘** | — | **Privilege bypass.** Only `ai:edit` is needed to insert milestones and tasks into **any** project in the agency, including ones the caller is not a member of and even with `projects:none`. | `ai.task_breakdown` + `projects.tasks.create` (or `projects.update`) | project member / organization | caller must be able to create tasks in the project (same policy as projects router) |
| I-6 | POST | /api/v1/ai/captions | Caption variations | ai:edit + aiLimiter | `resolveClientName` agency-scoped (:59-70), audit | yes | client→agency (name only) | Client name | Minor: existence oracle for client ids / names outside the caller's scope | `ai.generate_content` | assigned / organization (for clientId grounding) | clientId ∈ scope, else ignore |
| I-7 | POST | /api/v1/ai/hashtags | Hashtag suggestions | ai:edit + aiLimiter | resolveClientName, audit | yes | as I-6 | — | as I-6 | `ai.generate_content` | as I-6 | as I-6 |
| I-8 | POST | /api/v1/ai/content-ideas | Content ideas | ai:edit + aiLimiter | resolveClientName, audit | yes | as I-6 | — | as I-6 | `ai.generate_content` | as I-6 | as I-6 |
| I-9 | POST | /api/v1/ai/repurpose | Repurpose content for a platform | ai:edit + aiLimiter | resolveClientName, audit | yes | as I-6 | — | as I-6 | `ai.generate_content` | as I-6 | as I-6 |

---

## 10. Public callbacks / webhooks (no session)

| # | Method | Path | Operation | Verification | Actor | Issues | Proposed |
|---|---|---|---|---|---|---|---|
| W-1 | GET | /api/v1/oauth/meta/callback | Exchange Meta code; list Pages; store **sealed** payload in `social_connect_sessions` (30 min) bound to agency/client/user from state (oauth.ts:38-87) | `verifyOAuthState`: HS256 JWT, key = `JWT_ACCESS_SECRET + ':meta-oauth-state'`, `aud=sanctum:meta-oauth`, 10 min expiry (social-oauth.ts:34-47) | The user id embedded in the state (the user is **not** re-checked as active or still permitted) | (a) The state nonce `n` is never recorded, so the **state is replayable** for 10 min. (b) No browser binding (no cookie/PKCE), so login-CSRF can link a victim's Pages to the attacker's client if the victim completes consent. (c) The signing key is derived from the access-token secret (key reuse). (d) Meta's error text is reflected into the redirect query (length capped at 200; only the frontend renders it). | Store the nonce for one-time use; re-check the user's `social_accounts.connect` at select time (S-4 already runs under a session, which partly mitigates this) |
| W-2 | POST | /api/v1/oauth/meta/deauthorize | Revoke all accounts for a Meta user id | `parseSignedRequest`: HMAC-SHA256 with `META_APP_SECRET`, timing-safe compare (meta.ts:437-453) | System | Cross-agency by design (a Meta user). `algorithm` field not checked (fine for HMAC-only). | OK |
| W-3 | POST | /api/v1/oauth/meta/data-deletion | Hard-delete social accounts for a Meta user | Same HMAC | System | Deletes rows across all agencies. `post_publications` rows remain, referencing deleted accounts. The confirmation code is not persisted. | OK |
| W-4 | GET | /api/v1/oauth/meta/deletion-status | Static "completed" status | none | — | Echoes any code and always says completed (cosmetic) | OK |
| W-5 | PUT | /uploads/local | Raw upload to local disk | HMAC over `key.exp` using **`JWT_ACCESS_SECRET`** (local-storage.ts:31-46); 1h; `safeKey` blocks `..` | Holder of the signed URL | Overwrites an existing object at the key. Key reuse of the access secret. No content-type allow-list (storage.ts `ALLOWED_FORMATS` unused here). The files are then public via `/files` (express.static, app.ts:64-71, **no auth**). | Separate HMAC secret; content-type allow-list |

---

## 11. Background jobs acting on these resources (`services/scheduler.ts`)

| # | Schedule | Job | What it does | Actor | Authz / scoping notes |
|---|---|---|---|---|---|
| J-1 | `*/5 * * * *` if `SOCIAL_PUBLISH_ENABLED` && Meta configured (:131-144) | `runDuePublishing` (social-publish.ts:426-492) → `publishPost` | Publishes posts with status **`approved` or `scheduled`**, `scheduledAt` within the last 24h and not archived, to active accounts with `autoPublish=true`. Resumes IG `processing`. Sets post → `posted`. Notifies `agencyApprovers` on failure. | **System (no user)**. `post_publications` has no actor column; the audit trail is lost for automatic publishes. | Global query across all agencies (:434-452). Each publish is re-scoped by `agencyId` + `post.clientId` (:326,:336-338) ✔. **Publishes `scheduled` posts that never had client approval** (see P-2/P-6). Publishes whatever `secureUrl`s were registered (M-2). The in-memory `running` lock is single-process only. |
| J-2 | `15 0 1 * *` + 20 s after boot (:70-75) | `sweepEndedMonths` (archive.ts:224-266) | Archives incomplete tasks and non-`posted` posts from ended months | System | Global. No actor or audit. |
| J-3 | `0 22 * * 0` if `MEDIA_AUTODELETE_ENABLED` (:91-104) | `runMediaArchive` (media-archive.ts:300-393) | Copies self-hosted documents + post media older than retention to rclone remote (gdrive/GCS), **deletes the local file**, flags archived. Skips media on non-posted posts due ≥ now-24h. | System (shells out to `rclone`) | Global. Uses the stored `publicId`/`cloudinaryPublicId` as the local key, so a key poisoned via M-2 would be copied and deleted cross-tenant. `pendingPosts` is not agency-scoped (harmless: ids are unique). |
| J-4 | `0 9 1 * *` | `runMonthlyReports` | Employee report emails | System | Not in this scope (listed for completeness) |
| J-5 | `*/15 * * * *` | `sweepStaleTimers` | Timer auto-close | System | Not in this scope |
| J-6 | `*/15 * * * *` if Refrens enabled | `pullInvoices` | Refrens invoice sync (creates clients) | System | Not in this scope. Note that it **creates clients** without the plan-quota check (not verified here). |

Inline side effects that act as the request user but reach beyond that user's gate:
- `notifyClientReviewReady` (client-notify.ts:76-109), triggered by P-6. It **mints a permanent portal token** labelled `auto-notify` whenever posts become pending, and emails the primary contact. Minting portal tokens is otherwise restricted to owner/admin (C-6), but here any clients:edit user triggers it.
- `mirrorClientPostComment` (client-discussion.ts:235-348), triggered from portal/client-portal comment routes. It posts into the client's "Content discussion" thread **as the agency owner** and auto-adds owners, assigned staff and project members as participants. This is the only place "assigned" is treated as a working set.
- `broadcastPortalRefresh(clientId)` (realtime/io.ts:87-94) is emitted with the path clientId. In P-7 and V-3 it can target the wrong client, because the object is not bound to the path.

---

## 12. Proposed permission catalogue (derived from the operations above)

| Resource | Actions | Notes |
|---|---|---|
| clients | `view`, `create`, `update`, `archive` (incl. unarchive; re-runs quota), `view_financials` (outstanding, invoice count, billing/GST/terms), `view_internal_notes` (optional; could fold into view_financials), `view_activity`, `manage_portal_access` (portal tokens, portal login create/reset/email, welcome, portalRole, portalVisibleStatuses, primary-contact change), `manage_assignments` (ownerId + client_assignments) | There is no client delete endpoint today, so no `delete` is needed yet |
| contacts | `view`, `create`, `update`, `delete` | Setting primary contact → `clients.manage_portal_access` |
| activities (client notes) | `view`, `create`, `update` (own), `delete` (own), `manage` (others') | |
| tags | `manage` (definitions); linking = `clients.update` | |
| deals | `view`, `view_value`, `create`, `update`, `edit_value`, `close`, `delete` | |
| follow_ups | covered by `clients.view` (filter by scope) | |
| posts | `view`, `create`, `update`, `delete`, `submit_for_approval`, `schedule`, `mark_posted`, `publish`, `restore`, `approve` (only if an internal override is added) | |
| post_comments | `view`, `create` | |
| reservations | `view`, `manage` | |
| media | `upload`, `delete` | |
| social_accounts | `view`, `connect`, `manage` (autoPublish), `disconnect` | |
| ai | `generate_content` (generate-month, captions, hashtags, ideas, repurpose), `use_assistant` (chat, generate-document, pinned summary), `task_breakdown` (also needs projects task-create) | |
| messages (cross-ref) | pinned list/summary must respect `thread participation` | |

Scopes: `organization` (all agency clients), `assigned` (client_assignments ∪ clients.ownerId ∪ optionally client-project membership), `own` (createdBy/authorId/ownerId = caller). Suggested defaults: Manager preset = organization on everything except finance. Employee preset = assigned for posts/media/comments/reservations, own for activities.

Central object policy to implement once: `resolveClientInScope(ctx, clientId, permission)`, which replaces `requireClientAccess`. Every child loader (post, reservation, media, contact, note, deal, social account, session) must bind `child.clientId = resolvedClient.id` and `agencyId`. P-7, V-3 and M-2/M-3 currently fail this.

---

## 13. Stale / misleading comments found

- clients.ts:140: "create (owner/admin)". Actually clients:edit.
- clients.ts:92-94 and :109: "Scoped members: only their assigned clients". Unreachable.
- crm.ts:27, posts.ts:21, media.ts:18: "writes=manage". POST/PATCH need edit; only DELETE needs manage.
- crm.ts:438 and :603: "member-scoped". `scopedClientIds` always returns null.
- social.ts:42-43: "connect / disconnect / publish = manage". Connect and publish need edit.
- posts.ts:453-454: "clients:manage via the router gate". POST needs edit.
- media.ts:155: "member assignment check". RCA is agency-only.
- tenant.ts:20: `isPrivileged` comment "members are restricted to assignments". Not enforced anywhere in these routers.
- ROLES-AND-PERMISSIONS.md §1.5: the Employee preset "calendar: edit" has no effect. Posts need clients:edit.

## 14. Top issues (ranked)

1. **M-2/M-3 cross-tenant storage deletion**: client-supplied `cloudinaryPublicId`/`secureUrl` on media register, then DELETE destroys the foreign object (also J-3 archive-delete). The same hole allows arbitrary URLs to be published to Meta.
2. **Publishing without client approval**: `draft→scheduled`, `pending_approval→scheduled` and create-as-`scheduled` (posts.ts:34-35,:199), and both auto-publish (J-1) and "Publish now" (S-9) accept `scheduled`.
3. **Post edits after approval** don't reset status (P-4), so changed content auto-publishes.
4. **AI task-breakdown writes into any project** with only `ai:edit`, with no projects permission or membership (I-5).
5. **AI chat leaks client internalNotes and project details** for any clientId/projectId to users lacking clients/projects access, and sends them to the LLM (I-4).
6. **Pinned messages (and AI summary) bypass thread participation**, exposing private thread content to anyone with clients:view (C-10/C-11). The summary also skips the AI module, limiter and quota.
7. **P-7 unarchive is not bound to :clientId**: cross-client IDOR, and it doesn't check archived state.
8. **V-3 reservation delete is not bound to :clientId**: cross-client delete.
9. **Client PATCH bypasses archive=manage, plan client quota (reactivate), ownerId validation and portal-access controls** (C-4).
10. **Social publish, connect and autoPublish arming need only clients:edit** (S-2/S-5/S-9), and the Employee preset's `calendar` permission is dead, so the module model cannot express "can edit posts but not publish".

Also notable: the AI monthly quota is keyed on the requested month, so it can be bypassed (I-1). Portal token sprawl comes from the auto-notify and welcome flows (P-6/C-15). The portal-login-email `sendTo` accepts any address (C-9). Deal `valuePaise` gets blind writes from non-owners (R-17/R-18). Note edit/delete has no author check (R-7/R-8). Every assignment-scoping path is dead code (C-1, crm scopedClientIds).
