# src/authz — how to authorize code in Sanctum

Design & rationale: [`docs/authorization/README.md`](../../docs/authorization/README.md). This file is the **coding contract** every router, service, job and socket handler follows.

## Rules

1. **No role checks.** Never use `role ===`, `isPrivileged`, `requireRole`, `requireModule*`, `loadPermissions`, `canManageRole`, `getAuth(req).role`, `isOwner` flags, or anything in `src/lib/permissions.ts`. Those are legacy and are being deleted.
2. **Authenticate once:** `router.use(authenticate)` from `authz/http.ts`. Get the principal with `getActor(req)` / `getStaffActor(req)` / `getUserActor(req)`.
3. **Every route declares its permission(s)** with `requires('x.y')` / `requiresAny(...)` (any scope). Self-service routes that only need a session say so in a comment.
4. **Object routes authorize the object**, not just the route:
   ```ts
   const facts = await taskFacts(actor, taskId);          // null → not in tenant
   authorize(actor, 'tasks.update', facts, { view: 'tasks.view', condition: () => … });
   ```
   - `authorize` throws 404 when the actor cannot view the object (existence is never leaked), and 403 otherwise.
   - `condition` holds object rules that aren't scopes: no self-approval, state machines, cross-module requirements.
5. **Lists filter in SQL** using the scope helper of the resource policy (e.g. `taskScopeFilter(actor, 'tasks.view')`). Never fetch-all-then-filter, and never return everything because the route gate passed.
6. **Facts loaders** live in `authz/policies/<resource>.ts`. They take `(actor, id)` and return `ObjectFacts` (`agencyId`, `ownerIds`, `assigned`, `projectMember`, `clientId`, `projectId`, `clientVisible`) or `null`. Always filter by `actor.agencyId`. Child objects must also be bound to their URL parent (post ↔ client, comment ↔ task, …).
7. **Input references** go through `authz/tenancy.ts`:
   - `requireInAgency` for any id;
   - `requireActiveStaff` for user refs;
   - `assertAgencyStorageKey` for files.
8. **Sensitive fields** are serialized only with their field permission, e.g. `projects.view_financials`, `users.view_compensation`, `deals.view_value`, `proposals.view_pricing`. Writing a sensitive field requires its update permission.
9. **Capabilities for clients:** object responses the UI acts on include `capabilities: capabilities(actor, facts, ['tasks.update', 'tasks.delete', …])`, keyed by full permission key.
10. **Cross-module operations** require every involved permission. Examples: document upload as invoice → `invoices.create`; sheet publish → `posts.create` / `tasks.create`; AI task breakdown → `tasks.create` on the project.
11. **Background jobs** act as `systemActor(job, agencyId, grants)` with an explicit minimal grant list. They never impersonate users, and they are audited with `actorType: 'system'`.
12. **Notifications** go to people by capability: `notifyPermissionHolders(agencyId, 'leaves.approve', …)`. Never target people by role.
13. **Audit** authorization-relevant changes with `auditAuthz` (before/after). Use `audit` for business events, with `actorType: actor.type`.
14. **Client-side actors** (`client`, `portal_link`) use the `client` scope. Their facts need `clientId`, `projectId` (when project-bound) and `clientVisible`. Project access `selected` with no ids means none.
15. **Tests:** `createMemberSession(owner, { grants: [...] })` or `{ roleIds }`. Add scenario tests under `test/authz/` for allow + deny + cross-tenant + object ownership.
