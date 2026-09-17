# 05 — Business & Finance authorization inventory

Scope: `src/routes/leads.ts`, `proposals.ts`, `agreements.ts`, `invoices.ts`, `expenses.ts`, `finance.ts`, `refrens.ts`, `intake.ts`; `src/services/refrens.ts`, `refrens-sync.ts`, `scheduler.ts`; `src/lib/finance.ts`. Also a sweep of `src/` for other places that expose or write money.

Everything was read from code (read-only; nothing modified). All paths are mounted under `/api/v1` (`src/app.ts:87-100`).

---

## 0. How the gates work today (only what matters here)

| Mechanism | Where | Effect |
|---|---|---|
| `requireAuth` | `middleware/auth.ts:12` | Verifies the JWT (cookie `sanctum_at` or Bearer) and sets `req.auth = {userId, agencyId, role, clientId}`. The role comes from the **token claim**, so it can be stale until refresh. |
| `requireModuleRW(module)` | `middleware/permissions.ts:115` | GET/HEAD/OPTIONS need `view`, POST/PUT/PATCH need `edit`, DELETE needs `manage`. |
| `resolvePermissions` hard backstop | `lib/permissions.ts:336-339` (and `resolveRolePermissions` :403-404) | For every non-owner, `finance` and `business` are forced to `none`, whatever the overrides, custom roles or role defaults say. Owners get `fullAccess()` (:316, and `loadPermissions` :53). Clients get `noAccess()`. |
| `requireRole('owner')` | `middleware/auth.ts:48` | Second backstop, applied **only** on `invoices`, `expenses`, `finance`, `refrens`. |
| `ctx.role === 'owner'` serializer flags | leads / proposals / agreements / crm / clients | Hide money fields for non-owners. **Today this is dead code** on the business routers, because only owners get past the gate. It becomes live, and load-bearing, once `business` can be granted. |
| `meetsLevel(perms.finance,'view')` serializer flags | `projects.ts:203-206`, `users.ts:341, 957` | Hide `contractValue` / `recurringPaise` / `hourlyRate` / `monthlySalaryPaise`. The backstop forces finance to `none`, so in practice this means owner only. |

Gate stacks:

- **Leads, proposals (authenticated), agreements (authenticated):** `requireAuth` + `requireModuleRW('business')`. There is **no** `requireRole`, so owner-only rests entirely on the `resolvePermissions` backstop.
- **Invoices, expenses, finance, refrens:** `requireAuth` + `requireModuleRW('finance')` + `requireRole('owner')`.
- **Public token routes** (`/proposals/public/*`, `/agreements/public/*`): no authentication at all. The token is looked up raw with `eq(table.token, token)`.
- **Intake:** shared-secret header `x-intake-key`. No user.

Legend for "Tenant filter?":

- **Y**: every query on the primary row is constrained by `agencyId`.
- **Y\***: the primary row is constrained, but secondary lookups, joins or referenced IDs are not (see Issues).
- **N/A-token**: the token is the only key.

---

## 1. Endpoint inventory (57 endpoints)

### 1.1 Leads — `leadsRouter` (`/api/v1/leads`), gate `requireAuth` + `requireModuleRW('business')` (leads.ts:22-24)

| # | Method | Path | Business operation | Current gate(s) | In-handler checks (line) | Tenant filter? | Object scoping | Public/token | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | GET | /api/v1/leads?bucket&stage&search | List leads (open/converted/bin/all), with owner name, converted-client name and follow-up rollups | auth + business:view | `isOwner` (192) → `budget` and `estimatedValue` nulled for non-owners (54, 57) | Y\*: leads filtered by agency (140); owner-name lookup `users` (172-176) and client-name lookup (180-184) **not** agency-filtered | None: every lead in the agency | – | Name lookups by unvalidated `ownerId` can leak a foreign tenant's user name. Unpaginated. | `leads.view`; `leads.view_value` for budget/estimatedValue | `all` \| `owned` (ownerId = me) | Scope `owned` filters `ownerId = actor` |
| 2 | GET | /api/v1/leads/stats | Stage-bucket counts for tab badges | auth + business:view | – | Y (220) | None | – | Counts ignore any future scope, so they leak totals when a user is scoped to `owned`. | `leads.view` | same as #1 (counts must respect scope) | – |
| 3 | GET | /api/v1/leads/follow-ups | Pending follow-ups across open leads | auth + business:view | – | Y (259) | None | – | Returns everyone's follow-ups. | `leads.view` | `all` \| `owned` \| `authored` | – |
| 4 | POST | /api/v1/leads | Manual lead create | auth + business:edit | `ctx.role==='owner'` for the response money (326) | Y for the insert; `ownerId` from body **not validated** as an agency user (301, 321) | – | – | A cross-tenant or nonexistent `ownerId` is accepted. Setting `ownerId` to someone else is really an assign. | `leads.create`; `leads.assign` when `ownerId ≠ self`; `leads.view_value` to set or see `estimatedValue` (or a separate `leads.edit_value`) | – | `ownerId` must be an active staff user in the agency; assigning to others needs `leads.assign` |
| 5 | GET | /api/v1/leads/:id | Lead detail + activity timeline | auth + business:view | `ctx.role==='owner'` (358) | Y\*: `getScopedLead` (87-95) scoped; owner/client name lookups (336, 339) unscoped; activities by leadId only (345) | None | – | Same name-leak issue as #1. | `leads.view` (+ `leads.view_value`) | `all` \| `owned` | Scoped read |
| 6 | PATCH | /api/v1/leads/:id | Edit fields, move stage, reassign owner | auth + business:edit | `ctx.role==='owner'` for the response (418); writes a `stage_change` activity (406-415) | Y\*: row scoped; `ownerId` not validated (376, 395) | None | – | Can set stage `converted` without creating a client, which leaves an inconsistent state. A non-owner could blind-write `estimatedValue`/`budget` once business is grantable. Reassigning is not separated from editing. No audit log. | `leads.update`; `leads.assign` (ownerId change); `leads.edit_value` (budget/estimatedValue) | `all` \| `owned` | Stage `converted` only through #7; `ownerId` must be an agency staff user |
| 7 | POST | /api/v1/leads/:id/convert | Convert lead → new client + primary contact + note; lead becomes `converted` | auth + business:edit | Idempotent if already converted (435-437) | Y (insert uses ctx.agencyId) | None | – | **Creates a client with no `clients` module check.** `ownerId` is carried over unvalidated (441). Copies `budget` into client `internalNotes` (445, 459), which leaks the value to anyone with `clients:view`. No audit log. | `leads.convert` **and** `clients.create` | `all` \| `owned` | Lead must not be `lost`/`spam`; budget must not be copied into notes unless the actor has `leads.view_value` |
| 8 | DELETE | /api/v1/leads/:id | Permanently delete lead (cascades activities) | auth + business:manage | – | Y | None | – | Hard delete of a converted lead loses its history. No audit log. | `leads.delete` | `all` \| `owned` | Block delete when `convertedClientId` is set, or soft-delete |
| 9 | POST | /api/v1/leads/:id/activities | Add note/call/meeting/email/follow-up | auth + business:edit | – | Y (lead scoped) | None | – | – | `leads.update` (or `leads.log_activity`) | `all` \| `owned` | – |
| 10 | PATCH | /api/v1/leads/:id/activities/:actId | Edit an activity / toggle follow-up done | auth + business:edit | Activity scoped to lead + agency (570-581) | Y | **No author check** | – | Anyone can rewrite anyone's notes. | `leads.update` | `all` \| `owned` | Edit body: author only, unless `leads.manage_activities`; toggling done is allowed for the lead owner |
| 11 | DELETE | /api/v1/leads/:id/activities/:actId | Delete an activity | auth + business:manage | – | Y (602-610) | No author check | – | Always returns `deleted:true`, even when nothing matched. `stage_change` system entries are deletable, so audit history can be erased. | `leads.delete` or `leads.manage_activities` | `all` \| `owned` | Author only; system `stage_change` rows are immutable |

