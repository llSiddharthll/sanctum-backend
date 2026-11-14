import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Actor } from '../authz/actor.js';
import { can, canAny } from '../authz/engine.js';
import { ApiCallError } from './api-client.js';
import type { SanctumTool, ToolContext } from './tool-kit.js';
import { ALL_TOOLS } from './tools/index.js';

const INSTRUCTIONS = `You are connected to Sanctum, an agency workspace (clients, leads, proposals,
agreements, projects, tasks, time tracking, invoices, expenses, attendance, leave, content calendar,
team, messages, documents). You act as the signed-in person and can only do what their Sanctum role
allows; the tool list already reflects that.

Conventions:
- Money: tool inputs ending in "Rupees" (amountRupees, rateRupees, contractValueRupees…) take rupees.
  Money in tool results is in PAISE (divide by 100 before showing it to the person).
- Dates: ISO (YYYY-MM-DD, or full ISO timestamps). Timezone is India (IST, +05:30) unless stated.
- Ids: always look things up first (list/search tools) instead of guessing ids.
- Before creating, updating or deleting anything, confirm the details with the person unless they
  already gave them explicitly. Prefer the smallest change that does the job.
- If a tool says "Not allowed", the person's role doesn't include that action. Tell them; don't retry.`;

/** Tools this actor may see (UX filter; the API still enforces every call). */
export function visibleTools(actor: Actor): SanctumTool[] {
  return ALL_TOOLS.filter(
    (t) =>
      (t.anyOf.length === 0 || canAny(actor, t.anyOf)) &&
      (t.allOf ?? []).every((p) => can(actor, p)),
  );
}

const MAX_TEXT = 60_000;

function render(out: unknown): string {
  if (out === undefined || out === null) return 'Done.';
  if (typeof out === 'string') return out;
  let text = JSON.stringify(out, null, 2);
  if (text.length > MAX_TEXT) {
    text = `${text.slice(0, MAX_TEXT)}\n… (truncated — narrow the request with filters or a smaller limit)`;
  }
  return text;
}

export function explainError(err: unknown): string {
  if (err instanceof ApiCallError) {
    const details = err.details ? `\nDetails: ${JSON.stringify(err.details)}` : '';
    switch (err.status) {
      case 400:
      case 422:
        return `Invalid input: ${err.message}${details}`;
      case 401:
        return 'Your Sanctum session has expired. Reconnect the Sanctum connector and try again.';
      case 403:
        return `Not allowed: ${err.message} Your Sanctum role doesn't permit this; ask an admin if you need it.`;
      case 404:
        return `Not found: ${err.message} (it doesn't exist, or you don't have access to it).`;
      case 409:
        return `Conflict: ${err.message}${details}`;
      case 429:
        return 'Rate limited by Sanctum. Wait a minute and try again.';
      default:
        return `Sanctum error (${err.status} ${err.code}): ${err.message}`;
    }
  }
  return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'sanctum', title: 'Sanctum', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of visibleTools(ctx.actor)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.kind === 'read',
          destructiveHint: tool.kind === 'delete',
          idempotentHint: tool.kind === 'read',
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const out = await tool.run(args ?? {}, ctx);
          return { content: [{ type: 'text' as const, text: render(out) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text' as const, text: explainError(err) }] };
        }
      },
    );
  }
  return server;
}
