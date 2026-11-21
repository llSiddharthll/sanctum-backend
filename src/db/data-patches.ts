/**
 * Run-once data patches applied at start-up (recorded in sanctum_data_patches).
 * For small, additive fixes that must reach existing databases without a
 * manual step: new defaults on existing system roles, new tables
 * (CREATE TABLE IF NOT EXISTS — schema migrations later stay no-ops).
 * Each patch runs in one transaction; a failure aborts start-up.
 */
import type { Client, InStatement } from '@libsql/client';

interface DataPatch {
  key: string;
  statements: InStatement[];
}

export const DATA_PATCHES: DataPatch[] = [
  {
    // Employees add tasks to any project they can see (not only ones they're
    // a member of). New agencies get this from the role definition.
    key: '2026-11-22-employee-create-tasks-any-project',
    statements: [
      `INSERT OR IGNORE INTO sanctum_role_permissions (role_id, permission, scope)
       SELECT id, 'tasks.create', 'organization' FROM sanctum_roles
       WHERE kind = 'system' AND key = 'employee'`,
      `UPDATE sanctum_users SET authz_version = authz_version + 1
       WHERE id IN (SELECT ur.user_id FROM sanctum_user_roles ur
                    JOIN sanctum_roles r ON r.id = ur.role_id
                    WHERE r.kind = 'system' AND r.key = 'employee')`,
    ],
  },
  {
    // Private "My to-dos" list per team member.
    key: '2026-11-22-personal-todos',
    statements: [
      `CREATE TABLE IF NOT EXISTS sanctum_personal_todos (
        id text PRIMARY KEY NOT NULL,
        agency_id text NOT NULL REFERENCES sanctum_agencies(id) ON DELETE cascade,
        user_id text NOT NULL REFERENCES sanctum_users(id) ON DELETE cascade,
        title text NOT NULL,
        notes text,
        due_day text,
        done integer DEFAULT 0 NOT NULL,
        done_at integer,
        sort_order integer DEFAULT 0 NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ix_personal_todos_user ON sanctum_personal_todos (agency_id, user_id, done)`,
    ],
  },
];

export async function applyDataPatches(client: Client, log: (m: string) => void = () => {}): Promise<string[]> {
  await client.execute(
    'CREATE TABLE IF NOT EXISTS sanctum_data_patches (key TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)',
  );
  const done = new Set((await client.execute('SELECT key FROM sanctum_data_patches')).rows.map((r) => String(r.key)));
  const applied: string[] = [];
  for (const patch of DATA_PATCHES) {
    if (done.has(patch.key)) continue;
    try {
      await client.batch(
        [
          ...patch.statements,
          { sql: 'INSERT INTO sanctum_data_patches (key, applied_at) VALUES (?, ?)', args: [patch.key, Math.floor(Date.now() / 1000)] },
        ],
        'write',
      );
    } catch (err) {
      throw new Error(`Data patch ${patch.key} failed and was rolled back: ${(err as Error).message}`);
    }
    applied.push(patch.key);
    log(`[data-patch] applied ${patch.key}`);
  }
  return applied;
}