### 1.2 Proposals — `proposalsRouter` (`/api/v1/proposals`)

Public routes (no auth) are at proposals.ts:39-177. `authRouter` (`requireAuth` + `requireModuleRW('business')`, :182-185) is mounted at :754.

| # | Method | Path | Business operation | Current gate(s) | In-handler checks (line) | Tenant filter? | Object scoping | Public/token | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 12 | GET | /api/v1/proposals/public/:token | Client views a proposal by link; marks `sent` → `viewed` | **none (public)** | – | N/A-token (44); client/lead name lookups (65, 68) not agency-filtered | Token → one proposal | Token is `pzt_` + 24 random bytes (ids.ts:9-13), stored **plaintext** in `proposals.token` (schema :2333, index :2357). **No expiry** (`validUntil` ignored), **no revocation**, works for **draft** proposals (token minted at create, 345). Exposes `serializeProposal(p, true)`: every money field, full `content`, `token`, `fileUrl`, `createdBy`, `acceptedBy`, `rejectionReason`, `clientId`, `leadId`, `convertedAgreementId`, plus agency name/logo/colour and client name. | A draft proposal is viewable if the token leaks (the token is also returned to staff). A cross-tenant `clientId`/`leadId` on the proposal leaks another tenant's name. Internal IDs are exposed. No per-route rate limit (global limiter only). | none (token capability) | – | Only `sent`/`viewed`/`accepted` statuses; enforce `validUntil`; support revoking or rotating the token; store a hash; minimal DTO |
| 13 | POST | /api/v1/proposals/public/:token/accept | Client accepts (types a name) | **none (public)** | Short-circuits if already `accepted`/`converted` (93-95) | N/A-token | Token | Same token; no expiry; `acceptedBy` is free text (80) | **Accepts a draft that was never sent, or a `rejected` or expired proposal.** No identity proof. Audit `actorId` is the free-text name. Notifies `agencyOwners` only (119), so a granted user is never notified. | none (token) | – | Only when status ∈ {sent, viewed} and `validUntil` has not passed; one-shot |
| 14 | POST | /api/v1/proposals/public/:token/reject | Client requests changes / declines | **none (public)** | **none** | N/A-token | Token | Same | **Can reject an already `accepted` or `converted` proposal**, so status regresses after an agreement exists. Repeatable (spam notifications to owners). | none (token) | – | Only when status ∈ {sent, viewed} |
| 15 | GET | /api/v1/proposals/templates | List proposal templates | auth + business:view | – | Y (240) | None | – | Template content may include pricing. | `proposals.view` (or `proposals.manage_templates` to list) | `all` | – |
| 16 | POST | /api/v1/proposals/templates | Create template | auth + business:edit | – | Y | – | – | There is no update or delete template endpoint. | `proposals.manage_templates` | – | – |
| 17 | GET | /api/v1/proposals?clientId&leadId | List proposals | auth + business:view | `isOwner` (291) nulls subtotal/tax/total/recurring (211-215) | Y\*: proposals filtered (295); joins to clients/leads/users (307-309) are id-only | None | – | `content` JSON (217) holds investment/pricing sections and **is returned even when the totals are nulled**, so money still leaks. `token` is returned to every viewer (218). | `proposals.view`; `proposals.view_pricing` (totals **and** pricing parts of content) | `all` \| `own` (createdBy) \| `client` (proposals for clients I can access) | – |
| 18 | POST | /api/v1/proposals | Create proposal (draft + token) | auth + business:edit | `ctx.role==='owner'` for the response (383) | Y\*: `clientId`/`leadId`/`templateId` **not validated** against the agency (327-329, 354-356) | – | Mints the public token (345) | Cross-tenant references. Number `PROP-YYYY-(Date.now()%10000)` (349) collides. A non-pricing user can set totals blind. | `proposals.create` (+ `proposals.edit_pricing` to set money) | – | `clientId`/`leadId`/`templateId` must belong to the agency; the actor must be able to access that client |
| 19 | GET | /api/v1/proposals/:id | Proposal detail | auth + business:view | `ctx.role==='owner'` (406) | Y (400) | None | – | Same content/token leakage as #17. | `proposals.view` (+ `view_pricing`) | `all` \| `own` \| `client` | – |
| 20 | POST | /api/v1/proposals/:id/send | Email the public link, or for document-mode (`fileUrl` + `clientId`) **mint or reset the client's portal login** and email credentials; status `draft`→`sent` | auth + business:edit | `requireClientAccess` in doc mode (437) | Y | None | Emails the token URL (429) | **`mintClientPortalLogin` (client-portal-login.ts:97-101) overwrites the client's existing portal login email with `recipientEmail`, resets the password and forces `status:'active'`**, so any sender can take over or lock out a client portal account, or re-enable a disabled one. `p.title` and `message` go unescaped into `bodyHtml` (461; `basicHtml` renders bodyHtml verbatim, email.ts:88), which is HTML injection in the outbound email. The recipient is arbitrary. | `proposals.send`; resetting a portal login should additionally need `clients.manage_portal_access` | `all` \| `own` \| `client` | Only `draft`/`sent`/`viewed`; the recipient should default to or be restricted to client contacts; never rewrite an existing login email implicitly |
| 21 | POST | /api/v1/proposals/:id/convert-to-agreement | Create a draft agreement from the proposal; proposal → `converted` | auth + business:edit | Requires `clientId` (504) | Y | None | Mints the agreement token (509) | **Not idempotent**: repeated calls create duplicate agreements. **No status check**: a draft or rejected proposal can be converted. Copies totals into the agreement. | `proposals.convert` **and** `agreements.create` | `all` \| `own` | Only from `accepted` (or allow `sent` with an override permission); refuse if `convertedAgreementId` is already set |
| 22 | POST | /api/v1/proposals/ai/generate | AI proposal draft from a prompt | auth + business:edit | – | n/a (no DB) | – | – | LLM cost with no dedicated limiter. | `proposals.create` (+ `ai.use`) | – | – |
| 23 | POST | /api/v1/proposals/ai/marketing | AI 10-section marketing proposal, optionally enriched from a client | auth + business:edit | Client lookup agency-scoped (635-641) | Y | – | – | LLM cost. | `proposals.create` (+ `ai.use`) | client scope for `clientId` | – |
| 24 | POST | /api/v1/proposals/ai/enhance | AI text rewrite | auth + business:edit | – | n/a | – | – | A generic LLM proxy behind the business gate. | `proposals.create` \| `proposals.update` (+ `ai.use`) | – | – |
| 25 | PUT | /api/v1/proposals/:id | Update fields, money, content, fileUrl; a `rejected` proposal goes back to `draft` | auth + business:edit | `ctx.role==='owner'` for the response (751) | Y\*: row scoped (706); new `clientId`/`leadId`/`templateId` not validated (716-718) | None | – | **No status guard: accepted or converted proposals can be edited after the client accepted** (terms tampering). `fileUrl` is any URL (695). Non-pricing users can overwrite money blind. There is no DELETE endpoint for proposals. | `proposals.update`; `proposals.edit_pricing` for money fields | `all` \| `own` | Immutable once `accepted`/`converted` (require a new revision); references must be same-agency |

