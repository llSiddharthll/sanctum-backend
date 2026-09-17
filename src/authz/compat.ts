/**
 * Transitional compatibility for clients that still read the legacy
 * `/auth/me` fields (`permissions` module map, `role`, `persona`) — i.e. Flutter
 * APKs already installed on phones. Derived FROM the new grants, never the
 * other way round. Removed in phase 10 (docs/authorization/README.md §J).
 */
import type { Actor } from './actor.js';
import { can } from './engine.js';
import type { LegacyLevel, LegacyModule } from './catalog.js';

const INDICATORS: Record<LegacyModule, [view: string, edit: string, manage: string]> = {
  dashboard: ['reports.view_dashboard', 'reports.view_dashboard', 'reports.view_dashboard'],
  clients: ['clients.view', 'clients.update', 'clients.archive'],
  projects: ['projects.view', 'projects.update', 'projects.delete'],
  team: ['users.view', 'users.update', 'users.delete'],
  attendance: ['attendance.view', 'attendance.check_in', 'attendance.view_live'],
  calendar: ['posts.view', 'posts.create', 'posts.delete'],
  messages: ['messages.view', 'messages.send', 'messages.delete'],
  documents: ['documents.view', 'documents.upload', 'documents.delete'],
  sheets: ['sheets.view', 'sheets.create', 'sheets.delete'],
  ai: ['ai.use_assistant', 'ai.use_assistant', 'ai.use_assistant'],
  finance: ['invoices.view', 'invoices.create', 'expenses.delete'],
  business: ['leads.view', 'leads.create', 'leads.delete'],
  settings: ['roles.view', 'organization.update', 'roles.archive'],
};

export function legacyPermissionMap(actor: Actor): Record<LegacyModule, LegacyLevel> {
  const out = {} as Record<LegacyModule, LegacyLevel>;
  for (const [m, [v, e, mg]] of Object.entries(INDICATORS) as Array<
    [LegacyModule, [string, string, string]]
  >) {
    if (actor.type !== 'staff') out[m] = 'none';
    else if (can(actor, mg)) out[m] = 'manage';
    else if (can(actor, e)) out[m] = 'edit';
    else if (can(actor, v)) out[m] = 'view';
    else out[m] = 'none';
  }
  return out;
}

export function legacyPersona(
  actor: Actor,
  legacyRole: string,
): 'owner' | 'admin' | 'manager' | 'employee' | 'client' {
  if (actor.type !== 'staff') return 'client';
  if (legacyRole === 'owner') return 'owner';
  if (legacyRole === 'admin') return 'admin';
  return can(actor, 'projects.delete') ? 'manager' : 'employee';
}
