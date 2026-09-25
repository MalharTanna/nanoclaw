import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-tenant-purge';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-tenant-purge' };
});

const killContainer = vi.fn();
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  isContainerBusy: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: (...a: unknown[]) => killContainer(...a),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import { dispatch } from './cli/dispatch.js';
import './cli/resources/groups.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { createSession } from './db/sessions.js';
import { inboundDbPath, initSessionFolder } from './session-manager.js';
import { setOnecliRunnerForTesting } from './tenant-purge.js';

const now = () => new Date().toISOString();
const A = 'ag-alpha';
const B = 'ag-beta';
const P = 'whatsapp:911111111111@s.whatsapp.net'; // writes in both tenants' group chat
const Q = 'whatsapp:912222222222@s.whatsapp.net'; // only ever wrote to tenant A
const R = 'whatsapp:913333333333@s.whatsapp.net'; // member of both tenants
const S = 'whatsapp:914444444444@s.whatsapp.net'; // admin of tenant A only
const OWNER = 'whatsapp:919999999999@s.whatsapp.net';

function exec(sql: string, ...params: unknown[]): void {
  getDb()
    .prepare(sql)
    .run(...params);
}
function col(sql: string, ...params: unknown[]): string[] {
  return (
    getDb()
      .prepare(sql)
      .all(...params) as Array<{ v: string }>
  ).map((r) => r.v);
}

function mg(id: string, platformId: string): void {
  exec(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
     VALUES (?, 'whatsapp', ?, 'whatsapp', 'Some chat', 1, 'public', ?)`,
    id,
    platformId,
    now(),
  );
}
function wire(mgId: string, agId: string): void {
  exec(
    `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
     VALUES (?, ?, ?, 'mention', 'all', 'drop', 'shared', 0, ?)`,
    `mga-${mgId}-${agId}`,
    mgId,
    agId,
    now(),
  );
}
function user(id: string): void {
  exec(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'whatsapp', 'Name', ?)`, id, now());
}
/** A session for `ag` in chat `mgId` whose inbound.db holds one message from each sender JID. */
function sessionWithSenders(sid: string, ag: string, mgId: string, senders: string[]): void {
  createSession({
    id: sid,
    agent_group_id: ag,
    messaging_group_id: mgId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(ag, sid);
  const db = new Database(inboundDbPath(ag, sid));
  senders.forEach((jid, i) =>
    db
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', ?, 'completed', ?)`,
      )
      .run(`${sid}-m${i}`, (i + 1) * 2, now(), JSON.stringify({ text: 'hi', sender: jid, senderName: 'N' })),
  );
  db.close();
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
  killContainer.mockClear();
});

afterEach(() => {
  setOnecliRunnerForTesting(null);
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('groups delete --purge (shared number)', () => {
  beforeEach(() => {
    createAgentGroup({ id: A, name: 'Alpha', folder: 'alpha', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'Beta', folder: 'beta', agent_provider: null, created_at: now() });
    for (const u of [P, Q, R, S, OWNER]) user(u);

    mg('mg-a-only', '120363000000000001@g.us'); // chat only tenant A uses
    mg('mg-shared', '120363000000000002@g.us'); // chat wired to both tenants
    mg('mg-dm-q', '912222222222@s.whatsapp.net'); // Q's DM, wired to A
    wire('mg-a-only', A);
    wire('mg-shared', A);
    wire('mg-shared', B);
    wire('mg-dm-q', A);

    sessionWithSenders('sess-a1', A, 'mg-a-only', [P.slice(9), Q.slice(9)]);
    sessionWithSenders('sess-b1', B, 'mg-shared', [P.slice(9)]);

    exec(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
      R,
      A,
      now(),
    );
    exec(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
      R,
      B,
      now(),
    );
    exec(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)`,
      S,
      A,
      now(),
    );
    exec(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)`,
      OWNER,
      now(),
    );
    exec(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, 'whatsapp', 'mg-dm-q', ?)`,
      Q,
      now(),
    );
    exec(
      `INSERT INTO unregistered_senders (channel_type, platform_id, user_id, sender_name, reason, messaging_group_id, agent_group_id, message_count, first_seen, last_seen)
       VALUES ('whatsapp', '120363000000000001@g.us', NULL, 'N', 'x', 'mg-a-only', ?, 1, ?, ?),
              ('whatsapp', '120363000000000009@g.us', NULL, 'N', 'x', NULL, NULL, 1, ?, ?)`,
      A,
      now(),
      now(),
      now(),
      now(),
    );
    exec(
      `INSERT INTO agent_message_policies (from_agent_group_id, to_agent_group_id, approver, created_at) VALUES (?, ?, 'owner', ?)`,
      B,
      A,
      now(),
    );
  });

  it('removes only the chats and people no surviving tenant still needs', async () => {
    const calls: string[][] = [];
    setOnecliRunnerForTesting(async (args) => {
      calls.push(args);
      if (args[1] === 'list')
        return {
          code: 0,
          stdout: JSON.stringify({
            data: [
              { id: 'uuid-a', identifier: A },
              { id: 'uuid-b', identifier: B },
            ],
          }),
        };
      return { code: 0, stdout: '' };
    });

    const resp = await dispatch(
      { id: 'r1', command: 'groups-delete', args: { id: A, purge: true } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { purge: Record<string, unknown>; removed: Record<string, number> } }).data;
    expect(data.purge).toEqual({
      messaging_groups: 2,
      user_dms: 1,
      unregistered_senders: 1,
      users: 2,
      onecli_agent: 'deleted',
    });
    expect(data.removed.agent_message_policies).toBe(1);

    expect(col('SELECT id AS v FROM messaging_groups ORDER BY id')).toEqual(['mg-shared']);
    // P also writes in tenant B's chat, R is B's member, OWNER is global: all stay. Q and S go.
    expect(col('SELECT id AS v FROM users ORDER BY id')).toEqual([P, R, OWNER].sort());
    expect(col('SELECT platform_id AS v FROM unregistered_senders')).toEqual(['120363000000000009@g.us']);
    expect(col('SELECT user_id AS v FROM user_dms')).toEqual([]);
    expect(col('SELECT agent_group_id AS v FROM messaging_group_agents')).toEqual([B]);
    expect(killContainer).toHaveBeenCalledWith('sess-a1', 'tenant purge');
    expect(calls).toEqual([
      ['agents', 'list'],
      ['agents', 'delete', '--id', 'uuid-a'],
    ]);
  });

  it('reports an unavailable onecli without failing the purge', async () => {
    setOnecliRunnerForTesting(async () => ({ code: 127, stdout: '' }));
    const resp = await dispatch(
      { id: 'r2', command: 'groups-delete', args: { id: A, purge: true } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: { purge: { onecli_agent: string } } }).data.purge.onecli_agent).toBe(
      'unavailable',
    );
  });

  it('plain delete (no --purge) leaves chats and people alone', async () => {
    const resp = await dispatch({ id: 'r3', command: 'groups-delete', args: { id: A } }, { caller: 'host' });
    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: Record<string, unknown> }).data.purge).toBeUndefined();
    expect(col('SELECT id AS v FROM messaging_groups')).toHaveLength(3);
    expect(col('SELECT id AS v FROM users')).toHaveLength(5);
    expect(killContainer).not.toHaveBeenCalled();
  });
});