### 1.3 Agreements — `agreementsRouter` (`/api/v1/agreements`)

Public routes are at agreements.ts:42-129. `authRouter` (`requireAuth` + `requireModuleRW('business')`, :134-137) is mounted at :564.

| # | Method | Path | Business operation | Current gate(s) | In-handler checks (line) | Tenant filter? | Object scoping | Public/token | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 26 | GET | /api/v1/agreements/public/:token | Client views an agreement for signing | **none (public)** | – | N/A-token (47); client lookup (58-62) by id only | Token | Plaintext `pzt_` token, **no expiry** (`expirationDate` ignored), **no revoke**, works on draft. Exposes `serializeAgreement(a, true)`: money, terms, token, **`signerName`, `signerEmail`, `signerIp`, `signatureDataUrl`**, fileUrl, projectId, proposalId, createdBy; plus the client's **`contactEmail` and `billingAddress`**. | Leaks signer PII and IP, and client billing address, to anyone holding the link (a forwarded email). Draft agreements are viewable. | none (token) | – | Only non-draft; redact signerIp/signature after signing; enforce expiry; revocable |
| 27 | POST | /api/v1/agreements/public/:token/sign | Client e-signs (name, email, signature data URL) | **none (public)** | Short-circuits if `signed`/`active` (88-90) | N/A-token | Token | Same | **Signs `draft`, `terminated` or `expired` agreements.** `signerEmail` is not verified against the client. `signatureDataUrl` is any string ≥10 chars with no MIME/size check (74), stored and re-served, a potential stored-XSS/`javascript:` vector if rendered as `src`. Notifies owners only. | none (token) | – | Only `sent`; validate a `data:image/png;base64` prefix and size; optional email OTP |
| 28 | GET | /api/v1/agreements/templates | List agreement templates | auth + business:view | – | Y (181) | None | – | – | `agreements.view` | `all` | – |
| 29 | POST | /api/v1/agreements/templates | Create template | auth + business:edit | – | Y | – | – | No update or delete template endpoint. | `agreements.manage_templates` | – | – |
| 30 | GET | /api/v1/agreements?clientId | List agreements | auth + business:view | `isOwner` (232) nulls retainer/total (155-156) | Y\*: joins id-only (245-246) | None | – | Returns the signer PII, signatureDataUrl and token to every viewer. `terms` may contain fee clauses. | `agreements.view`; `agreements.view_pricing` | `all` \| `own` \| `client` | – |
| 31 | POST | /api/v1/agreements | Create agreement (draft + token) | auth + business:edit | `ctx.role==='owner'` for the response (316) | Y\*: `clientId`, `proposalId`, `projectId`, `templateId` **not validated** (263-266, 288-291) | – | Mints the token (280) | Cross-tenant references (`clientId` is NOT NULL but unchecked). Number collisions (283). | `agreements.create` (+ `agreements.edit_pricing`) | – | References must be same-agency; actor must have access to the client |
| 32 | GET | /api/v1/agreements/:id | Agreement detail | auth + business:view | `ctx.role==='owner'` (337) | Y (331) | None | – | Same exposure as #30. | `agreements.view` (+ `view_pricing`) | `all` \| `own` \| `client` | – |
| 33 | POST | /api/v1/agreements/:id/send | Email the sign link, or in doc mode mint/reset the portal login; `draft`→`sent` | auth + business:edit | `requireClientAccess` in doc mode (367) | Y | None | Emails the token URL (359) | Same **portal-login hijack/reset** as #20. `a.title` and `body.message` are interpolated raw into hand-built HTML (391-394), which is HTML injection. No status check: a signed agreement can be re-sent. | `agreements.send` (+ `clients.manage_portal_access` for a login reset) | `all` \| `own` \| `client` | Only `draft`/`sent` |
| 34 | POST | /api/v1/agreements/ai/generate | AI agreement draft | auth + business:edit | – | n/a | – | – | LLM cost. | `agreements.create` (+ `ai.use`) | – | – |
| 35 | POST | /api/v1/agreements/ai/enhance | AI text rewrite | auth + business:edit | – | n/a | – | – | Duplicate of #24. | `agreements.create` \| `agreements.update` (+ `ai.use`) | – | – |
| 36 | PUT | /api/v1/agreements/:id | Update title, client, project, dates, money, terms | auth + business:edit | `ctx.role==='owner'` for the response (520) | Y\*: row scoped (487); new `clientId`/`projectId`/`templateId` not validated (497-499) | None | – | **No status guard: signed or active contracts can have terms, value and even client changed after signature**, and the signature record stays attached. There is no status transition to active/terminated/expired anywhere (`void`/terminate is missing). | `agreements.update`; `agreements.edit_pricing` | `all` \| `own` | Immutable once `signed`/`active`/`terminated`/`expired`; add a separate `agreements.void` (terminate) transition |
| 37 | DELETE | /api/v1/agreements/:id | Delete a draft or sent agreement | auth + business:manage | Only `draft`/`sent` (537-541); broadcasts a portal refresh | Y | None | – | Deleting a `sent` agreement invalidates a link the client already has (acceptable). Audited. | `agreements.delete` | `all` \| `own` | Only draft/sent (already enforced) |

