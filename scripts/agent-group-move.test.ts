import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../src/db/migrations/index.js';
import { exportAgentGroup, importAgentGroup } from './agent-group-move.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const now = '2026-10-19T08:00:00.000Z';

function seed(db: Database.Database) {
  const run = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);
  run("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-t', 'Miro', 'tanna-s', ?)", now);
  run("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-o', 'Miro', 'other', ?)", now);
  run("INSERT INTO container_configs (agent_group_id, assistant_name, updated_at) VALUES ('ag-t', 'Miro', ?)", now);
  run("INSERT INTO messaging_groups (id, channel_type, platform_id, instance, is_group, unknown_sender_policy, created_at) VALUES ('mg-g', 'whatsapp', '120363000000000001@g.us', 'whatsapp', 1, 'public', ?)", now);
  run("INSERT INTO messaging_groups (id, channel_type, platform_id, instance, is_group, unknown_sender_policy, created_at) VALUES ('mg-d', 'whatsapp', '918128284813@s.whatsapp.net', 'whatsapp', 0, 'strict', ?)", now);
  run("INSERT INTO messaging_groups (id, channel_type, platform_id, instance, is_group, unknown_sender_policy, created_at) VALUES ('mg-x', 'whatsapp', '120363000000000009@g.us', 'whatsapp', 1, 'public', ?)", now);
  run("INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at) VALUES ('w1', 'mg-g', 'ag-t', ?)", now);
  run("INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at) VALUES ('w2', 'mg-x', 'ag-o', ?)", now);
  run("INSERT INTO sessions (id, agent_group_id, messaging_group_id, status, created_at) VALUES ('s1', 'ag-t', 'mg-d', 'active', ?)", now);
  run("INSERT INTO sessions (id, agent_group_id, messaging_group_id, status, created_at) VALUES ('s2', 'ag-t', NULL, 'active', ?)", now);
  run("INSERT INTO users (id, kind, created_at) VALUES ('whatsapp:918128284813@s.whatsapp.net', 'whatsapp', ?)", now);
  run("INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES ('whatsapp:918128284813@s.whatsapp.net', 'admin', 'ag-t', ?)", now);
}

describe('agent-group-move: one business assistant to another install', () => {
  it('exports only that assistant\'s rows and imports them with the same ids', () => {
    const src = freshDb();
    seed(src);
    const rows = exportAgentGroup(src, 'ag-t');
    expect(rows.agent_groups!.map((r) => r.id)).toEqual(['ag-t']);
    expect(rows.messaging_groups!.map((r) => r.id).sort()).toEqual(['mg-d', 'mg-g']); // not the other business's group
    expect(rows.sessions!.map((r) => r.id).sort()).toEqual(['s1', 's2']);
    expect(rows.users!).toHaveLength(1);

    const dst = freshDb();
    const counts = importAgentGroup(dst, JSON.parse(JSON.stringify(rows)));
    expect(counts).toMatchObject({ agent_groups: 1, container_configs: 1, messaging_groups: 2, messaging_group_agents: 1, sessions: 2, users: 1, user_roles: 1 });
    expect(dst.prepare("SELECT folder FROM agent_groups WHERE id = 'ag-t'").get()).toEqual({ folder: 'tanna-s' });
    // Importing again changes nothing.
    expect(Object.values(importAgentGroup(dst, rows)).every((n) => n === 0)).toBe(true);
    expect(() => exportAgentGroup(src, 'ag-missing')).toThrow('not found');
  });
});
