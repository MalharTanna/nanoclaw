/**
 * Move one agent group (a Miroflow business's assistant) between installs on
 * the same host: the central-DB rows that belong to it, as JSON.
 *
 *   pnpm exec tsx scripts/agent-group-move.ts export <agent-group-id>   > rows.json   (run in the source install)
 *   pnpm exec tsx scripts/agent-group-move.ts import                     < rows.json   (run in the target install, stopped)
 *
 * Ids are kept, so sessions (conversations, scheduled reminders) carry on in
 * the target. Files (groups/<folder>, data/v2-sessions/<id>, quota, court) are
 * copied by the caller (the Miroflow node-agent). Import inserts only rows
 * that aren't there yet and only columns the target's schema has.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

export type Rows = Record<string, Record<string, unknown>[]>;

const q = (db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Record<string, unknown>[];

export function exportAgentGroup(db: Database.Database, agentGroupId: string): Rows {
  const agentGroups = q(db, 'SELECT * FROM agent_groups WHERE id = ?', agentGroupId);
  if (agentGroups.length === 0) throw new Error(`agent group ${agentGroupId} not found`);
  const wirings = q(db, 'SELECT * FROM messaging_group_agents WHERE agent_group_id = ?', agentGroupId);
  const sessions = q(db, 'SELECT * FROM sessions WHERE agent_group_id = ?', agentGroupId);
  const destinations = q(db, 'SELECT * FROM agent_destinations WHERE agent_group_id = ?', agentGroupId);
  const mgIds = new Set<string>([
    ...wirings.map((w) => String(w.messaging_group_id)),
    ...sessions.filter((s) => s.messaging_group_id).map((s) => String(s.messaging_group_id)),
    ...destinations.filter((d) => d.target_type === 'channel').map((d) => String(d.target_id)),
  ]);
  const messagingGroups = [...mgIds].flatMap((id) => q(db, 'SELECT * FROM messaging_groups WHERE id = ?', id));
  const roles = q(db, 'SELECT * FROM user_roles WHERE agent_group_id = ?', agentGroupId);
  const members = q(db, 'SELECT * FROM agent_group_members WHERE agent_group_id = ?', agentGroupId);
  const userIds = new Set<string>([...roles, ...members].map((r) => String(r.user_id)));
  const users = [...userIds].flatMap((id) => q(db, 'SELECT * FROM users WHERE id = ?', id));
  const userDms = q(db, 'SELECT * FROM user_dms').filter((d) => userIds.has(String(d.user_id)) && mgIds.has(String(d.messaging_group_id)));
  return {
    agent_groups: agentGroups,
    container_configs: q(db, 'SELECT * FROM container_configs WHERE agent_group_id = ?', agentGroupId),
    messaging_groups: messagingGroups,
    messaging_group_agents: wirings,
    sessions,
    users,
    user_roles: roles,
    agent_group_members: members,
    agent_destinations: destinations,
    user_dms: userDms,
  };
}

/** Parents before children, so foreign keys hold. */
const ORDER = ['agent_groups', 'container_configs', 'messaging_groups', 'users', 'messaging_group_agents', 'sessions', 'user_roles', 'agent_group_members', 'agent_destinations', 'user_dms'];

export function importAgentGroup(db: Database.Database, rows: Rows): Record<string, number> {
  const counts: Record<string, number> = {};
  db.transaction(() => {
    for (const table of ORDER) {
      const list = rows[table] ?? [];
      const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      let n = 0;
      for (const row of list) {
        const keys = Object.keys(row).filter((k) => cols.has(k));
        if (keys.length === 0) continue;
        const r = db.prepare(`INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
        n += r.changes;
      }
      counts[table] = n;
    }
  })();
  return counts;
}

function main(): void {
  const [, , cmd, arg] = process.argv;
  const dbPath = path.join(process.cwd(), 'data', 'v2.db');
  if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const db = new Database(dbPath);
  try {
    if (cmd === 'export' && arg) {
      process.stdout.write(JSON.stringify(exportAgentGroup(db, arg)));
    } else if (cmd === 'import') {
      const rows = JSON.parse(fs.readFileSync(0, 'utf8')) as Rows;
      process.stdout.write(JSON.stringify(importAgentGroup(db, rows)) + '\n');
    } else {
      console.error('usage: agent-group-move.ts export <agent-group-id> | import < rows.json');
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && /agent-group-move\.ts$/.test(process.argv[1])) main();