### 1.4 Invoices — `invoicesRouter` (`/api/v1/invoices`), gate `requireAuth` + `requireModuleRW('finance')` + `requireRole('owner')` (invoices.ts:28-31)

| # | Method | Path | Business operation | Current gate(s) | In-handler checks (line) | Tenant filter? | Object scoping | Public/token | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 38 | GET | /api/v1/invoices?clientId&projectId&status&from&to&search&limit&offset | List invoices with paid/balance/overdue | auth + finance:view + owner | – | Y\*: invoices filtered (193); payment sums by invoiceId list (248) | None | – | `status` is cast without validation (197). Unpaginated by default. Exposes `bankDetails`. | `invoices.view` | `all` \| `client` (invoices of clients I can access) \| `project` | – |
| 39 | GET | /api/v1/invoices/summary?from&to | KPI tiles: invoiced, collected, outstanding, overdue | auth + finance:view + owner | – | Y (274, 297) | None | – | Payment sums are not range-filtered, which is inconsistent but not an authz problem. | `invoices.view` (or `finance.view_overview`) | `all` | – |
| 40 | POST | /api/v1/invoices | Create invoice + items (server-computed totals); optionally push to Refrens | auth + finance:edit + owner | – | Y\*: `clientId`/`projectId` **not validated** (346-347, 396-397) | – | – | Cross-tenant `clientId`: `pushInvoice` then loads the client **without an agency filter** (refrens-sync.ts:382-386) and sends that other tenant's client billing/GSTIN to Refrens. Number collisions (364). Items are inserted outside a transaction. `lib/finance.ts computeInvoiceTotals` is duplicated inline, and its CGST/SGST rounding differs (:388-389 vs lib :621-622). | `invoices.create` (+ `integrations.refrens.push` implicit when auto-push is on, which is a system action) | – | client/project must be same-agency; actor must have access to the client |
| 41 | GET | /api/v1/invoices/:id | Invoice detail + items + payments | auth + finance:view + owner | – | Y (453); items/payments by invoiceId (461, 467) | None | – | – | `invoices.view` | `all` \| `client` \| `project` | – |
| 42 | POST | /api/v1/invoices/:id/payments | Record a payment; auto status paid/partially_paid | auth + finance:edit + owner | – | Y | None | – | **No guard against payments on `cancelled` or `draft` invoices, and no overpayment guard.** `paidAt` can be backdated or future-dated. There is **no endpoint to void or delete a payment** (`lib/finance.ts statusAfterPayment` exists but is unused). No transaction. | `invoices.record_payment` | `all` \| `client` | Invoice status ∈ {sent, partially_paid}; amount ≤ balance unless `invoices.record_overpayment`; segregation: the recorder should not be the invoice creator (optional, configurable) |
| 43 | PATCH | /api/v1/invoices/:id | Full edit (client, project, dates, notes, terms, bankDetails, items → recompute); push to Refrens | auth + finance:edit + owner | Blocks `cancelled` (573-575) | Y\*: new `clientId`/`projectId` not validated (578-579) | None | – | **Paid or partially-paid invoices can have their items and totals rewritten** after money came in. `bankDetails` is editable, a payment-redirection fraud vector. Cross-tenant client. No transaction on the item replace. | `invoices.update`; `invoices.edit_bank_details` (sensitive) | `all` \| `client` | Only `draft` (or `sent` with no payments); a paid invoice needs a credit note or void-and-reissue; bankDetails changes need their own permission and an audit entry |
| 44 | PATCH | /api/v1/invoices/:id/status | Set status to draft/sent/cancelled/paid; push to Refrens | auth + finance:edit + owner | – | Y (673, 680) | None | – | **Marks `paid` with no payment, un-cancels, cancels a paid invoice, or reverts sent→draft. No audit log.** | `invoices.update` for draft↔sent; `invoices.void` for cancel; `invoices.mark_paid` for paid | `all` \| `client` | Enforce a transition state machine; cancelling needs no payments (or a refund); `paid` only when balance = 0 (otherwise use record_payment) |
| 45 | POST | /api/v1/invoices/:id/send | Mint or **reset** the client portal login and email credentials plus the invoice amount; `draft`→`sent` | auth + finance:edit + owner | `requireClientAccess` (709) | Y | None | – | Same **portal-login email overwrite / password reset / re-activation** as #20 (713-719). The recipient is arbitrary. The amount appears in the email. Cancelled invoices can be sent. | `invoices.send` (+ `clients.manage_portal_access` for a login reset) | `all` \| `client` | Only draft/sent/partially_paid; recipient restricted to client contacts |

Endpoints that do not exist: invoice DELETE, payment edit/delete, export (CSV/PDF), credit note.

### 1.5 Expenses — `expensesRouter` (`/api/v1/expenses`), gate `requireAuth` + `requireModuleRW('finance')` + `requireRole('owner')` (expenses.ts:15-18)

