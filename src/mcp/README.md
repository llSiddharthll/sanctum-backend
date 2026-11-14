# src/mcp — Sanctum MCP server (AI assistants)

Lets a team member use Sanctum from Claude, ChatGPT or Gemini CLI. The AI acts
**as that person** and can only do what their Sanctum role allows.

## How it fits together

| File | Role |
| --- | --- |
| `router.ts` | HTTP wiring: OAuth endpoints (`/.well-known/*`, `/authorize`, `/token`, `/register`, `/revoke`), `POST /mcp`, and the consent API `/api/v1/mcp-connect/*`. |
| `oauth.ts` | OAuth 2.1 provider. Client registrations and codes are sealed (encrypted) tokens — no tables. Access/refresh tokens are ordinary Sanctum sessions (`createSession` / `rotateRefresh`), labelled `AI connector · <app>`. |
| `server.ts` | Builds a per-request `McpServer` with only the tools the user's permissions make relevant; formats results and errors. |
| `api-client.ts` | `ctx.api` — calls the REST API over loopback with the user's own bearer token. |
| `tool-kit.ts` | `defineTool` contract + helpers (`paise`, `seg`, `compact`, `id`, `isoDate`, `limit`). |
| `tools/*.ts` | Tool definitions, one file per module group. |

Connect flow: AI app → `/authorize` → web app `/connect?request=…` (user signs in and clicks
Allow) → one-time code → `/token` → access + refresh token → `POST /mcp` with `Authorization: Bearer`.

## Security model (do not break)

1. **Tools never touch the DB.** They call the REST API through `ctx.api`, so the API's
   `requires(...)`, `authorize(...)`, scope filters (own / assigned / project / all), sensitive
   field redaction and audit logging apply unchanged. RBAC is enforced by the API, not by tools.
2. `anyOf` only hides tools the user could never use (UX). It is **not** the security check.
   Use the same permission keys the route declares in `requires(...)` / `requiresAny(...)`.
3. Out of scope for tools: changing roles/grants/permissions, auth/password/session routes,
   portal-link or share-token management, OAuth/social account connection, push subscriptions,
   binary file uploads, Refrens sync, AI content generation endpoints (cost), client-portal routes
   (`/client`, `/portal` — MCP is staff-only for now).

## Writing a tool

```ts
import { z } from 'zod';
import { defineTool, paise, seg, compact, id, isoDate, limit, type SanctumTool } from '../tool-kit.js';

export const crmTools: SanctumTool[] = [
  defineTool({
    name: 'clients_update',                 // <module>_<verb>, snake_case, unique
    title: 'Update a client',
    description: 'Change a client\'s details. Only the fields you pass are changed. Find the id with clients_list.',
    anyOf: ['clients.update'],              // permission key(s) from the route's requires(...)
    kind: 'write',                          // 'read' | 'write' | 'delete' (delete = irreversible)
    input: {
      clientId: id('Client'),
      name: z.string().min(1).optional(),
      retainerRupees: z.number().nonnegative().optional().describe('Monthly retainer in rupees'),
    },
    run: ({ clientId, name, retainerRupees }, { api }) =>
      api.patch(`/clients/${seg(clientId)}`, compact({ name, retainerPaise: paise(retainerRupees) })),
  }),
];
```

Conventions:
- **Mirror the API's field names** (camelCase) for inputs, so mapping is trivial. Use the route's
  zod schema as the source of truth for required/optional fields and enums (`z.enum([...])`).
- **Money:** if the API field is in paise, the tool input is `<name>Rupees` (rupees, number) and the
  tool converts with `paise()`. Check the route/schema to know whether a field is paise.
  Results stay as the API returns them (paise) — the server instructions tell the model.
- **Dates:** ISO strings, described with `isoDate(...)`.
- **Descriptions** say what the tool does, which other tool provides the ids it needs, and any
  important side effects (e.g. "sends an email to the client").
- **List tools** expose the API's real filters (status, search `q`, clientId, date range, paging)
  and map results to lean summaries (id + the fields a person would scan) to save tokens. Provide
  a `*_get` tool for full details.
- **PATCH tools** send only provided fields (`compact`).
- **Deletes** use `kind: 'delete'` and say "Permanently deletes …" (or "Archives …" if reversible —
  then use `kind: 'write'`).
- `api.get/post/patch/put/delete` return the envelope's `data` (or `{ items, ...extras }` when the
  response also carries pagination keys). Paths are relative to `/api/v1`.
