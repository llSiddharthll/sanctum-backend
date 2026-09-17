# 01 — Projects / Tasks / Timers / Me / Analytics: Authorization Inventory

Scope: `src/routes/projects.ts` (mounted `/api/v1/projects`), `src/routes/timers.ts` (`/api/v1/timers`), `src/routes/me.ts` (`/api/v1/me`), `src/routes/analytics.ts` (`/api/v1/analytics`), plus helpers in `src/services/archive.ts`, `src/middleware/permissions.ts`, `src/middleware/tenant.ts`, `src/lib/permissions.ts`. Mounts: `src/app.ts:94-96,114`. All paths below omit the `/api/v1` prefix.

**Endpoint count: 50** (projects.ts 41, timers.ts 4, me.ts 2, analytics.ts 3).

---

## 0. Shared building blocks (read these first — rows reference them)

### Permission resolution facts (`src/lib/permissions.ts`, `src/middleware/permissions.ts`)
- `loadPermissions`: owner → full `manage`; `client` → `none` everywhere; admin/member → user override > custom role > agency role default > **built-in default `manage`** (`lib/permissions.ts:228,333`).
- **`finance` and `business` are force-set to `none` for every non-owner** (`lib/permissions.ts:338-339`). So `meetsLevel(perms.finance,'view')` is true **only for owner**.
- `isPrivileged(role)` = owner || admin (`middleware/tenant.ts`) — role-based, ignores module levels.
- Presets: Manager = member + projects:manage; Employee = member + projects:edit.

### RG-P — projects router gate (`projects.ts:52-83`)
- `requireAuth` then: `projects >= view` for everything.
- Non-GET/HEAD/OPTIONS: if `req.path.includes('/tasks')` → **no extra level** (view suffices). Else POST/PATCH/PUT need `edit`, DELETE needs `manage`.

### RG-T — timers router gate (`timers.ts:29-49`)
- `requireAuth`; `projects >= view`; writes whose `req.path.includes('/logs')` need `edit`. Start/stop at view.

