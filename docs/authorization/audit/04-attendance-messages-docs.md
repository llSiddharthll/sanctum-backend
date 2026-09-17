# 04 — Authorization inventory: Attendance, Leaves, Regularizations, Messages, Documents, Sheets, Realtime

Source root: `sanctum-backend/src`. All paths are relative to it. Read-only survey: nothing in the repo was changed.

## 0. Conventions and shared facts

**Mounts** (`app.ts:80-128`, all under `/api/v1`):
- `/attendance` → `routes/attendance.ts`. Its sub-routers are `/attendance/leaves` → `routes/leaves.ts` and `/attendance/regularizations` → `routes/regularizations.ts` (`attendance.ts:54-55`). Both sub-routers inherit `requireAuth` and `requireModuleRW('attendance')`.
- `/messages` → `routes/messages.ts`
- `/documents` → `routes/documents.ts`
- `/sheets` → `routes/sheets.ts`

**Gate shorthand**
- `RW(m)`: `requireModuleRW(m)` (`middleware/permissions.ts`). GET needs `view`, POST/PUT/PATCH need `edit`, DELETE needs `manage`. Owner always gets full access; `client` role gets none.
- `AUTH`: `requireAuth` (`middleware/auth.ts:12`). It checks only the JWT signature and expiry. It does **not** check `users.status`, so a disabled user keeps access until the 15-minute access token expires.
- `PRIV`: `requirePrivileged(req)`, which allows role owner or admin (`attendance.ts:57`, `leaves.ts:21`).
- `CAA`: `canApproveAttendance(req)`, which allows owner/admin, or a member whose `attendance` level is `manage` (`attendance.ts:69-74`, duplicated at `regularizations.ts:32-36`).
- `isPrivileged`: `role in {owner, admin}` (`middleware/tenant.ts:93`).

**Default levels** (per `ROLES-AND-PERMISSIONS.md`): admin has `manage` on attendance, messages, documents and sheets; member has `edit` on each. So a default **member cannot DELETE** in any of these modules, including their own message or a folder.

