/**
 * Contract for Sanctum MCP tools. Each module file under ./tools exports an
 * array of tools built with `defineTool`.
 *
 * Rules (see src/mcp/README.md):
 *  - A tool only calls the REST API through `ctx.api` (never the DB), so the
 *    API's own permission checks are the enforcement point.
 *  - `anyOf` lists the permission keys that make the tool worth showing; a user
 *    holding none of them never sees the tool. This is UX filtering only — the
 *    API still enforces scopes on every call.
 *  - Money inputs are rupees in fields named `<field>Rupees`; convert with `paise()`.
 *    API responses carry money in paise (1/100 rupee).
 *  - Dates are ISO strings (YYYY-MM-DD or full ISO timestamps).
 */
import { z } from 'zod';
import type { StaffActor } from '../authz/actor.js';
import type { ApiClient } from './api-client.js';

export type ToolKind = 'read' | 'write' | 'delete';

export interface ToolContext {
  api: ApiClient;
  actor: StaffActor;
}

export interface SanctumTool {
  name: string;
  title: string;
  description: string;
  anyOf: string[];
  allOf?: string[];
  kind: ToolKind;
  input: z.ZodRawShape;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodRawShape>(tool: {
  /** snake_case, module-prefixed: clients_list, invoices_create, tasks_update … */
  name: string;
  title: string;
  /** What it does, when to use it, and anything the model must know (units, ids). */
  description: string;
  /** Show the tool when the user holds at least one of these permissions. [] = every team member. */
  anyOf: string[];
  /** Routes that require several permissions: the user must hold all of these too. */
  allOf?: string[];
  kind: ToolKind;
  input: S;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}): SanctumTool {
  return tool as unknown as SanctumTool;
}

/** Rupees (as typed by a person) → paise (what the API stores). */
export function paise(rupees: number): number;
export function paise(rupees: number | undefined): number | undefined;
export function paise(rupees: number | null | undefined): number | null | undefined;
export function paise(rupees: number | null | undefined): number | null | undefined {
  if (rupees === undefined || rupees === null) return rupees;
  return Math.round(rupees * 100);
}

/** Encode an id for use in a URL path segment. */
export const seg = (id: string): string => encodeURIComponent(id);

/** Drop undefined keys so PATCH bodies only carry fields the user asked to change. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** Shared input fragments. */
export const id = (what: string) => z.string().min(1).describe(`${what} id`);
export const isoDate = (what: string) =>
  z.string().describe(`${what} (ISO date, e.g. 2026-11-30 or 2026-11-30T10:00:00+05:30)`);
export const limit = z.number().int().min(1).max(200).optional().describe('Max items to return');