### Helpers in projects.ts
| Helper | Lines | Actual behavior |
|---|---|---|
| `canSeeProjectFinance` | 203-206 | `finance >= view` → **owner only** (comment claims owner/admin). |
| `canSeeAllProjects` | 214-219 | `isPrivileged(role)` OR `projects >= manage`. Admin passes even if their projects level is dialled down to `view`. |
| `canViewAllProjects` | 226-231 | `isPrivileged` OR `projects >= view`. **Always true for anyone who passed RG-P** → every "scoped" branch guarded by it is dead code. |
| `visibleProjectIds` | 239-280 | member rows ∪ projects with a task where caller is primary assignee or in `task_assignees`. Tenant-filtered. |
| `getScopedProject(req,id)` | 615-662 | Loads project by `id`+`agencyId` (404 otherwise). **GET or task write (`req.path.includes('/tasks')`)** → `canViewAllProjects` → effectively **tenant check only**. **Structure write** → `canSeeAllProjects` OR `project_members` row for caller, else 404. Method/path-sensitive (`req.method`, `req.path`), so the same helper gives different answers per route. |
| `getScopedTask(ctx,projectId,taskId)` | 1677-1695 | task by id + agency + project. **No assignee/visibility check.** |
| `getScopedLabel` / `getScopedMilestone` / `getScopedComment` | 1069-1087 / 2738-2756 / 2456-2474 | id + agency + parent id. No per-user check. |
| `requireAgencyClient` / `requireAgencyUser` | 665-688 | tenant existence checks only. |
| `resolveMentions` | 2344-2378 | Resolves to **any agency user** (doc comment says "intersect with project members" — it doesn't). No notification side effect. |
| `fetchProjectActivity` | 3248-3279 | audit_log where agency + `json_extract(metadata,'$.projectId')=id OR metadata LIKE '%"projectId":"<id>"%'`. Returns all actions, actor names and full metadata. |

### Helpers in timers.ts
| Helper | Lines | Behavior |
|---|---|---|
| `requireAgencyProject` / `requireAgencyTask` | 56-96 | tenant existence only; task-in-project consistency check. No membership/visibility. |
| `stopTimerRow` | 197-243 | Inserts `time_logs` for **`timer.userId`** (owner), deletes timer, audits with **`actorId = ctx.userId`** (the caller, may differ). |
| `stopTimersForTask` (exported) | 251-264 | Stops **all users'** timers on a task. |
| `stopTimersForUser` (exported) | 271-284 | Stops a given user's timers, capped at `endAt`. |
| `sweepStaleTimers` (exported, cron) | 292-349 | **All agencies**, fabricates ctx `{role:'member', userId: timer.userId}`. |
| `listProjectTimers` (exported) | 355-380 | All running timers in a project (all users). |

### archive.ts
| Function | Lines | Behavior |
|---|---|---|
| `sweepEndedMonths(now, agencyId?)` | 26-69 | Archives incomplete past-month **tasks AND content posts**; global across agencies when `agencyId` omitted. |
| `unarchiveTask(agencyId, taskId)` | 72-84 | Clears archive flags on any task in agency — **does not require the task to be archived** (returns true for active tasks too). |

---

## 1. Endpoint inventory

Legend: **RG-P / RG-T** = router gates above. **GSP** = `getScopedProject`. "Tenant" = `agencyId` present in the queries that read/write the target data. Scopes proposed: `own` (caller is creator/author/owner of the row), `assigned` (caller is a task assignee), `project` (caller is a project member), `client` (project belongs to a client the caller is assigned to via `client_assignments`), `organization` (whole agency).

### 1.1 Projects

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter | Object scoping | Sensitive fields filtered | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | GET | /projects | List projects (filters status/health/clientId/search) | RG-P (view) | `canViewAllProjects` (715) → else `visibleProjectIds` (716) | yes (706) | List; scoped branch never taken (canViewAllProjects always true past RG) | `contractValue`, `recurringPaise` nulled unless `canSeeProjectFinance` (731, 308-310) → owner only | **Dead scoping**: every projects:view user sees every project in agency incl. scopeOfWork/description/services/client name. Finance comment says owner/admin, actual owner-only (admins never see contract values). | projects.view | assigned, project, client, organization | Query-level filter: id ∈ scope set. Field policy: money fields require projects.view_financials. |
| 2 | GET | /projects/all-tasks | Cross-project task board (filters projectId, clientId, status, priority, assigneeId, search, archived, month) | RG-P (view) | `canSeeAllProjects` (771) → else restrict to `visibleProjectIds` (772-774) | yes (748) | List; scoped members restricted to *projects* they're on, **not** to their own tasks | none needed (no money) | Inconsistent with #14 (own-tasks only): an Employee on a project sees every teammate's task here, incl. archived history. `status`/`priority` cast `as any` (no enum validation). Admin with projects:view gets full board via isPrivileged. | tasks.view | assigned, project, client, organization | Query filter by task scope (assigned vs project membership) — same resolver as #14. |
| 3 | POST | /projects/tasks/archive-run | Force month-archive sweep for agency | RG-P: path contains `/tasks` → **view only** | `canSeeAllProjects` (807) → 403 | yes (sweepEndedMonths agencyId, archive.ts:45,63) | N/A (bulk) | N/A | **Cross-module side effect**: also archives **content posts** (calendar module) with no calendar permission check. Admin with projects:view passes via `isPrivileged`. Relies on path-substring for the gate. | tasks.archive (+ content_posts.archive for the post half, or split the endpoint) | organization | Bulk op; require organization scope; posts portion requires calendar permission. |
| 4 | POST | /projects/tasks/:taskId/unarchive | Restore archived task | RG-P: `/tasks` → view only | `canSeeAllProjects` (819) | yes (archive.ts:80) | Loads by taskId+agency only; no project/visibility check; **does not verify task is archived** (returns "restored" for active tasks) | N/A | Admin with projects:view passes (isPrivileged). Weak 404 semantics. | tasks.restore | project, organization | Task must be archived; caller has tasks.restore in scope of task's project. |
| 5 | GET | /projects/milestone-templates | Static service→milestone presets | RG-P (view) | none | N/A (static) | N/A | N/A | none | projects.create (or none — static config) | organization | none |
| 6 | POST | /projects | Create project (+ creator as project owner member, + seeded milestones) | RG-P: POST → edit | `isPrivileged` OR `projects >= manage` (880-888) | yes (895, 922, 933); client verified in agency (890) | clientId verified tenant-only; **no check caller may act on that client** | Response money filtered via `canSeeProjectFinance` (959) | **Anyone who can create can set `contractValue`/`recurringPaise`/`billingType`** without finance rights (906-912) — write-side finance leak. Admin with projects:edit passes via isPrivileged (module level bypass). Side effect: inserts `project_members` (role 'owner') + milestones. | projects.create; projects.update_financials (for money fields); project_milestones.create (seeded) | client, organization | Client must be in caller's client scope; money fields only if update_financials. |
| 7 | GET | /projects/:id | Project detail | RG-P (view) | GSP read branch (964) → tenant only | yes (625) | Loaded id+agency; **access effectively not verified** (canViewAllProjects always true) | money filtered (965) | Any projects:view user reads any project. | projects.view; projects.view_financials | assigned, project, client, organization | Visible if in scope; money fields per view_financials. |
| 8 | PATCH | /projects/:id | Update project settings incl. status/health/client/money/dates | RG-P: PATCH non-task → edit | GSP structure branch (989): `canSeeAllProjects` OR project membership | yes (1018); new clientId verified (993) | Membership verified for non-managers | response money filtered (1036) | **Employee (projects:edit) who is a project member can change `contractValue`, `recurringPaise`, `billingType`, `clientId`, status** — finance write without finance permission; can move project to another client. Project-member `role` (owner/other) is ignored. | projects.update; projects.change_status; projects.update_financials; projects.change_client (or fold into update with client scope) | project, client, organization | Caller in scope; money fields require update_financials; clientId change requires scope on both source and target client. |
| 9 | DELETE | /projects/:id | Hard-delete project (cascades tasks, logs, milestones, members, comments…) | RG-P: DELETE non-task → manage | GSP structure branch (1043) — redundant since manage ⇒ canSeeAllProjects | yes (1048) | id+agency | N/A | Destructive cascade (time logs = billing evidence) with only projects:manage (Manager preset). No soft delete / archive. Cascaded children not audited. | projects.delete (consider projects.archive + restore as the normal path) | organization | Only org scope; block if time logs/invoices exist unless forced. |
| 10 | GET | /projects/:id/labels | List project labels | RG-P (view) | GSP read (1093) → tenant only | yes (1100) | tenant only | N/A | Same universal-read as #7. | projects.view | assigned, project, client, organization | Inherit project visibility. |
| 11 | POST | /projects/:id/labels | Create label | RG-P: POST non-task → edit | GSP structure (1118): manager OR membership | yes (1137); dup check lacks agencyId but projectId already scoped (1127) | membership verified | N/A | — | project_labels.create (or project_labels.manage) | project, organization | Caller project member / org. |
| 12 | PATCH | /projects/:id/labels/:labelId | Rename/recolor label | RG-P: edit | GSP structure (1170) + `getScopedLabel` (1171) | yes (1199) | label in project+agency | N/A | — | project_labels.update | project, organization | as #11 |
| 13 | DELETE | /projects/:id/labels/:labelId | Delete label (cascade links) | RG-P: manage | GSP structure (1226) + getScopedLabel | yes (1234) | as above | N/A | — | project_labels.delete | project, organization | as #11 |

### 1.2 Tasks (project-scoped)

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter | Object scoping | Sensitive fields filtered | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 14 | GET | /projects/:id/tasks | Task list (group/filter/sort) | RG-P (view) | GSP read (1290) → tenant only; `canSeeAllProjects` false → only tasks where caller is primary assignee or in task_assignees (1322-1338) | yes (1311, subqueries 1328, 1359, 1407) | List filtered at query level for scoped members | N/A | Only endpoint that scopes to own tasks; siblings (#2, #18, #21, #24, #28, #37-#41) do not → scoping is cosmetic. | tasks.view | assigned, project, client, organization | Query-level task scope filter. |
| 15 | POST | /projects/:id/tasks | Create task / subtask with assignees | RG-P: `/tasks` → **view** | GSP task-write (1517) → tenant only; scoped member forced into assignee set (1529-1530); assignees verified in agency (1532-1534); parent/milestone same project (1540,1545) | yes | Project: **no membership check** — any projects:view user can create tasks in any project | N/A | **View-only users write**; can create tasks in projects they're not on; can **assign arbitrary agency users** (incl. owner/admin/clients? `requireAgencyUser` doesn't exclude `client` role users). Subtask parent not visibility-checked. | tasks.create; tasks.assign (when assigneeIds ≠ self) | project (member), organization; self-assign under assigned | Caller must have tasks.create in project scope; assigning others requires tasks.assign and assignees must be staff (non-client) and ideally project members. |
| 16 | POST | /projects/:id/tasks/bulk | Bulk create tasks from titles | RG-P: `/tasks` → view | GSP task-write (1612) → tenant only; milestone check (1616) | yes | no membership check | N/A | View-only user can bulk-create unlimited tasks (no max on `titles`) in any project; tasks are **unassigned**, so a scoped creator can't see them afterwards (#14). No rate/size limit. | tasks.create | project, organization | as #15; cap array size. |
| 17 | PATCH | /projects/:id/tasks/:taskId | Update task: title/desc/status/assignees/milestone/priority/estimate/dates/parent/position | RG-P: `/tasks` → view | GSP task-write (1716) → tenant only; `getScopedTask` (1717); assignees in agency (1730); milestone/parent validity (1733-1756). **No ownership/assignee check.** | yes (1790) | Task loaded by id+project+agency; **caller's access to that task not verified** | N/A | **Critical IDOR**: any projects:view user can edit ANY task in ANY project: reassign (incl. remove the real assignee), change status/due date. Side effects: `status→done` **stops every user's running timers** on the task and writes their time logs (1801-1805); if task has `postId`, flips the **content post** to `posted`/`scheduled` and broadcasts to **client portal** (1810-1839) without calendar permission. Enables delete bypass (#19): assign self then delete. | tasks.update; tasks.change_status; tasks.assign; (content_posts.update implied by linked post) | assigned (own tasks), project, organization | Update/change_status: task in caller's scope (assigned for Employees). Assign: tasks.assign in project scope; assignees must be staff. Completing a post-linked task requires calendar permission on the post's client (or make it a system rule). |
| 18 | GET | /projects/:id/tasks/:taskId/subtasks | List subtasks | RG-P (view) | GSP read (1891); getScopedTask (1892) | yes | **no task visibility check**; returns all subtasks regardless of assignee | N/A | IDOR read of tasks outside scoped member's own set. | tasks.view | assigned, project, organization | Parent visible AND filter subtasks by task scope (or inherit parent visibility — decide). |
| 19 | DELETE | /projects/:id/tasks/:taskId | Hard-delete task | RG-P: `/tasks` → **view** (DELETE normally needs manage) | GSP task-write (1913); getScopedTask; scoped member must be primary assignee or in task_assignees (1919-1934) | yes (1941) | ownership check for non-managers | N/A | View-level users can delete (their assigned) tasks; **bypassable** via #17 (self-assign then delete). Admin with projects:view deletes any task (isPrivileged). Deletes cascade time logs/comments? (FK cascade) — logged time lost. | tasks.delete | own (creator) / assigned, project, organization | Delete only if in scope; for `assigned` scope, require caller be creator (tasks have no createdBy column today — gap) rather than mere assignee; block if time logs exist. |
| 20 | PUT | /projects/:id/tasks/:taskId/labels | Replace task label set | RG-P: `/tasks` → view | GSP task-write (1970); getScopedTask; labels belong to project (1976-1993) | yes | no task visibility check | N/A | IDOR write on any task. | tasks.update | assigned, project, organization | as #17 update |
| 21 | GET | /projects/:id/tasks/:taskId/dependencies | Blocked-by / blocks lists | RG-P (view) | GSP read; getScopedTask (2105) | yes (2126,2145) | no task visibility check; returns full serialized other tasks | N/A | IDOR read; leaks other tasks' titles/assignees. | tasks.view | assigned, project, organization | Task visible; filter/redact dependency endpoints not visible. |
| 22 | POST | /projects/:id/tasks/:taskId/dependencies | Add dependency edge | RG-P: `/tasks` → view | GSP task-write; getScopedTask for both tasks (2173,2183); cycle check | yes; dup check lacks agencyId (2190-2199) but ids pre-scoped | no visibility check on either task | N/A | IDOR write; can block other people's tasks. | tasks.update (task_dependencies folded into tasks) | assigned, project, organization | Caller may update the task AND view the other task. |
| 23 | DELETE | /projects/:id/tasks/:taskId/dependencies/:depId | Remove dependency | RG-P: `/tasks` → view (bypasses manage-for-DELETE) | GSP; getScopedTask; dep in project+agency and touches task (2251-2266) | yes | no visibility check | N/A | IDOR write. | tasks.update | assigned, project, organization | as #22 |
| 24 | GET | /projects/:id/tasks/:taskId/comments | List comments | RG-P (view) | GSP read; getScopedTask (2385) | yes (2393) | no task visibility check | N/A | IDOR read of any task's discussion. | task_comments.view (or inherit tasks.view) | assigned, project, organization | Inherit task visibility. |
| 25 | POST | /projects/:id/tasks/:taskId/comments | Add comment with mentions | RG-P: `/tasks` → view | GSP task-write; getScopedTask (2413); mentions → any agency user (2416) | yes | no task visibility check | N/A | Comment on any task; mentions not restricted to project members (contradicts doc comment). | task_comments.create (`tasks.comment`) | assigned, project, organization | Task visible to caller; mentions limited to users who can view the task. |
| 26 | PATCH | /projects/:id/tasks/:taskId/comments/:commentId | Edit own comment | RG-P: `/tasks` → view | GSP; getScopedTask; getScopedComment; **author-only** (2494) | yes | author verified | N/A | No moderation path (owner/admin can't edit). OK otherwise. | task_comments.update | own (organization for moderation) | author == caller, or org-scope moderator. |
| 27 | DELETE | /projects/:id/tasks/:taskId/comments/:commentId | Soft-delete own comment | RG-P: `/tasks` → view | GSP; getScopedTask; getScopedComment; **author-only** (2541) | yes | author verified | N/A | No moderation delete; not audited. | task_comments.delete | own, organization (moderation) | author == caller or moderator. |
| 28 | GET | /projects/:id/tasks/:taskId | Task detail bundle (task, subtasks, labels, deps, comments, audit activity, feed) | RG-P (view) | GSP read; getScopedTask (2568) | yes (2578, 2595, 2618) | **no task visibility check** | Audit metadata returned raw (2630) | IDOR read; full activity history (actor names, assignee ids, status history). | tasks.view | assigned, project, organization | Task in caller's scope. |

### 1.3 Milestones & Members

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter | Object scoping | Sensitive fields filtered | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 29 | GET | /projects/:id/milestones | List milestones | RG-P (view) | GSP read (2667) → tenant only | yes (2674) | tenant only | N/A | universal read | projects.view | assigned, project, client, organization | inherit project visibility |
| 30 | POST | /projects/:id/milestones | Create milestone | RG-P: edit | GSP structure (2698): manager OR membership | yes | membership verified | N/A | — | project_milestones.create | project, organization | project member / org |
| 31 | PATCH | /projects/:id/milestones/:milestoneId | Update / complete milestone | RG-P: edit | GSP structure (2770); getScopedMilestone | yes (2802) | membership verified | N/A | Completion is a client-visible deliverable signal but gated like any edit. | project_milestones.update; project_milestones.change_status | project, organization | as #30 |
| 32 | DELETE | /projects/:id/milestones/:milestoneId | Delete milestone | RG-P: manage | GSP structure (redundant); getScopedMilestone | yes (2849) | — | N/A | Tasks referencing milestone: FK behaviour not checked here. | project_milestones.delete | project, organization | as #30 |
| 33 | GET | /projects/:id/members | List project members incl. **email** | RG-P (view) | GSP read (2874) → tenant only | yes (2889) | tenant only | returns `userEmail` | Any viewer lists members+emails of any project. | projects.view (project_members.view) | project, organization | inherit project visibility |
| 34 | POST | /projects/:id/members | Add member (free-text role) | RG-P: edit | GSP structure (2917): manager OR membership; `requireAgencyUser` (2919) | yes | membership verified | N/A | **Employee (edit) project member can add any agency user** (incl. `client`-role users, since requireAgencyUser doesn't filter role) → **membership grants structure-edit on the project**, so members can mint new structure editors. Free-text `role` accepts `'owner'` (no semantic today but will matter if project roles drive policy). onConflictDoNothing then audits as if added. | project_members.manage (`projects.manage_members`) | project (if project role = owner/lead), organization | Only project owner/lead or org-scope; target must be staff; role from enum; cannot grant role above own. |
| 35 | DELETE | /projects/:id/members/:memberId | Remove member | RG-P: manage | GSP structure (redundant) | yes (2990) | member row in project+agency | N/A | Can remove the project 'owner' member / last owner; no guard. | project_members.manage | project (owner/lead), organization | Cannot remove last owner; cannot remove higher project role. |

### 1.4 Project time tracking reads, activity, overview

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter | Object scoping | Sensitive fields filtered | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 36 | GET | /projects/:id/timers | Who is running a timer now | RG-P (view) | GSP read (3019) → tenant only | yes (timers.ts:368) | tenant only | returns userId/name/task/startedAt of everyone | Any viewer sees live activity of all users on any project (surveillance-ish). | timers.view | project, organization | project visibility; Employees maybe own only. |
| 37 | GET | /projects/:id/time-summary | Totals by member / by task + active timers | RG-P (view) | GSP read (3027) → tenant only | yes (3038, 3054, 3071) | tenant only | per-member minutes exposed; no finance | Employees see teammates' logged minutes; task titles of tasks they can't list (#14). | time_logs.view | own, project, organization | Query-level: own rows for `own`; aggregates only for project/org. |
| 38 | GET | /projects/:id/time-logs | Recent logs with notes | RG-P (view) | GSP read (3105) → tenant only | yes (3124) | tenant only | notes + users exposed | as #37; notes may be sensitive. | time_logs.view | own, project, organization | as #37 |
| 39 | GET | /projects/:id/tasks/:taskId/time-logs | Task time-log timeline | RG-P (view) | GSP read; getScopedTask (3155) | yes (3170, 3182, 3189) | no task visibility check | all users' logs | IDOR read on tasks outside scope. | time_logs.view (+ tasks.view on the task) | own, assigned, project, organization | task visible + time log scope filter. |
| 40 | GET | /projects/:id/activity | Project audit feed | RG-P (view) | GSP read (3289) → tenant only | yes (3268) | tenant only; LIKE fallback on metadata | full audit metadata returned (incl. member names, assignee ids, timer minutes, label/milestone ops) | Any viewer reads full audit trail for any project; LIKE-on-JSON matching is fragile (any audit row embedding that projectId string from other modules would appear). | projects.view_activity (or projects.view + field redaction) | project, organization | project visible; redact entries about tasks not visible to caller. |
| 41 | GET | /projects/:id/overview | Boss dashboard: task counts, milestones, members, total time, active timers, recent activity | RG-P (view) | GSP read (3301) → tenant only | yes | tenant only | counts incl. archived tasks; recent activity metadata | Whole-project aggregates to Employees (contradicts own-task scoping in #14). | projects.view (aggregate) ; time_logs.view for time totals | project, organization | project visible; aggregates respect task scope or require project/org scope. |

### 1.5 Timers (`/timers`)

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter | Object scoping | Sensitive fields filtered | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 42 | POST | /timers/start | Start own timer on project/task (auto-stops previous → writes time log) | RG-T (view) | `requireAgencyProject` (395), `requireAgencyTask` w/ project match (398); always keyed to `ctx.userId` (406, 419) | yes | project/task tenant-verified only; **no membership/visibility/status check** | N/A | Log time against any project/task in agency (incl. completed/cancelled projects, done/archived tasks, tasks not assigned to caller). Writes a time_log as side effect. | timers.track (own) ≈ time_logs.create | own (on tasks in assigned/project scope) | Caller must be able to view the task/project; project status active; task not done/archived. |
| 43 | POST | /timers/stop | Stop own timer → time log | RG-T (view) | own timer only (470-473) | yes | own | N/A | none | timers.track | own | owner == caller |
| 44 | GET | /timers/active | Own running timer | RG-T (view) | own (521, 160) | yes | own | N/A | none | timers.track (or implicit) | own | owner == caller |
| 45 | PATCH | /timers/logs/:logId | Edit a time log's note | RG-T: path `/logs` → edit | tenant existence only (538-547). **No owner check** | partial: select has agencyId (545); update by id only (550) | **Not verified** | N/A | **IDOR**: any projects:edit user edits the note on any colleague's time log in agency (billing narrative). Path-substring gate. | time_logs.update | own, project (lead), organization | log.userId == caller for `own`; others need project/org scope. |

### 1.6 Me (`/me`)

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter | Object scoping | Sensitive fields filtered | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 46 | GET | /me/tasks | My assigned tasks across projects (+ archived) | `requireAuth` + `requireModule('projects','view')` (me.ts:20-21) | Filter to primary assignee or task_assignees = caller (74-95) | yes (79, 85) | self-scoped at query level | N/A | none (correct pattern) | tasks.view | own/assigned | Query filter assignee = caller. |
| 47 | GET | /me/overview | My open/overdue/due-today counts + my minutes today/week | same | self filters (149-161, 189, 199) | yes | self | N/A | none. Uses server-local TZ for day boundaries (not authz). | tasks.view + time_logs.view | own | self |

### 1.7 Analytics (`/analytics`)

| # | Method | Path | Business operation | Current gate(s) | In-handler authz checks | Tenant filter | Object scoping | Sensitive fields filtered | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 48 | GET | /analytics/summary | Agency content post counts by status + active clients + posts | `requireAuth` + `requireModuleRW('dashboard')` (GET → view) | none | yes (45, 56, 64) | agency-wide aggregate | N/A | Agency-wide client/post counts to anyone with dashboard:view (default manage). Low. | reports.view_dashboard (analytics.view) | client, organization | Aggregate over caller's client scope. |
| 49 | GET | /analytics/team-overview | Projects by status/health, tasks by status, team size | `requireModuleRW('projects')` (GET → view) | none | yes (91, 96, 101, 106, 111) | agency-wide | N/A | Comment says "Manager dashboard" but gate is projects:view → every Employee sees agency-wide project health + team size. | reports.view_team_overview | project, organization | Aggregate over caller's project scope. |
| 50 | GET | /analytics/leaderboard | Per-employee efficiency ranking (tasks, time, **attendance, late count, approved leave**) | `requireModule('projects','manage')` (173) | none | yes (all 6 queries) | agency-wide, per named user | exposes attendance %, overdue count, designation per employee | **HR-sensitive data (attendance/lateness/leave) gated on the projects module** — a Manager preset (member tier, no attendance/team manage requirement) or anyone with a projects:manage override reads it; attendance/team permissions not consulted. Admin with projects<manage is blocked (no isPrivileged bypass here — inconsistent with projects.ts). | reports.view_leaderboard (+ attendance.view for attendance component) | organization (or team scope) | Require both; redact attendance component unless attendance.view at org scope. |

---

## 2. Cross-cutting issues (ranked)

1. **Task IDOR writes at VIEW level** — `getScopedProject` treats any `/tasks` write as open when `canViewAllProjects` (always true past RG-P). No per-task ownership in PATCH task (#17), PUT labels (#20), dependencies (#22, #23), comments create (#25), task create in non-member projects (#15, #16). Any projects:view user (incl. read-only) can modify any task in the agency.
2. **PATCH task side effects on other users/modules** (#17): completing a task stops all users' timers & writes their time logs (`projects.ts:1801-1805`), and flips a linked content post to `posted` + client-portal broadcast (`1810-1839`) without calendar permission.
3. **Own-task delete bypass** (#19): self-assign via #17 then delete; delete allowed at view level.
4. **Task read scoping is cosmetic**: only #14 filters to own tasks; #2, #18, #21, #24, #28, #37-#41 expose everything. `canViewAllProjects` makes all project-level scoping dead code (`projects.ts:226-231, 637-642, 715`).
5. **Finance write leak**: project create/update accept `contractValue`/`recurringPaise`/`billingType` from any Manager (create) or any edit-level project member (update) (#6, #8) while reads are owner-only.
6. **Time log note IDOR** (#45): `timers.ts:533-550` no owner check.
7. **Membership self-propagation** (#34): edit-level project members can add any agency user (even client-role users) as project members, and membership = structure-edit rights.
8. **Path-substring gating** (`projects.ts:69`, `timers.ts:42`, and `getScopedProject` 631): `req.path.includes('/tasks')` relaxes DELETE/POST levels; also relaxes `archive-run`/`unarchive`. Not exploitable with current id formats (param must start with `tasks`), but any future route containing `/tasks` or `/logs` inherits relaxed rules.
9. **Role bypass of module levels**: `canSeeAllProjects` returns true for admin regardless of their projects level (`projects.ts:216`), so an admin dialled down to projects:view can archive-run (#3, which also archives posts), unarchive (#4), delete any task (#19), and edit any task/see all tasks. POST /projects also bypasses manage for admin (`880`).
10. **Leaderboard exposes attendance/leave** under projects:manage (#50).
11. **archive-run archives content posts** (#3) — cross-module write from projects endpoint.
12. `unarchiveTask` doesn't require `archivedAt IS NOT NULL` (archive.ts:79-81).
13. Timer start on any project/task regardless of visibility/status (#42).
14. `canSeeProjectFinance` comment vs behavior: admins never see money (finance forced `none`) — decide intended policy.
15. `resolveMentions` resolves any agency user (doc comment claims project members).
16. Hard delete of projects (#9) cascades time logs with only projects:manage; no archive/restore.
17. `/analytics/team-overview` agency-wide to all projects:view users (#49).
18. No moderation for comments (#26, #27); comment delete not audited.

---

## 3. (a) Side effects that write on behalf of another user

| Where | Effect | Actor recorded |
|---|---|---|
| POST /projects/:id/tasks (#15) `projects.ts:1526-1572` | Assigns arbitrary agency users (task_assignees rows + `assigneeId`) | audit actor = caller |
| PATCH /projects/:id/tasks/:taskId (#17) `1723-1797` | Replaces assignee set (add/remove other users) | caller |
| PATCH task → `stopTimersForTask` (`projects.ts:1802`, `timers.ts:251-264`) | Stops **other users' timers**, inserts **time_logs owned by those users** (`timers.ts:214-223`) | audit `timer.stop` actorId = caller, but log userId = timer owner |
| PATCH task → content post status (`projects.ts:1814-1836`) | Updates content post (client calendar) + portal broadcast | no audit for the post change |
| POST /projects (#6) `920-926` | Inserts creator as project `owner` member | caller (self) |
| POST /projects/:id/members (#34) | Adds another user to project (grants them structure-edit) | caller |
| DELETE /projects/:id/members/:memberId (#35) | Removes another user's project access | caller |
| PATCH /timers/logs/:logId (#45) | Edits note on another user's time log | caller |
| POST /projects/tasks/archive-run (#3) | Archives other users' tasks and content posts | **not audited** |
| POST /projects/tasks/:taskId/unarchive (#4) | Restores any task | **not audited** |
| DELETE task (#19) / project (#9) | Destroys other users' logged time via cascade | caller |
| POST /timers/start (#42) | Auto-stops caller's previous timer (self only) | caller |
| `stopTimersForUser` (attendance check-out, `routes/attendance.ts:507`) | Self only (ctx.userId) | caller |
| `sweepStaleTimers` cron (`timers.ts:292-349`) | Writes time logs for every user in every agency; fabricated ctx role `member` | audit actor = timer owner (system action misattributed to user) |

## 4. (b) Data that should be scope-filtered at query level

- `GET /projects` (#1): project ids ∈ caller scope (assigned/project/client/org). Currently only tenant.
- `GET /projects/all-tasks` (#2): task scope (assigned vs project), not just project set.
- `GET /projects/:id/tasks` (#14): already filtered; move predicate into a shared task-scope resolver.
- Subtasks (#18), task detail subtasks/dependency endpoints (#21, #28): filter child/related tasks by task scope or define "parent visible ⇒ children visible".
- Comments & activity on tasks (#24, #28): inherit task visibility.
- Project activity (#40) & overview recentActivity (#41): filter audit rows to entities the caller can see; move away from JSON LIKE matching to an indexed `projectId` column.
- Time logs/summaries (#37, #38, #39) and running timers (#36, #41): `own` scope → `userId = caller`; aggregates by member only for project/org scope.
- Members list (#33): emails maybe redacted for non-project scopes.
- Money fields (`contractValue`, `recurringPaise`) in #1, #6, #7, #8: field-level, require `projects.view_financials`.
- `/analytics/team-overview` (#49), `/analytics/summary` (#48): aggregate over caller's scope.
- `/analytics/leaderboard` (#50): attendance/leave components need attendance permission; consider team scope.

## 5. (c) Internal / background callers of these operations

| Caller | Operation | Notes |
|---|---|---|
| `services/scheduler.ts:50` cron `15 0 1 * *` + boot backfill (setTimeout 20s) | `sweepEndedMonths(new Date())` — **all agencies**, tasks + content posts | No actor, no audit; system principal needed. |
| `services/scheduler.ts:80` cron `*/15 * * * *` | `sweepStaleTimers()` — all agencies | Fabricates `{role:'member', userId: owner}` ctx; audit misattributes to timer owner. |
| `routes/attendance.ts:507` (check-out handler) | `stopTimersForUser(ctx, ctx.userId, now)` | Self only; gated by attendance module, not projects. |
| `routes/projects.ts:1802` (PATCH task) | `stopTimersForTask` | Cross-user side effect (see §3). |
| `routes/projects.ts:3020, 3078, 3379` | `listProjectTimers` | Project read endpoints. |
| `routes/posts.ts:460` | `unarchivePost` (archive.ts sibling) | Out of scope file; same "no archived check" pattern. |
| Monthly employee reports (`scheduler.ts` `runMonthlyReports` → `services/reports.ts`) | Reads tasks/time logs per employee | Background reader; would need system principal. |
| Other writers of tasks/assignees/members outside these files (for consistency with the new policy layer): `routes/ai-assistant.ts:357` (insert project_tasks), `services/sheet-publish.ts:285` (insert project_members), `:467` (update project_tasks), `:476/:532` (insert task_assignees), `:520` (insert project_tasks) | Create/assign tasks and add project members on behalf of users | Must route through the same `tasks.create`/`tasks.assign`/`project_members.manage` policy (or system principal). |

---

## 6. Proposed permission catalogue for this area (minimal set)

| Permission | Covers endpoints | Typical scopes |
|---|---|---|
| projects.view | 1, 7, 10, 29, 33, 41 | assigned, project, client, organization |
| projects.view_financials | money fields in 1, 6, 7, 8 | organization |
| projects.update_financials | money fields in 6, 8 | organization |
| projects.create | 5, 6 | client, organization |
| projects.update | 8 (non-money, non-status) | project, organization |
| projects.change_status | 8 (status/health) | project, organization |
| projects.delete | 9 | organization |
| projects.view_activity | 40, 41 (recentActivity), 28 (activity) | project, organization |
| project_members.manage | 34, 35 | project (project owner/lead), organization |
| project_milestones.create / update / delete | 6 (seeded), 30, 31, 32 | project, organization |
| project_labels.manage | 11, 12, 13 | project, organization |
| tasks.view | 2, 14, 18, 21, 24, 28, 46 | own/assigned, project, organization |
| tasks.create | 15, 16 | project, organization |
| tasks.update | 17 (fields), 20, 22, 23 | assigned, project, organization |
| tasks.change_status | 17 (status) | assigned, project, organization |
| tasks.assign | 15/17 (assigning others) | project, organization |
| tasks.delete | 19 | own (creator), project, organization |
| tasks.archive / tasks.restore | 3 / 4 | organization / project, organization |
| task_comments.create | 25 | assigned, project, organization |
| task_comments.update / delete | 26, 27 | own, organization (moderation) |
| time_logs.view | 37, 38, 39, 41, 47 | own, project, organization |
| time_logs.update | 45 | own, project, organization |
| timers.track | 42, 43, 44 | own |
| timers.view | 36, 37/41 activeTimers | project, organization |
| reports.view_dashboard | 48 | client, organization |
| reports.view_team_overview | 49 | project, organization |
| reports.view_leaderboard | 50 (+ attendance.view for attendance component) | organization |

Object-policy notes:
- Task policy needs a `createdBy` column on `project_tasks` (absent today) to express `own` distinct from `assigned`.
- Project-role (`project_members.role`, free text today) should become an enum (owner/lead/member/viewer) if `project` scope is to distinguish structure editors from contributors.
- Assignee targets must be non-client staff (and ideally project members); `requireAgencyUser` does not check role.
- System principal required for scheduler sweeps and for cascade side effects (timer auto-stop, post status sync) so they are authorized/audited as system actions rather than as the triggering user.