**Scope vocabulary used in proposals:** `own` (the actor's own records), `team` (reports or managed people, to be defined), `organization` (the whole agency or tenant), `participant` (thread membership).

---

## 1. REST endpoints

### 1A. Attendance core (`routes/attendance.ts`)

Every row below also passes `AUTH` and `RW(attendance)` first. Holiday deletes therefore need `manage` plus `PRIV`, and every POST or PUT needs `edit`.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (lines) | Tenant filter? | Object scoping | Sensitive data | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | GET | /api/v1/attendance/policy | Read the agency attendance policy | AUTH, RW view | none | yes, `loadPolicy(ctx.agencyId)` L139 | agency singleton | Office geo coordinates, allowed IP list | Every attendance viewer sees the office lat/lng and IP allowlist. Punches only need timezone and shift. | `attendance.view_policy` (the minimal subset could be public to anyone who can punch) | organization | Return the geofence and IP list only to `attendance.manage_policy` holders |
| 2 | PUT | /api/v1/attendance/policy | Update policy (shift, geofence, IP enforcement) | AUTH, RW edit, PRIV L161 | PRIV only | yes, L193/199/201 | agency | Geofence and IPs | Attendance managers (member with `manage`) can't edit the policy, which is inconsistent with CAA. Policy is not validated (shiftEnd > shiftStart, etc.). Audited. | `attendance.manage_policy` | organization | none |
| 3 | GET | /api/v1/attendance/today | My punch state for today (also auto-resets stale punches) | AUTH, RW view | implicitly self, L222/229 | partly: record lookup L227-230 filters by `userId` and `day` only, not agencyId (userId is globally unique, so safe) | own | Own IP, lat/lng | A GET has a write side effect: `autoResetStalePunches` marks past open days `half_day` (L222). A view-only user still triggers that write. | `attendance.check_in` (or `attendance.view` with scope own) | own | none |
| 4 | POST | /api/v1/attendance/check-in | Clock in, or reopen the day | AUTH, RW edit | self only, L279/325; fencing L268-273 | agency on insert; lookup by userId+day | own | IP, lat/lng, location string | Fencing uses **client-supplied lat/lng**, so geo is spoofable. Re-check-in wipes checkout and keeps the original check-in time without approval (L290-310), which also erases a pending out-of-office checkout context. A member with only `view` can't check in. | `attendance.check_in` | own | Actor must be an active staff member (not client). Fencing is enforced server-side. |
| 5 | POST | /api/v1/attendance/check-out | Clock out. Outside the geofence it creates a checkout request and notifies approvers. | AUTH, RW edit | self only, L360/395/420 | yes on request insert L418 | own | lat/lng, distance, reason | Geo is client-supplied. The notification goes only to owner/admin (`agencyApprovers`), not to attendance managers who can decide. Also stops the user's timers (L507). | `attendance.check_in` (covers out); creating the request is `checkout_requests.request` | own | Can create a request only for own open record today |
| 6 | GET | /api/v1/attendance/calendar?month&userId | Month calendar for self or another user | AUTH, RW view | `targetUserId` L77-87: another user only if `isPrivileged` | yes, `buildMonth(ctx.agencyId, …)` filters records, holidays and leaves by agency (services/attendance.ts L296-305) | own; others only for owner/admin | Per-day check-in/out times, lateness, leave | Attendance managers (CAA) **cannot** view an individual's calendar but **can** see team-summary/team-report, which is inconsistent. A foreign `userId` isn't validated as an agency member (returns empty, no leak). | `attendance.view` | own / team / organization | Non-own targets must be in the actor's scope. Validate the target is in the tenant. |
| 7 | GET | /api/v1/attendance/summary?month&userId | Monthly rollup for self or another user | AUTH, RW view | `targetUserId` L538 | yes (buildMonth) | as #6 | Worked minutes, overtime | Same as #6 | `attendance.view` | own / team / organization | as #6 |
| 8 | GET | /api/v1/attendance/holidays?year | List agency holidays | AUTH, RW view | none | yes L558 | agency | low | none | `holidays.view` (folds into `attendance.view`) | organization | none |
| 9 | POST | /api/v1/attendance/holidays | Create a holiday | AUTH, RW edit, PRIV L581 | PRIV | yes L588/595 | agency | low | Attendance managers excluded | `holidays.manage` | organization | none |
| 10 | DELETE | /api/v1/attendance/holidays/:id | Delete a holiday | AUTH, RW **manage**, PRIV L620 | PRIV | yes L625 | agency | low | Not audited (create is). Returns `deleted:true` even when nothing matched. | `holidays.manage` | organization | none |
| 11 | POST | /api/v1/attendance/mark | Admin sets or overrides any member's day (status, times, note) | AUTH, RW edit, PRIV L644 | PRIV; target is agency member L649-654 | yes on member check; record lookup L656-665 by userId+day | any agency member, **including self** | Times, status | **An owner/admin can mark their own attendance** (no self-check). No reason is required. Attendance managers excluded. The existing record lookup omits agencyId (safe because the member check came first). | `attendance.mark` | team / organization | **Cannot mark own record** (or require a second approver). Note required. Audited (already true). |
| 12 | GET | /api/v1/attendance/whos-in | Today's status of every active member, with locations | AUTH, RW view, CAA L733 | CAA | yes L743/750 | organization | **Check-in/out location strings**, lateness | Location exposed to attendance managers. Includes owner/admin rows. | `attendance.view` | team / organization | Mask location unless the actor also holds `attendance.view_location` (optional) |
| 13 | GET | /api/v1/attendance/team-summary?month | Monthly rollup for every active member | AUTH, RW view, CAA L788 | CAA | yes | organization | Worked and overtime minutes per person | N+1 buildMonth calls (performance only) | `attendance.view` | team / organization | none |
| 14 | GET | /api/v1/attendance/team-report?from&to | Per-employee attendance, **time logged, tasks, utilization** | AUTH, RW view, CAA L836 | CAA | yes (reports.ts filters by agencyId) | organization (all non-owner staff incl. admins) | **Emails, time logs, task counts, utilization** | An attendance permission gates data from the **projects/time** domain. An attendance manager (member) sees admins' utilization and emails. Range is unbounded. | `attendance.export` + (`projects.view_time` or `reports.view_team`) | team / organization | Exclude subjects ranked above the actor (member manager must not see admins) |
| 15 | POST | /api/v1/attendance/email-reports {from,to} | Email every employee their report and every owner the team overview | AUTH, RW edit, CAA L848 | CAA | yes | organization | Emails with utilization and task data | **An attendance manager can trigger agency-wide mass email** for any range: spam and data egress to all owners. No rate limit or idempotency. Audited. | `attendance.email_reports` | organization | Rate-limit. Range must be ≤ 1 month and in the past. |
| 16 | GET | /api/v1/attendance/checkout-requests?scope&userId | My checkout requests, or all/pending for approvers | AUTH, RW view | `scope in {all,pending}` requires CAA L899-902; else own L908 | yes L898 | own / organization | lat/lng, distance, reason | none significant | `checkout_requests.view` | own / team / organization | none |
| 17 | POST | /api/v1/attendance/checkout-requests/:id/decide | Approve (finalize checkout, optionally credit a full day) or reject | AUTH, RW edit, CAA L935 | CAA; request in tenant L946-949; status pending L953 | yes on request; record lookup L962-971 by userId+day | any request in the agency, **including own** | Rewrites worked minutes | **Self-approval possible:** an owner/admin/manager whose own out-of-office checkout is pending can approve it and credit a full day (`creditFullDay` defaults true). A manager can approve an admin's request (no rank check). | `checkout_requests.approve` | team / organization | **Cannot approve own.** The subject must be within the approver's scope/rank. `creditFullDay` needs an explicit flag. |
| 18 | POST | /api/v1/attendance/checkout-requests/:id/cancel | Requester withdraws a pending request | AUTH, RW edit | owner of request OR `isPrivileged` L1062 | yes L1056-1057 | own (owner/admin: any) | low | Not audited. Attendance managers can decide but not cancel others' requests. | `checkout_requests.cancel` | own (plus organization for admins) | Pending only (already true) |

### 1B. Leaves (`routes/leaves.ts`, mounted at `/api/v1/attendance/leaves`)

Every row also passes `AUTH` and `RW(attendance)`.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (lines) | Tenant filter? | Object scoping | Sensitive data | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 19 | GET | /api/v1/attendance/leaves/types | List leave types (incl. inactive) | RW view | none | yes L47 | organization | low | none | `leave_types.view` (folds into `leaves.request`/`view`) | organization | none |
| 20 | POST | /api/v1/attendance/leaves/types | Create a leave type | RW edit, PRIV L62 | PRIV | yes L68/75 | organization | quotas | Not audited | `leave_types.manage` | organization | none |
| 21 | PATCH | /api/v1/attendance/leaves/types/:id | Update a leave type (quota, paid, active) | RW edit, PRIV L88 | PRIV | update is tenant-filtered (L102), **but the re-read at L103 is `where id = :id` only** | organization | quotas | **Cross-tenant read (IDOR):** an admin of agency A who PATCHes a leave-type id from agency B gets B's row back (the update is a no-op, the select isn't scoped). Not audited. | `leave_types.manage` | organization | Re-read must be tenant-scoped |
| 22 | DELETE | /api/v1/attendance/leaves/types/:id | Soft-deactivate a leave type | RW **manage**, PRIV L109 | PRIV | yes L116 | organization | low | Not audited. Always returns success. | `leave_types.manage` | organization | none |
| 23 | GET | /api/v1/attendance/leaves?scope&userId | My leave requests, or all/pending | RW view | `scope all/pending` requires `isPrivileged` L157; else own L162 | yes L154 | own / organization | reasons (may be medical), decision notes | **Attendance managers can't list** leaves (they can for regularizations/checkouts), which is inconsistent (G5). | `leaves.view` | own / team / organization | none |
| 24 | GET | /api/v1/attendance/leaves/balances?userId&year | Leave balance per type | RW view | other user requires `isPrivileged` L192-199 | yes L206/220 | own; others owner/admin | usage | A foreign userId isn't validated (empty result) | `leaves.view` | own / team / organization | Target must be in scope |
| 25 | POST | /api/v1/attendance/leaves | Apply for leave; approvers get a notification | RW edit | self only, L301/320; type in tenant+active L268-276; quota check L292-314 | yes | own | reason | Quota ignores **pending** requests, so users can stack pending requests over quota and each approval passes independently (the decide handler doesn't re-check quota). No overlap/duplicate check. Past dates allowed. | `leaves.request` | own | Can request only for self. Re-check quota and overlap at approval. |
| 26 | POST | /api/v1/attendance/leaves/:id/decide | Approve or reject a leave | RW edit, PRIV L369 | PRIV; tenant L377; pending L380 | yes | any request in the agency, **including own** | decision note | **An owner/admin can approve their own leave.** Attendance managers excluded (inconsistent). Quota isn't re-validated at approval. | `leaves.approve` | team / organization | **Cannot approve own leave.** Subject must be in scope and ranked below the approver (or owner). Re-check quota. |
| 27 | POST | /api/v1/attendance/leaves/:id/cancel | Cancel a leave (requester or owner/admin) | RW edit | owner OR `isPrivileged` L430; status not cancelled/rejected L433 | yes L427 | own (owner/admin: any) | low | **A requester can cancel an already APPROVED leave**, including past leave, retroactively, with no approval and no audit. Approvers aren't notified. | `leaves.cancel` | own (organization for `leaves.approve` holders) | Own pending: always. Own approved: only if start date is in the future, otherwise needs approver. Audited and notified. |

### 1C. Regularizations (`routes/regularizations.ts`, mounted at `/api/v1/attendance/regularizations`)

Line numbers are file-relative. Every row also passes `AUTH` and `RW(attendance)`.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (lines) | Tenant filter? | Object scoping | Sensitive data | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 28 | GET | /api/v1/attendance/regularizations?scope&userId | My requests, or all/pending | RW view | `scope all/pending` requires CAA L66-67; else own L73 | yes L64 | own / organization | reasons | none | `regularizations.view` | own / team / organization | none |
| 29 | POST | /api/v1/attendance/regularizations | Raise a fix request for a day | RW edit | self only L107/122; one pending per day L102-116 | yes | own | reason, requested times | No validation that `day` is past/today, or that requested times fall on `day`. Future days can be pre-credited. | `regularizations.request` | own | Day must be ≤ today and within an N-day window. Times must fall on that day. |
| 30 | POST | /api/v1/attendance/regularizations/:id/decide | Approve (write the record, **credit a full day**) or reject | RW edit, CAA L172 | CAA; tenant L184-185; pending L190 | yes on request; record lookup L195-204 by userId+day | any request, **including own** | rewrites attendance | **Self-approval:** a manager, admin or owner can raise and approve their own regularization for a full-day credit. No rank check. | `regularizations.approve` | team / organization | **Cannot approve own.** Subject in scope and below rank. |
| 31 | POST | /api/v1/attendance/regularizations/:id/cancel | Requester withdraws a pending request | RW edit | owner OR `isPrivileged` L311 | yes L305-306 | own | low | Not audited | `regularizations.cancel` | own (organization for approvers) | Pending only |

### 1D. Messages (`routes/messages.ts` → `services/messages.ts`)

Every row also passes `AUTH` and `RW(messages)`. The service always receives `ctx.agencyId` and `ctx.userId`.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (service lines) | Tenant filter? | Object scoping | Sensitive data | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 32 | GET | /api/v1/messages/threads?status&search&clientId | List my threads with unread counts | RW view | participant join `threadParticipants.userId = me` svc L362-365, L390-393 | yes L363 | participant | subjects, previews, participant names | N+1 unread counts (performance only). Owner/admin have no "all threads" view for moderation (might be desired). | `messages.view` | participant | none |
| 33 | POST | /api/v1/messages/threads | Create a thread with participants and optional first message | RW edit | creator auto-added svc L457-459; participants must be agency users L460 (`assertAgencyUsers` L199-212); client/project in tenant L461-462 | yes | new object | subject, body | `assertAgencyUsers` does **not** exclude `role='client'` or inactive users. Staff can add a client-portal user as a participant. REST then blocks that user (clients get noAccess), but the **socket auto-joins them and lets them send** (see socket table). Any messages editor can pull anyone into a thread. | `threads.create` | organization (participant picker) | Participants must be active staff (or explicitly allowed client users via a separate policy) |
| 34 | GET | /api/v1/messages/threads/:id | Thread summary | RW view | `requireParticipant` svc L435 (404 if not in tenant, 403 if not participant L126-146) | yes | participant | participants | 403 vs 404 reveals a thread id exists in the tenant (minor) | `messages.view` | participant | none |
| 35 | PATCH | /api/v1/messages/threads/:id | Rename, change status, relink client/project, **add/remove participants** | RW edit | `requireParticipant` svc L875 only | yes L897-905, participants L910/927 | participant | membership | **Any participant can remove anyone (incl. the creator) or add anyone**, and a newly added user sees the full history. Anyone can re-link the thread to another client, which makes its pins show up on that client's overview (#44). Removed users stay in the socket thread room. No audit. | `threads.update` (subject/status/links), `threads.manage_participants` | participant | Only the creator or `threads.manage_participants` holders (organization) can add/remove others; a participant can always remove **self**. Evict removed users from the socket room. |
| 36 | DELETE | /api/v1/messages/threads/:id | Delete a thread (cascade messages) | RW **manage** | `requireParticipant` svc L953 | yes L956-960 | participant | whole conversation | **Any participant with manage can delete the whole thread for everyone** (G9). No audit, no broadcast (clients keep stale state), attachments not cleaned up. | `threads.delete` | own (creator) / organization | Creator, or organization-scope holder. Audited. Broadcast. |
| 37 | GET | /api/v1/messages/threads/:id/messages?before&limit | Paginated history | RW view | `requireParticipant` svc L550 | yes L554, cursor L565 | participant | bodies, attachment URLs | none | `messages.view` | participant | none |
| 38 | POST | /api/v1/messages/threads/:id/messages | Send a message (with attachments); notifies @mentions | RW edit | `requireParticipant` svc L628 | yes | participant | body, attachments | Attachment `url` is any URL (`z.string().url()`, routes L25), not bound to tenant storage. Posting to a `closed` thread isn't blocked. | `messages.send` | participant | Thread not closed (optional). Attachment URLs must come from tenant storage. |
| 39 | PATCH | /api/v1/messages/threads/:id/messages/:msgId | Edit own message | RW edit | participant svc L755; `senderId === userId` L769-771 | yes L761-765 | own + participant | body | No edit window or history | `messages.edit` | own | Sender only (already true) |
| 40 | DELETE | /api/v1/messages/threads/:id/messages/:msgId | Delete own, or any if owner/admin | RW **manage** | participant svc L807; sender or `role in owner/admin` L822-825 | yes | own / participant (admin: any in threads they're in) | body | **Default members (edit) can't delete their own message** because DELETE needs manage; the stated intent is "own". Admins can moderate only threads they belong to. Hard delete, no audit. The role check is a hardcoded string, not `isPrivileged`. | `messages.delete_own`, `messages.delete_any` | own / organization | delete_own: sender. delete_any: organization-scope holder, even as non-participant, audited. |
| 41 | PATCH | /api/v1/messages/threads/:id/messages/:msgId/pin | Pin or unpin a message to the client overview | RW edit | participant svc L1009; message lookup L1011-1015 by id+threadId (**no agencyId**, but the thread was already tenant-checked) | partial | participant | **pinned content becomes visible org-wide via #44** | Pinning a message from a private thread publishes it to everyone with `clients:view`. No broadcast of pin changes. | `messages.pin` | participant | Pinning surfaces content beyond participants, so require `messages.pin` and warn/confirm. Unpin: pinner or organization. |
| 42 | POST | /api/v1/messages/threads/:id/read | Mark thread read (broadcasts a receipt) | RW **edit** | participant svc L839 | yes | participant | read timestamp | A view-only user can't mark read (needs edit), which is awkward | `messages.view` (read receipts are part of viewing) | participant | none |
| 43 | GET | /api/v1/messages/unread-count | Total unread across my threads | RW view | participant join svc L972-979 | yes | participant | count | none | `messages.view` | participant | none |
| 44* | GET | /api/v1/clients/:clientId/pinned (`routes/clients.ts:624`) | Pinned messages across a client's threads (**consumer of messages data**) | AUTH, RW(clients) view | `requireClientAccess` (tenant only) | yes | organization | **message bodies and attachments from threads the viewer isn't in** | **G8:** no participant check and no messages-module check. A user with `messages:none` can read pinned private messages. | `messages.view` + `clients.view` | organization for pins (explicitly shared) | Pinning is an explicit publish. Still require `messages.view`. |
| 45* | POST | /api/v1/clients/:clientId/pinned/summary (`clients.ts:633`) | AI summary over those pins | AUTH, RW(clients) edit | tenant only | yes | organization | same, and sent to an AI provider | same as #44, plus pinned content is shipped to an LLM | `messages.view` + `ai.use` | organization | same |

\* Cross-reference only. Owned by the clients inventory; listed because it reads `messages`.

### 1E. Documents and folders (`routes/documents.ts`)

Every row also passes `AUTH` and `RW(documents)`.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (lines) | Tenant filter? | Object scoping | Sensitive data | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 46 | GET | /api/v1/documents?category&clientId&projectId&folderId&search | List documents | RW view | `hideFromTeam=false` unless role owner L270 | yes L268 | organization (all agency docs) | file URLs (direct, often public CDN), legal/financial docs | Admins are treated as "team" (owner-only is intentional but undocumented). No client/project assignment scoping for members. File URLs are unsigned. | `documents.view`; `documents.view_hidden` (owner-only content) | organization (future: assigned clients) | Hidden docs require `documents.view_hidden` |
| 47 | GET | /api/v1/documents/folders?parentId&clientId&projectId | List folders | RW view | none | yes L314 | organization | folder names | Folders have no hideFromTeam. Names of client/legal folders are visible to all. | `folders.view` (folds into `documents.view`) | organization | none |
| 48 | POST | /api/v1/documents/folders | Create a folder (can set `clientVisible`) | RW edit | client/project/parent in tenant L350-352 | yes | new | none | Any editor can create a **client-visible** folder (share to portal) | `folders.create`; `documents.share_client` for `clientVisible=true` | organization | none |
| 49 | PATCH | /api/v1/documents/folders/:id | Rename, move, toggle `clientVisible` | RW edit | folder in tenant L385; parent in tenant + cycle check L388-396 | yes | organization | visibility | Any editor can expose a folder to the client portal | `folders.update`, `documents.move`, `documents.share_client` | organization | Toggling client visibility needs share permission |
| 50 | DELETE | /api/v1/documents/folders/:id | Delete a folder; docs and subfolders move to root | RW **manage** | folder in tenant L425 | yes L431/439/447 | organization | none | Moves **hidden** docs too (fine). Not audited. | `folders.delete` | organization | none |
| 51 | POST | /api/v1/documents/sign | Get a signed direct-upload target | RW edit | tenant folder forced L470 | yes (key prefix `sanctum/<agencyId>/documents`) | new | upload credentials | none (good) | `documents.upload` | organization | none |
| 52 | POST | /api/v1/documents | Save metadata for an uploaded file. **Category proposal/agreement/invoice spawns Business records** | RW edit | client/project/folder in tenant L514-517; `hideFromTeam` forced for owner-only categories, or owner manual L522-524 | yes | new | fileUrl, publicId | (1) **`fileUrl` and `publicId` are arbitrary and unverified** (L494-495). A doc can point at another tenant's storage key, then DELETE (#54) calls `deleteAsset(publicId)`, which has **no prefix check** (`services/storage.ts:115-132`, `r2.deleteObject`, `cloudinary.destroyAsset`). That is **cross-tenant file deletion**. (2) **A member with documents:edit can create a proposal, agreement or invoice** (`maybeConvertDocument` L569-628) and, with `clientVisible:true`, as status **`sent`**, visible in the client portal. This bypasses the owner-only `business` module. The invoice number is guessable and can collide (`Date.now()%10000`). (3) Any editor can set `clientVisible`. | `documents.upload`; `documents.share_client`; conversions need `proposals.create`/`agreements.create`/`invoices.create` | organization | publicId must start with `sanctum/<agencyId>/`. fileUrl host must be tenant storage. Conversion only if the actor holds the business permission. |
| 53 | PATCH | /api/v1/documents/:id | Rename, recategorize, relink, move, toggle `clientVisible` | RW edit | `getScopedDocument` L648 (404 on hidden unless owner L240) | yes L669 | organization; hidden docs owner-only | visibility | Changing category to an owner-only one **does not set `hideFromTeam`**, so a "contract" stays team-visible. Owners can't toggle `hideFromTeam` after creation (not in schema). Any editor can share to the client portal. Not audited. | `documents.update`, `documents.move`, `documents.share_client`, `documents.hide_from_team` | organization | Recompute hideFromTeam on category change. Share needs share permission. |
| 54 | DELETE | /api/v1/documents/:id | Delete row and storage object | RW **manage** | `getScopedDocument` L682 | yes L687 | organization; hidden owner-only | file | Storage delete trusts the stored `publicId`/`fileUrl` (see #52), which enables **cross-tenant storage deletion**. Not audited. No uploader-own delete for editors. | `documents.delete` (optionally `documents.delete_own`) | own / organization | Storage key must carry the tenant prefix. Audited. |

### 1F. Sheets (`routes/sheets.ts`, `services/sheet-publish.ts`, `services/google-sheet.ts`)

Every row also passes `AUTH` and `RW(sheets)`.

| # | Method | Path | Business operation | Current gate(s) | In-handler authz (lines) | Tenant filter? | Object scoping | Sensitive data | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 55 | POST | /api/v1/sheets/import/google {url} | Fetch a public Google Sheet as CSV (no DB write) | RW edit | none; URL canonicalized to docs.google.com (google-sheet.ts L28-66) | n/a | none | external content | SSRF mitigated by rebuilding the URL. No rate limit (outbound fetch up to 5MB per call). | `sheets.import` | organization | Rate-limited |
| 56 | POST | /api/v1/sheets/:id/publish | Turn a calendar sheet into **content posts (status `scheduled`), project tasks, task assignees, an auto-created project + membership, and notifications** | RW edit | sheet and client in tenant (sheet-publish.ts L210-247); assignees must be agency users L402-436 | yes (all inserts carry agencyId) | organization | creates client-facing posts | **Privilege bypass:** sheets:edit alone creates projects (L273-293), calendar posts and tasks, bypassing `projects`/`calendar` module permissions. Posts are `scheduled`, so they're visible to the portal and may be **auto-published to social accounts by the scheduler** (`runDuePublishing`). Re-publish **overwrites existing posts/tasks** (L455-474) including assignee and status, even if others edited them. The assignee set includes **client-role and inactive users** (L404 has no role/status filter). Final sheet update L587-589 and projectId link L296-299 lack an agencyId predicate (safe after the scoped read). No audit. | `sheets.publish` + `calendar.create` + `projects.create_task` (checked inside) | organization | Actor must hold calendar and projects create. Assignees must be active staff. Publish must not overwrite posts past `draft`/`scheduled` state. |
| 57 | GET | /api/v1/sheets | List all agency sheets | RW view | none | yes L160 | organization | titles, client names | No per-client/owner scoping | `sheets.view` | organization | none |
| 58 | POST | /api/v1/sheets | Create a sheet | RW edit | client/project in tenant L179-181 | yes | new | none | none | `sheets.create` | organization | none |
| 59 | GET | /api/v1/sheets/:id | Read a sheet with its data | RW view | `getScopedSheet` L203 | yes L142 | organization | sheet data (may hold anything) | none | `sheets.view` | organization | none |
| 60 | PATCH | /api/v1/sheets/:id | Autosave (title, data, links) | RW edit | `getScopedSheet` L220; links in tenant L223-224 | yes L235 | organization | data | Last-write-wins; any editor can overwrite anyone's sheet. `data` is unbounded apart from the 1MB JSON limit. | `sheets.update` | organization | none (optional: own-only for non-managers) |
| 61 | POST | /api/v1/sheets/:id/duplicate | Copy a sheet | RW edit | `getScopedSheet` L246 | yes | organization | data | none | `sheets.create` | organization | none |
| 62 | DELETE | /api/v1/sheets/:id | Delete a sheet | RW **manage** | `getScopedSheet` L269 | yes L273 | organization | data | `sheet_publications` rows and linked posts/tasks are left behind. Not audited. | `sheets.delete` | own / organization | Creator or organization |

**Endpoint count:** 60 owned endpoints (#1-43 and #46-62), plus 2 cross-referenced client endpoints (#44, #45).

---

## 2. Socket.IO (`realtime/socket.ts`, `realtime/io.ts`)

Line numbers are file-relative. Handshake: `socket.ts` L65-116. Portal branch L70-90; user branch L92-112, which verifies the JWT and loads the name, with **no `users.status` check, no module check and no role restriction** (a `client`-role JWT is accepted).

| # | Event / room | Direction | Current checks (lines) | Issues | Proposed permission + policy | Re-authorize per event? |
|---|---|---|---|---|---|---|
| S1 | Handshake (user) | connect | JWT verified once (L100); agencyId and role from claims (L107-111) | Auth is checked only at connect. Expiry, logout, disable, role or permission changes are never re-checked. Client-role users are accepted. Origin: no-Origin connections are allowed (fine for a bearer token; cookie auth also accepted without Origin). | Require an active staff user and `messages.view` at handshake. Schedule disconnect at token `exp`. Revocation hook disconnects the user's sockets on disable, role change or logout. | Yes: cheap cached check (status + permission version) on every client→server event |
| S2 | Handshake (portal token) → join `portal:<clientId>` | connect | Token hash lookup, revoked/expired check (L73-85); joins the portal room (L120-122) | Revoked or expired tokens keep the room until disconnect | `portal.connect` (token-scoped). Disconnect sockets when the token is revoked. | n/a (receive-only), but add periodic revalidation |
| S3 | Auto-join `user:<userId>` | server | On connect (L129) | none | implicit (own) | no |
| S4 | Auto-join `thread:<id>` for every participation | server | participant rows filtered by agency+user (L133-142) | **Membership is snapshotted.** A user removed from a thread (#35), a deleted thread (#36) or a disabled user keeps receiving `message:new/updated/deleted`, `thread:read` and `typing` for that thread until reconnect. A client-role user added as a participant is auto-joined. | `messages.view` + participant. On participant removal or thread delete, call `io.in(userRoom(uid)).socketsLeave(threadRoom)`. | Membership changes must push leave events |
| S5 | `thread:open` (threadId, ack) | C→S | `isParticipant(agency,user,thread)` (L152) → join | No module check | `messages.view`, participant scope | Yes (already checks participation; add permission check) |
| S6 | `thread:close` (threadId) | C→S | none (only leaves a room) | harmless | none | no |
| S7 | `message:send` {threadId, body, clientMsgId} | C→S | `isParticipant` (L188); `createMessage` re-checks participation (svc L628) | **Bypasses `requireModuleRW('messages')`:** a user with messages `view` or `none` (or client role) who is a participant can send (G10). No rate limit or flood control. No attachments (fine). | `messages.send`, participant; thread not closed | **Yes**: every send |
| S8 | `typing` {threadId, isTyping} | C→S; relays S→C `typing` to `thread:<id>` | **None** (L209-225). No participant check, no agency check. | Any authenticated socket from **any agency** that knows or guesses a thread id can inject typing events (with its display name) into that room. Low confidentiality impact, but spoofing, cross-tenant noise and an info channel. | `messages.send` (or `messages.view`), participant; the sender must already be in the room (`socket.rooms.has(threadRoom)`) | Yes (a cheap room-membership check is enough) |
| S9 | `message:read` {threadId} | C→S | `isParticipant` (L232); `markRead` re-checks | No module check | `messages.view`, participant | Yes |
| S10 | `message:new` → `thread:<id>` | S→C (io.ts L42) | Emitted from `createMessage` | Delivered to stale room members (S4) | recipients = current participants with `messages.view` | Room membership must track changes |
| S11 | `thread:updated` → `user:<uid>` | S→C (io.ts L44 `{threadId}`; L59 full summary) | Recipients are the current participant list | Two payload shapes on one event name. Removed participants get no notice (the list is post-removal), so their UI keeps the thread. | same; also emit `thread:removed` to evicted users | n/a |
| S12 | `thread:created` → `user:<uid>` | S→C (io.ts L71) | Recipients are the participants | Includes client-role participants | same | n/a |
| S13 | `thread:read` → `thread:<id>` | S→C (io.ts L103) | none beyond the room | Read receipts leak to stale members | same | n/a |
| S14 | `message:updated` → `thread:<id>` | S→C (io.ts L113) | none beyond the room | stale members | same | n/a |
| S15 | `message:deleted` → `thread:<id>` | S→C (io.ts L123) | none beyond the room | Thread delete emits nothing | same; add `thread:deleted` | n/a |
| S16 | `notification:new` → `user:<uid>` | S→C (io.ts L79, from `services/notifications.ts:54`) | Recipient chosen by the caller | Content includes leave/checkout notes and message previews. Disabled users still receive until disconnect. | own | n/a |
| S17 | `portal:refresh` → `portal:<clientId>` | S→C (io.ts L93) | Emitted by posts, media, approvals, reservations, agreements, portal routes and social-publish | Payload is minimal (good). Revoked tokens still receive. | portal token scope | n/a |

**Socket event count:** 17 rows (2 handshakes, 2 auto-join room rules, 4 client→server events, 9 server→client events, with `typing` counted once as a relay).

---

## 3. Background and scheduled operations (`services/scheduler.ts`)

| Job | Schedule | Code | Resources touched | Actor it runs as | Authz notes |
|---|---|---|---|---|---|
| Monthly employee reports | `0 9 1 * *` | `runMonthlyReports` → `emailEmployeeReports(agencyId, prevMonth)` (scheduler L26-40, reports.ts L164-191) | attendance records, holidays, leaves, time logs, tasks, users; emails to every non-owner staff member and every owner | **System**, for every agency (no user context) | Same payload as the manual #15. Should run as a `system` principal holding `attendance.email_reports` per tenant. Per-agency opt-out absent. |
| Timer shift-end sweep | `*/15 * * * *` | `sweepStaleTimers` (`routes/timers.ts:292-349`) | timers, time logs (all agencies, unscoped `select * from timers`) | **Impersonates the timer owner** with a fabricated ctx `{agencyId, userId: timer.userId, role:'member'}` (timers.ts L337-341) | Fabricated role `member`. Logs and audits attribute the action to the user, not the system. Should be a `system` actor, with "on behalf of" recorded. |
| Timer stop on checkout | inline in #5 | `stopTimersForUser(ctx, ctx.userId, now)` (attendance.ts L507) | timers | Requesting user (self) | Fine (own) |
| Stale punch auto-reset | inline on GET /today, check-in, check-out | `autoResetStalePunches` (services/attendance.ts L392-430) | attendance records (sets `half_day`, worked 0) | Requesting user, own records only | Write triggered by a GET; not audited; `source` not changed to `system` |
| Month archive sweep | `15 0 1 * *` + 20s after boot | `sweepEndedMonths` | tasks, posts (not this scope) | System | n/a here |
| Social auto-publish | `*/5 * * * *` (flag) | `runDuePublishing` | content posts incl. those created by **sheet publish (#56)** | System | Makes #56's privilege bypass externally visible (posts to client social accounts) |
| Media archive / Refrens sync | weekly / 15 min (flags) | n/a | not this scope | System | n/a |
| Notifications fan-out | inline | `notify`, `notifyMany`, `agencyApprovers` (notifications.ts L39-105) | notifications, socket, push | Caller | `agencyApprovers` returns **only owner/admin**, so attendance managers (CAA) who can decide checkouts and regularizations never get the request notifications |

---

## 4. Proposed permission catalogue (derived from the operations above)

| Key | Scopes | Replaces |
|---|---|---|
| `attendance.check_in` | own | RW edit on POST check-in/out, GET today |
| `attendance.view` | own, team, organization | RW view + `targetUserId`/isPrivileged + CAA on whos-in/team-summary |
| `attendance.mark` | team, organization | PRIV on /mark |
| `attendance.manage_policy` | organization | PRIV on PUT /policy (also gates reading the geofence and IPs) |
| `attendance.export` | team, organization | CAA on team-report (plus a projects/time permission for utilization) |
| `attendance.email_reports` | organization | CAA on email-reports; the system job |
| `holidays.manage` | organization | PRIV |
| `leave_types.manage` | organization | PRIV |
| `leaves.request` | own | RW edit |
| `leaves.view` | own, team, organization | isPrivileged on scope=all, balances |
| `leaves.approve` | team, organization | PRIV on decide (unifies with managers) |
| `leaves.cancel` | own, team, organization | owner-or-isPrivileged |
| `regularizations.request` / `.view` / `.approve` / `.cancel` | own / own-team-org / team-org / own-org | CAA, isPrivileged |
| `checkout_requests.request` / `.view` / `.approve` / `.cancel` | own / own-team-org / team-org / own-org | CAA, isPrivileged |
| `messages.view` | participant (organization for moderation) | RW view, requireParticipant |
| `messages.send` | participant | RW edit, socket participant check |
| `messages.edit` | own | sender check |
| `messages.delete_own` / `messages.delete_any` | own / organization | RW manage + sender-or-owner/admin |
| `messages.pin` | participant | RW edit |
| `threads.create` | organization | RW edit |
| `threads.update` | participant | RW edit + participant |
| `threads.manage_participants` | own (creator), organization | RW edit + participant |
| `threads.delete` | own (creator), organization | RW manage + participant |
| `documents.view` / `documents.view_hidden` | organization | RW view + `role==='owner'` |
| `documents.upload` | organization | RW edit (sign + create) |
| `documents.update` / `documents.move` | own, organization | RW edit |
| `documents.delete` | own, organization | RW manage |
| `documents.share_client` | organization | (none today: any editor) |
| `documents.hide_from_team` | organization | `role==='owner'` |
| `folders.create` / `folders.update` / `folders.delete` | organization | RW edit / edit / manage |
| `sheets.view` / `create` / `update` / `delete` | organization (own for delete) | RW |
| `sheets.import` | organization | RW edit |
| `sheets.publish` | organization (+ `calendar.create`, `projects.create_task`) | RW edit |

**Cross-cutting object policies**
1. **No self-approval**: the subject `userId` of a leave, regularization or checkout request must differ from the approver. Owner exception only if the agency has a single owner, and then audited.
2. **Rank guard**: an approver or marker must outrank the subject (reuse `canManageRole`), or be the owner.
3. **Participant-bound realtime**: membership changes evict sockets from rooms; every client→server event re-checks participant status and permission.
4. **Storage keys are tenant-bound**: `publicId`/`fileUrl` must match `sanctum/<agencyId>/`.
5. **Cross-module side effects** (document→business record, sheet→posts/tasks/projects) require the target module's create permission.
6. **Cancel after approval** needs the approver permission, or a future start date.
7. **Sensitive-field masking**: location and geofence need a dedicated permission.

---

## 5. Most serious issues (ranked)

1. **Cross-tenant storage deletion:** `POST /documents` accepts an arbitrary `publicId`/`fileUrl`, and `DELETE /documents/:id` passes them to `deleteAsset` with no tenant-prefix check (`documents.ts:494-495, 691-697`; `storage.ts:115-132`).
2. **Document upload creates Business records:** any documents editor can create proposals, agreements or invoices (as `sent` and client-visible), bypassing the owner-only `business` module (`documents.ts:553, 569-628`).
3. **Sheet publish privilege bypass:** sheets:edit creates projects, scheduled client posts (which can auto-publish to social accounts) and tasks, and overwrites existing posts and tasks (`sheet-publish.ts:273-293, 455-541`).
4. **Self-approval:** approvers can approve their own leave (`leaves.ts:368-391`), regularization (`regularizations.ts:171-208`) and out-of-office checkout with full-day credit (`attendance.ts:934-1003`); owner/admin can `/mark` their own day (`attendance.ts:643-727`).
5. **Socket authorization snapshot:** removed participants, deleted threads and disabled or expired users keep receiving live thread traffic; the handshake never re-checks status or permission (`socket.ts:65-142`).
6. **Socket ignores the messages module:** `message:send` works for messages:view/none users and client-role participants; `typing` has no participant or tenant check at all (`socket.ts:175-225`).
7. **Any thread participant can add or remove anyone, re-link the client, or delete the whole thread** (with manage), with no audit (`services/messages.ts:869-962`).
8. **Pinned messages leak** outside thread participation and the messages module via `GET /clients/:clientId/pinned` and the AI summary (`clients.ts:624-635`; `messages.ts:1055-1093`).
9. **Leave integrity:** requesters can cancel already-approved (even past) leave without approval or audit (`leaves.ts:421-440`); quota ignores pending requests and isn't re-checked at approval (`leaves.ts:292-314, 368-391`).
10. **Cross-tenant read in PATCH leave type:** the re-read isn't scoped by agency (`leaves.ts:103`). Also: attendance managers can mass-email agency-wide reports and see all staff's utilization and emails (`attendance.ts:835-866`).

Other notable issues:
- The geofence trusts client-supplied lat/lng.
- Changing a document's category to an owner-only one doesn't set `hideFromTeam`.
- Any documents editor can share to the client portal.
- Members can't delete their own messages over REST (DELETE needs manage).
- Attendance managers get no approval notifications (`agencyApprovers` is owner/admin only).
- Approver gates are inconsistent (PRIV for leaves, CAA for regularizations and checkouts).
- The timer sweep impersonates users with a fabricated `member` role.
- GET `/today` performs writes.