| # | Method | Path | Business operation | Current gate(s) | In-handler checks (line) | Tenant filter? | Object scoping | Public/token | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 46 | GET | /api/v1/expenses?category&projectId&clientId&from&to&search | List expenses | auth + finance:view + owner | – | Y (127) | None | – | Category `salaries` rows reveal pay once the list is granted. | `expenses.view` | `all` \| `own` (loggedBy = me) \| `project` | Category `salaries` hidden unless `users.view_compensation` |
| 47 | POST | /api/v1/expenses | Log an expense | auth + finance:edit + owner | `requireAgencyProject`/`requireAgencyClient` (189-190) | Y | – | – | `receiptUrl` is any URL (180). No approval state exists. | `expenses.create` | – | `loggedBy` = actor; initial status `pending` if an approval flow is introduced |
| 48 | GET | /api/v1/expenses/:id | Expense detail | auth + finance:view + owner | `getScopedExpense` (93-109) | Y | None | – | – | `expenses.view` | `all` \| `own` | – |
| 49 | PATCH | /api/v1/expenses/:id | Edit expense | auth + finance:edit + owner | Scoped; project/client validated (258-259) | Y | None | – | No lock after approval (none exists). | `expenses.update` | `all` \| `own` | Own expenses editable only while unapproved; `expenses.update_any` for others |
| 50 | DELETE | /api/v1/expenses/:id | Delete expense | auth + finance:manage + owner | Scoped (302) | Y | None | – | Hard delete (audited). | `expenses.delete` | `all` \| `own` | Own and unapproved only, unless `expenses.delete_any` |

Missing: the approval workflow (`expenses.approve`). If introduced, the policy is that **an approver cannot approve an expense where `loggedBy = self`**.

### 1.6 Finance — `financeRouter` (`/api/v1/finance`), gate `requireAuth` + `requireModuleRW('finance')` + `requireRole('owner')` (finance.ts:21-24)

| # | Method | Path | Business operation | Current gate(s) | In-handler checks (line) | Tenant filter? | Object scoping | Public/token | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 51 | GET | /api/v1/finance/overview?from&to | FY expense total, "net profit" (= −expenses), expenses by category | auth + finance:view + owner | – | Y (61, 77) | None | – | – | `finance.view_overview` | `all` | – |
| 52 | GET | /api/v1/finance/clients/:clientId | One client's billed/paid/outstanding/expenses/deal pipeline value | auth + finance:view + owner | Client agency-scoped (107-112) | Y\*: payments by invoiceId list (132) | None | – | The comment says "owner/admin" (99-100) but the code is owner-only. It combines invoices, expenses and **deal value**. | `clients.view_financials` (or `finance.view_client_financials`) | `all` \| `client` (clients I can access) | – |
| 53 | GET | /api/v1/finance/owner-snapshot | Monthly revenue (projects), payroll, net, collected/billed/outstanding, recent invoices/expenses, **per-member salary roster** | auth + finance:view + owner | – | Y (186, 219, 237, 260, 319, 342) | None | – | Mixes three sensitivities in one payload: company P&L, receivables, and individual salaries (374-383). A grant would have to be all-or-nothing. | `finance.view_reports`; the `salaries[]` and `monthlyPayroll` fields additionally need `users.view_compensation` | `all` | Strip `salaries` (and payroll) unless `users.view_compensation` |

Endpoints that do not exist: finance export.

### 1.7 Refrens — `refrensRouter` (`/api/v1/refrens`), gate `requireAuth` + `requireModuleRW('finance')` + `requireRole('owner')` (refrens.ts:20-22)

| # | Method | Path | Business operation | Current gate(s) | In-handler checks (line) | Tenant filter? | Object scoping | Public/token | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 54 | GET | /api/v1/refrens/status | Configured/sync flags, mirrored/failed counts, last sync | auth + finance:view + owner | – | Y (refrens-sync.ts:480, 485) | – | – | Reveals global server config flags to any tenant owner (minor). | `integrations.refrens.view` (or `integrations.refrens.manage`) | `agency` | – |
| 55 | POST | /api/v1/refrens/sync | "Sync now": pull **all** Refrens invoices into the **caller's agency** | auth + finance:edit + owner | `refrensConfigured()` (37-39); audited | **N**: Refrens credentials are **server-global env** (`REFRENS_URL_KEY/APP_ID/PRIVATE_KEY`, env.ts:116-118), but data is written into `ctx.agencyId` (41) | – | – | **Cross-tenant data exfiltration**: any agency's owner (e.g. an agency made through signup) imports the configured business's full invoice ledger, creates its clients (with GSTIN, email, addresses) and payments inside their own tenant. `max` up to 5000 means a long synchronous request. | `integrations.refrens.manage` (sync) | must be pinned to the single agency that owns the credential | Only the agency bound to the Refrens credential (config `REFRENS_AGENCY_ID`) may sync |
| 56 | POST | /api/v1/refrens/invoices/:id/push | Push one invoice to Refrens (create/update) | auth + finance:edit + owner | Invoice agency-scoped (69-74); audited | Y\* (client lookup unscoped, refrens-sync.ts:385) | None | – | **Cross-tenant write**: any agency's invoices land in the one Refrens account. Same risk via auto-push on #40/#43/#44 when `REFRENS_AUTO_PUSH` is set. | `integrations.refrens.manage` (or `invoices.sync`) | bound agency only | Same agency binding as #55 |

### 1.8 Intake — `intakeRouter` (`/api/v1/intake`)

| # | Method | Path | Business operation | Current gate(s) | In-handler checks (line) | Tenant filter? | Object scoping | Public/token | Issues | Proposed permission key(s) | Proposed scope(s) | Proposed object policy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 57 | POST | /api/v1/intake/lead | Website contact form → new lead (stage `new`, owner = first owner user), notify owners | Shared secret `x-intake-key === LEAD_INTAKE_SECRET` (31-34) | Fails closed if the secret is unset; agency from `INTAKE_AGENCY_ID` env (34-37) | Y (fixed env agency) | – | Machine credential: static shared secret, compared with `!==` (not constant-time), no rotation or expiry, no per-route rate limit (global only) | Single-tenant by env. `ownerId` = an arbitrary owner (`limit 1`, :40-44). Notifies `agencyOwners` only (69), so granted lead managers get nothing. `budget` string stored. | none (system actor `integration:website-intake`); treat as `leads.create` by a service principal | fixed agency | Constant-time compare; per-integration key stored hashed per agency; route notifications to holders of `leads.view` (or an assignment rule) |

**Endpoint count: 57** (leads 11, proposals 14, agreements 12, invoices 8, expenses 5, finance 3, refrens 3, intake 1).

---

## 2. Money exposed outside the Finance/Business routers

Each row gives the file:line, what is exposed or written, the current gate, and the proposed permission.

### 2.1 Reads (fields that show money)

| File:line | Endpoint | Money field(s) | What gates it today | Gap | Proposed permission |
|---|---|---|---|---|---|
| crm.ts:411-419, 455-456 | GET /api/v1/crm/deals | `valuePaise` | `requireModuleRW('clients')` (crm.ts:28) + `ctx.role==='owner'` flag | Role-hardcoded | `deals.view_value` |
| crm.ts:462, 475 | GET /api/v1/crm/clients/:clientId/deals | `valuePaise` | same | same | `deals.view_value` |
| crm.ts:531 (loadDeal 538-547) | POST /api/v1/crm/clients/:clientId/deals (response) | `valuePaise` | same (owner flag) | – | `deals.view_value` |
| crm.ts:591 | PATCH /api/v1/crm/deals/:id (response) | `valuePaise` | same | – | `deals.view_value` |
| clients.ts:340-349 | GET /api/v1/clients/:clientId | `invoiceCount`, `outstanding` (paise) | `requireModuleRW('clients')` + `ctx.role==='owner'` | For non-owners `invoiceCount` returns `0` instead of `null` (misleading) | `clients.view_financials` |
| clients.ts serializeClient (~:67-72) | GET /api/v1/clients, /:clientId | `gstNumber`, `billingAddress/State/City/Pincode` (billing identity, not amounts) | clients:view only | Billing identity visible to every clients viewer | optionally `clients.view_billing` |
| projects.ts:295-310, 731-732 | GET /api/v1/projects | `contractValue`, `recurringPaise` (billingType is visible) | custom projects gate + `canSeeProjectFinance` = finance:view (203-206), so owner-only via the backstop | Default param `showFinance = true` (295) is fail-open for future call sites | `projects.view_financials` |
| projects.ts:959, 965, 1036 | POST /projects, GET /projects/:id, PATCH /projects/:id (responses) | same | same | same | `projects.view_financials` |
| users.ts:161, 176-177, 341-353 | GET /api/v1/team | `hourlyRate`, `monthlySalaryPaise` | team:view + finance:view flag | `profileFields` default `showFinance = true` (161) is fail-open | `users.view_compensation` |
| users.ts:957-964 | GET /api/v1/team/:userId | same | same | Self-view: a user cannot see their own salary either | `users.view_compensation` (scope `self` \| `all`) |
| users.ts:760-772 (profileFields called without a flag) | POST /api/v1/team/invite (response) | echoes `hourlyRate`, `monthlySalaryPaise` | owner/admin | Echo of input, so low risk, but it uses the fail-open default | `users.view_compensation` |
| finance.ts:223-240, 374-383 | GET /finance/owner-snapshot | salary roster, payroll | owner | see #53 | `users.view_compensation` |
| finance.ts:144-150 | GET /finance/clients/:clientId | `dealPipelineValue` | owner | – | `deals.view_value` + `clients.view_financials` |
| leads.ts:445, 459 | POST /leads/:id/convert | copies lead `budget` into client `internalNotes` | business:edit | Budget leaks to every `clients:view` user through notes | `leads.view_value` |
| proposals.ts:217 | GET /proposals, /proposals/:id | `content` JSON (investment/pricing sections) not redacted | business:view | Totals redacted but content isn't | `proposals.view_pricing` |
| agreements.ts:159 | GET /agreements, /agreements/:id | `terms` JSON (fee clauses) | business:view | same | `agreements.view_pricing` |
| client-portal.ts:985-987, 1024-1026 | GET /api/v1/client/proposals, /:id | subtotal/tax/total | `requireAuth` + `requireClientAuth`, `clientId = ctx.clientId`, `status ≠ draft` | Intended (client's own) | client principal (no staff perm) |
| client-portal.ts:1184-1185, 1223-1224 | GET /api/v1/client/agreements, /:id | retainer/totalValue | same | Intended | client principal |
| client-portal.ts:1309-1329, 1331, 1397 | GET /api/v1/client/invoices, /:id | all invoice money + bankDetails | same, `status ≠ draft` | Intended | client principal |

### 2.2 Writes (money set by users who cannot see it)

| File:line | Endpoint | Field written | Gate | Gap | Proposed permission |
|---|---|---|---|---|---|
| projects.ts:876-959 (schema ~841-843, insert 906-911) | POST /api/v1/projects | `contractValue`, `billingType`, `recurringPaise` | projects:manage (or owner/admin) | Managers can set contract value they cannot read | `projects.edit_financials` |
| projects.ts:986-1036 (1005-1009) | PATCH /api/v1/projects/:id | same | projects:edit + `getScopedProject` | same; members with projects:edit on their own project can change contract value | `projects.edit_financials` |
| users.ts:630 (schema 618-619, insert 706-707) | POST /api/v1/team/invite | `hourlyRate`, `monthlySalaryPaise` | owner/admin + team:edit | Admin sets pay without the finance permission | `users.edit_compensation` |
| users.ts:1046-1144 (1142-1144) | PATCH /api/v1/team/:userId | same | owner/admin + team:edit; **not** covered by `touchesPrivilege` (1066-1070), so an **admin can edit their own salary** | Self-compensation edit | `users.edit_compensation`, object policy: **never self** |
| crm.ts:493-507, 562-569 | POST /crm/clients/:clientId/deals, PATCH /crm/deals/:id | `valuePaise` | clients:edit | Blind overwrite of deal value by non-owners | `deals.edit_value` |
| leads.ts:305-324, 380-404 | POST/PATCH /leads | `budget`, `estimatedValue` | business:edit | – (owner-only today) | `leads.edit_value` |
| documents.ts:510-557, 573-640 | POST /api/v1/documents with `category ∈ {proposal, agreement, contract, nda, invoice}` | **Creates proposal/agreement/invoice rows** (status `sent` if `clientVisible`) | **documents:edit only** | **Bypasses business/finance gates entirely**: any documents editor spawns a `sent` invoice or agreement visible in the client portal. The invoice has total 0 and a colliding number; the proposal has **no token and no number**. | `documents.create` **plus** `proposals.create` / `agreements.create` / `invoices.create` for the conversion (plus `*.send` if clientVisible) |

### 2.3 Related client-portal state changes (not in my file set; flagged because they touch business objects)

- client-portal.ts:1038-1063 — `POST /client/proposals/:id/accept` has no status check. A client can accept a draft proposal (the list hides drafts, but accept by ID works) or a rejected one.
- client-portal.ts:1100-1126 — reject has no status check, so an accepted or converted proposal can regress.
- client-portal.ts:1244-1273 — `POST /client/agreements/:id/sign` has no status check. It re-signs an already-signed agreement, **overwriting the signature, signer and IP**, and it can sign drafts.

---

## 3. Scheduled / background jobs touching these modules

| Job | Where | Schedule | Actor | What it does | Authz notes |
|---|---|---|---|---|---|
| Refrens invoice pull | scheduler.ts:106-126 → `pullInvoices(agencyId)` (refrens-sync.ts:273) | `*/15 * * * *`, only if `REFRENS_SYNC_ENABLED` and credentials are set (refrens-sync.ts:464-466) | **System** (no user; no audit record written) | Lists every Refrens invoice. Upserts invoices, items (delete + reinsert) and payments (additive, deduped). **Auto-creates clients** from `billedTo`. Backfills client GSTIN/email/address. | `syncAgencyId()` (458-462) syncs only when **exactly one agency exists**; the comment mentions an "explicit env pin", but there is none. It silently skips on multi-tenant installs, while the manual `POST /refrens/sync` (#55) has no such guard. Refrens wins: it overwrites local edits made via #43/#44. Client matching by normalised **name** can merge distinct clients. No audit log for created clients, invoices or payments. |
| Refrens auto-push | invoices.ts:434-436, 641-643, 683-685 → `pushInvoice` | Inline on invoice create/edit/status, if `REFRENS_AUTO_PUSH` | Acting user (request context) | Creates or updates the Refrens document, adopts the Refrens invoice number, backfills `refrensClientId`. | Not tenant-bound (see #56). The client lookup is unscoped (refrens-sync.ts:385). Errors are swallowed into `refrens_sync_error`. |
| Refrens access token cache | refrens.ts:129-170 | on demand, 10-minute cache | System | ES256 self-signed JWT → Refrens access token (module-global cache) | A single global credential shared by all tenants |
| Monthly employee reports | scheduler.ts:62-65 (`emailEmployeeReports`) | `0 9 1 * *` | System | Emails work reports | No money fields found in the reports service (grep); out of scope |
| Intake webhook | intake.ts | on request | Integration principal (shared secret) | Creates a lead and notifies owners | see #57 |

Notifications: every business event notifies `agencyOwners()` (notifications.ts:112-124: `role = 'owner'` and active) at proposals.ts:119/164, agreements.ts:118, intake.ts:69 and client-portal.ts:1075+. Once these become grantable permissions, recipients should be resolved by permission (e.g. holders of `proposals.view`, scoped to the object), not by role.

---

## 4. Proposed permission catalogue (derived from the code)

Keys marked *(new endpoint)* have no current route; they are listed because the redesign needs a place for them. Everything else maps to at least one endpoint above.

**Leads**
- `leads.view` (#1, #2, #3, #5)
- `leads.view_value` (budget, estimatedValue)
- `leads.create` (#4)
- `leads.update` (#6, #9, #10)
- `leads.assign` (ownerId change in #4/#6)
- `leads.edit_value`
- `leads.convert` (#7, also requires `clients.create`)
- `leads.delete` (#8, #11)
- `leads.manage_activities` (edit/delete others' activities)
- Scopes: `all` | `owned`

**Proposals**
- `proposals.view` (#15, #17, #19)
- `proposals.view_pricing` (money + pricing content)
- `proposals.create` (#18, #22-24)
- `proposals.update` (#25)
- `proposals.edit_pricing`
- `proposals.send` (#20)
- `proposals.convert` (#21, also requires `agreements.create`)
- `proposals.manage_templates` (#16)
- `proposals.delete` *(new endpoint)*
- Scopes: `all` | `own` (createdBy) | `client`

**Agreements**
- `agreements.view` (#28, #30, #32)
- `agreements.view_pricing`
- `agreements.create` (#31, #34, #35)
- `agreements.update` (#36)
- `agreements.edit_pricing`
- `agreements.send` (#33)
- `agreements.delete` (#37)
- `agreements.manage_templates` (#29)
- `agreements.void` *(new: terminate)*
- Scopes: `all` | `own` | `client`

**Invoices**
- `invoices.view` (#38, #39, #41)
- `invoices.create` (#40)
- `invoices.update` (#43, #44 draft↔sent)
- `invoices.edit_bank_details` (#43 bankDetails)
- `invoices.void` (#44 → cancelled)
- `invoices.mark_paid` (#44 → paid)
- `invoices.record_payment` (#42)
- `invoices.send` (#45)
- `invoices.delete` *(new)*
- `invoices.export` *(new)*
- `invoices.sync` (#56; may alias `integrations.refrens.manage`)
- Scopes: `all` | `client` | `project`

**Expenses**
- `expenses.view` (#46, #48)
- `expenses.create` (#47)
- `expenses.update` (#49)
- `expenses.delete` (#50)
- `expenses.approve` *(new)*
- Scopes: `all` | `own` (loggedBy) | `project`
- Policy: cannot approve own

**Finance**
- `finance.view_overview` (#51)
- `finance.view_reports` (#53)
- `finance.export` *(new)*

**Integrations**
- `integrations.refrens.manage` (#54-#56); the sync must also be bound to the credential's agency

**Money fields outside finance**
- `projects.view_financials` / `projects.edit_financials`
- `users.view_compensation` / `users.edit_compensation` (scope `self` | `all`; policy: never edit own)
- `clients.view_financials` (#52, clients.ts:347-349)
- `deals.view_value` / `deals.edit_value`
- `clients.manage_portal_access` (required whenever a send resets or creates a client portal login)

**Non-user principals**
- Public token (proposal view/accept/reject; agreement view/sign): a capability bound to one object, with state guards, expiry and revocation
- Intake integration key (`leads.create` into a fixed agency)
- System scheduler (Refrens pull)

The Owner role gets all of the above by default. The `resolvePermissions` backstop (permissions.ts:336-339, 403-404) and the `requireRole('owner')` lines (invoices.ts:31, expenses.ts:18, finance.ts:24, refrens.ts:22) must be removed **at the same time** as every `ctx.role === 'owner'` serializer check is replaced. Otherwise granted users either see nothing or see everything. The serializer checks to replace:

- leads.ts:192, 326, 358, 418
- proposals.ts:291, 383, 406, 751
- agreements.ts:232, 316, 337, 520
- crm.ts:455, 462, 531, 591
- clients.ts:340
- projects.ts:203-206 and users.ts:341, 957 (both `finance:view`-based)

---

## 5. Issues (ranked)

1. **Cross-tenant Refrens sync.** The Refrens credentials are global env, but `POST /refrens/sync` writes into the caller's agency (refrens.ts:41; refrens-sync.ts:273). Any tenant owner can import another business's entire invoice ledger, clients (GSTIN/email/address) and payments. `pushInvoice` and auto-push (invoices.ts:434, 641, 683; refrens.ts:76) write every tenant's invoices into that one Refrens account.
2. **Send hijacks the client portal login.** The `send` endpoints for proposals (proposals.ts:437-453), agreements (agreements.ts:367-383) and invoices (invoices.ts:713-731) call `mintClientPortalLogin` with an arbitrary `recipientEmail`. That **overwrites the existing client login email, resets its password and re-activates a disabled login** (client-portal-login.ts:97-101). One mistyped or malicious send takes over or locks out a client account.
3. **Public tokens have no lifecycle.** Proposal and agreement tokens never expire, cannot be revoked, are stored in plaintext and work on drafts. Accept, reject and sign have no state machine:
   - reject regresses accepted or converted proposals (proposals.ts:132-151)
   - accept works on unsent, rejected or expired proposals (:83-105)
   - sign works on draft, terminated or expired agreements (agreements.ts:77-103)
   - the client-portal equivalents (client-portal.ts:1038, 1100, 1244) have no status checks at all, so an already-signed agreement can be re-signed and its signature overwritten
4. **The public agreement view leaks PII.** It exposes `signerIp`, `signerEmail`, `signatureDataUrl` and the client's `billingAddress`/`contactEmail` to anyone holding the link (agreements.ts:58-68, 160-166). `signatureDataUrl` is an unvalidated string (:74), stored and re-served.
5. **Documents bypass business/finance.** `POST /documents` with category invoice/proposal/agreement/contract/nda needs only `documents:edit`, yet creates Business/Finance records, with status `sent` and portal-visible when `clientVisible` (documents.ts:550-640).
6. **Executed records stay mutable.** `PUT /agreements/:id` rewrites terms, value and client of signed contracts (agreements.ts:479-507). `PUT /proposals/:id` edits accepted or converted proposals (proposals.ts:698-738). `PATCH /invoices/:id` rewrites items, totals and `bankDetails` on paid invoices (invoices.ts:562-638).
7. **Invoice money integrity.**
   - `PATCH /invoices/:id/status` sets `paid` with no payment, un-cancels, or cancels a paid invoice, and writes no audit log (invoices.ts:665-688).
   - Payments allow overpayment and cancelled or draft targets, and there is no payment void or delete (:491-543).
   - `convert-to-agreement` is not idempotent and ignores proposal status (proposals.ts:493-586).
8. **Cross-tenant references are never validated.**
   - `clientId`/`projectId` on invoices (invoices.ts:346-347, 578-579)
   - proposal `clientId`/`leadId`/`templateId` (proposals.ts:327-329, 716-718)
   - agreement `clientId`/`proposalId`/`projectId` (agreements.ts:263-266, 497-499)
   - lead `ownerId` (leads.ts:301, 376)

   Secondary lookups then leak the other tenant's names or billing data: proposals.ts:65/68/307, leads.ts:172/336, and refrens-sync.ts:385, which pushes that tenant's client billing data to Refrens.
9. **Money write-without-read and incomplete redaction.**
   - Managers set project `contractValue`/`recurringPaise` (projects.ts:1005-1009).
   - Admins set salaries, **including their own** (users.ts:1142-1144; not in `touchesPrivilege` at :1066).
   - `clients:edit` users overwrite deal `valuePaise` (crm.ts:569).
   - Proposal `content` and agreement `terms` JSON are returned unredacted while the totals are nulled (proposals.ts:217, agreements.ts:159).
   - Lead budget is copied into client notes on convert (leads.ts:445-459).
   - Serializer defaults `showFinance = true` fail open (projects.ts:295, users.ts:161).
10. **Owner-ness is hardcoded inconsistently.**
    - Leads, proposals and agreements rely **only** on the `resolvePermissions` backstop (no `requireRole`), while invoices, expenses, finance and refrens stack both.
    - Money redaction uses `ctx.role==='owner'` in 17 places, but `finance:view` in projects and users.
    - Business notifications go only to `role='owner'` (notifications.ts:112).
    - `owner-snapshot` bundles P&L, receivables and individual salaries into one response (finance.ts:354-386), so it cannot be split under grants.

Other findings (lower severity):

- **HTML injection in outbound email:** `p.title`/`message` in `bodyHtml` (proposals.ts:461) and the hand-built HTML (agreements.ts:391-394).
- **Lead convert creates a client without a `clients` permission check** (leads.ts:450).
- **Lead activities can be edited or deleted by non-authors**, including system `stage_change` entries (leads.ts:565-611). Lead create/update/convert/delete have no audit log.
- **Number generation `PREFIX-YYYY-(Date.now()%10000)` collides** (proposals.ts:349, agreements.ts:283, invoices.ts:364, documents.ts:612). Documents-created proposals have neither number nor token.
- **Intake shared secret is compared non-constant-time**, bound to a single agency via env, with no dedicated rate limit (intake.ts:31-37).
- **Scheduled Refrens pull:** writes no audit log, auto-creates clients by fuzzy name match, overwrites local invoice edits, and `syncAgencyId` only works when exactly one agency exists (refrens-sync.ts:458-462).
- **No deletes** for proposals, invoices, payments or templates, **no template update**, and **no export** endpoints for invoices or finance.
- **`lib/finance.ts` helpers are unused:** `computeInvoiceTotals`, `statusAfterPayment` and `deriveStatus` are not referenced by the routes, and the inline CGST/SGST split rounds differently (invoices.ts:388-389 vs lib/finance.ts:60-61).
- **Stale comments:** finance.ts:99-100 says "owner/admin" (code is owner-only), and the `employee` preset omits `business` (permissions.ts:500-513), which is harmless only because of the backstop.
