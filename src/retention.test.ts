import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = '/tmp/nanoclaw-test-retention';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-retention/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-retention/groups',
    STORE_DIR: '/tmp/nanoclaw-test-retention/store',
    LOGS_DIR: '/tmp/nanoclaw-test-retention/logs',
  };
});

const busy = new Set<string>();
vi.mock('./container-runner.js', () => ({
  isContainerBusy: (id: string) => busy.has(id),
  isContainerRunning: (id: string) => busy.has(id),
  wakeContainer: vi.fn(),
  killContainer: vi.fn(),
}));

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { createMessagingGroup } from './db/messaging-groups.js';
import { createSession, getSession } from './db/sessions.js';
import { runRetentionSweep } from './retention.js';
import {
  inboundDbPath,
  initSessionFolder,
  outboundDbPath,
  resolveSession,
  sessionDir,
  writeSessionMessage,
} from './session-manager.js';
import type { Session } from './types.js';

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const OLD = iso(NOW - 400 * DAY);
const RECENT = iso(NOW - 2 * DAY);
const AG = 'ag-shop';
const OFF = { messageDays: 0, rotatedTranscriptDays: 0, webSessionDays: 0, waSentDays: 0, logDays: 0, now: NOW };

function session(id: string, over: Partial<Session> = {}): Session {
  const s: Session = {
    id,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: RECENT,
    ...over,
  };
  createSession(s);
  initSessionFolder(AG, id);
  return s;
}

function addIn(
  sid: string,
  row: { id: string; seq: number; ts: string; status?: string; kind?: string; trigger?: number; recurrence?: string },
): void {
  const db = new Database(inboundDbPath(AG, sid));
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, recurrence, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{"text":"hi","sender":"91999@s.whatsapp.net"}')`,
  ).run(
    row.id,
    row.seq,
    row.kind ?? 'chat',
    row.ts,
    row.status ?? 'completed',
    row.trigger ?? 1,
    row.recurrence ?? null,
  );
  db.close();
}

function addOut(sid: string, id: string, seq: number, ts: string, delivered: boolean): void {
  const out = new Database(outboundDbPath(AG, sid));
  out
    .prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, ?, 'chat', '{"text":"reply"}')`,
    )
    .run(id, seq, ts);
  out.close();
  if (delivered) {
    const inb = new Database(inboundDbPath(AG, sid));
    inb.prepare(`INSERT INTO delivered (message_out_id, status, delivered_at) VALUES (?, 'delivered', ?)`).run(id, ts);
    inb.close();
  }
}

function ids(file: string, table: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    return (
      db.prepare(`SELECT ${table === 'delivered' ? 'message_out_id' : 'id'} AS id FROM ${table}`).all() as Array<{
        id: string;
      }>
    )
      .map((r) => r.id)
      .sort();
  } finally {
    db.close();
  }
}

function touchOld(p: string, ms = NOW - 400 * DAY): void {
  fs.utimesSync(p, ms / 1000, ms / 1000);
}

function writeFile(p: string, body = 'x', ageMs?: number): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (ageMs !== undefined) touchOld(p, NOW - ageMs);
  return p;
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  busy.clear();
  runMigrations(initTestDb());
  createAgentGroup({ id: AG, name: 'Shop', folder: 'shop', agent_provider: null, created_at: RECENT });
});

afterEach(() => {
  closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('message retention', () => {
  function seed(): void {
    session('sess-1');
    addIn('sess-1', { id: 'old-done', seq: 2, ts: OLD });
    addIn('sess-1', { id: 'old-context', seq: 4, ts: OLD, status: 'pending', trigger: 0 });
    addIn('sess-1', { id: 'old-task', seq: 6, ts: OLD, status: 'pending', kind: 'task' });
    addIn('sess-1', { id: 'old-paused', seq: 8, ts: OLD, status: 'paused', kind: 'task' });
    addIn('sess-1', { id: 'old-recurring', seq: 10, ts: OLD, kind: 'task', recurrence: '0 9 * * *' });
    addIn('sess-1', { id: 'old-due', seq: 12, ts: OLD, status: 'pending', trigger: 1 });
    addIn('sess-1', { id: 'new-done', seq: 14, ts: RECENT });
    addOut('sess-1', 'out-old', 3, OLD, true);
    addOut('sess-1', 'out-old-undelivered', 5, OLD, false);
    addOut('sess-1', 'out-new', 15, RECENT, true);
    const out = new Database(outboundDbPath(AG, 'sess-1'));
    out.prepare(`INSERT INTO usage_log (ts, kind, input_tokens) VALUES (?, 'chat', 10)`).run(OLD);
    out
      .prepare(`INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('old-done', 'completed', ?)`)
      .run(OLD);
    out.close();
    const dir = sessionDir(AG, 'sess-1');
    writeFile(path.join(dir, 'inbox', 'old-done', 'photo.jpg'));
    writeFile(path.join(dir, 'inbox', 'old-task', 'doc.pdf'));
    writeFile(path.join(dir, 'inbox', 'orphan', 'x.bin'));
    touchOld(path.join(dir, 'inbox', 'orphan'));
  }

  it('deletes old finished messages and their attachments, keeps tasks, due work, usage and the newest row', async () => {
    seed();
    const r = await runRetentionSweep({ ...OFF, messageDays: 365 });

    expect(ids(inboundDbPath(AG, 'sess-1'), 'messages_in')).toEqual(
      ['new-done', 'old-due', 'old-paused', 'old-recurring', 'old-task'].sort(),
    );
    expect(ids(outboundDbPath(AG, 'sess-1'), 'messages_out')).toEqual(['out-new', 'out-old-undelivered']);
    expect(ids(inboundDbPath(AG, 'sess-1'), 'delivered')).toEqual(['out-new']);
    const out = new Database(outboundDbPath(AG, 'sess-1'), { readonly: true });
    expect((out.prepare('SELECT COUNT(*) AS c FROM usage_log').get() as { c: number }).c).toBe(1);
    expect((out.prepare('SELECT COUNT(*) AS c FROM processing_ack').get() as { c: number }).c).toBe(0);
    out.close();

    const dir = sessionDir(AG, 'sess-1');
    expect(fs.existsSync(path.join(dir, 'inbox', 'old-done'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'inbox', 'orphan'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'inbox', 'old-task', 'doc.pdf'))).toBe(true);
    expect(r).toMatchObject({ messagesIn: 2, messagesOut: 1, sessionsWithDeletions: 1, attachmentDirs: 2 });
  });

  it('leaves outbound.db alone while the container is running or starting', async () => {
    seed();
    busy.add('sess-1');
    const r = await runRetentionSweep({ ...OFF, messageDays: 365 });
    expect(ids(outboundDbPath(AG, 'sess-1'), 'messages_out')).toEqual(['out-new', 'out-old', 'out-old-undelivered']);
    expect(ids(inboundDbPath(AG, 'sess-1'), 'delivered')).toEqual(['out-new', 'out-old']);
    expect(r.messagesIn).toBe(2); // inbound.db is host-owned, safe either way
    expect(r.sessionsSkippedBusy).toBe(1);
  });

  it('deletes old conversation archives and task run logs', async () => {
    const old = writeFile(path.join(ROOT, 'groups/shop/conversations/2025-01-01-chat.md'), 'x', 400 * DAY);
    const fresh = writeFile(path.join(ROOT, 'groups/shop/conversations/2026-09-01-chat.md'), 'x', DAY);
    const task = writeFile(path.join(ROOT, 'groups/shop/tasks/daily.md'), 'x', 400 * DAY);
    const r = await runRetentionSweep({ ...OFF, messageDays: 365 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(task)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(r.archives).toBe(2);
  });

  it('does nothing when every period is 0', async () => {
    seed();
    const archive = writeFile(path.join(ROOT, 'groups/shop/conversations/a.md'), 'x', 400 * DAY);
    const sent = writeFile(path.join(ROOT, 'store/wa-sent/ABC'), 'x', 400 * DAY);
    const r = await runRetentionSweep(OFF);
    expect(ids(inboundDbPath(AG, 'sess-1'), 'messages_in')).toHaveLength(7);
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.existsSync(sent)).toBe(true);
    expect(Object.values(r).every((v) => v === 0)).toBe(true);
  });
});

describe('rotated transcripts', () => {
  it('deletes .rotated-* files rotated before the cutoff and never the live transcript', async () => {
    const dir = path.join(ROOT, 'data/v2-sessions', AG, '.claude-shared/projects/-workspace-agent');
    const live = writeFile(path.join(dir, 'abc.jsonl'), 'x', 400 * DAY);
    const oldRot = writeFile(path.join(dir, `abc.jsonl.rotated-${NOW - 40 * DAY}`));
    const newRot = writeFile(path.join(dir, `def.jsonl.rotated-${NOW - 5 * DAY}`));
    const r = await runRetentionSweep({ ...OFF, rotatedTranscriptDays: 30 });
    expect(fs.existsSync(oldRot)).toBe(false);
    expect(fs.existsSync(newRot)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
    expect(r.rotatedTranscripts).toBe(1);
  });
});

describe('web session retention', () => {
  beforeEach(() => {
    createMessagingGroup({
      id: 'mg-web',
      channel_type: 'web',
      platform_id: 'web:shopkey1',
      instance: 'web',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: RECENT,
      denied_at: null,
    });
    getDb()
      .prepare(
        `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
         VALUES ('mga-web', 'mg-web', ?, 'pattern', '.', 'all', 'drop', 'per-thread', 0, ?)`,
      )
      .run(AG, RECENT);
  });

  const addUser = (id: string) =>
    getDb()
      .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', 'Visitor', ?)`)
      .run(id, RECENT);

  it('removes idle visitor sessions entirely and a returning visitor starts fresh', async () => {
    session('sess-idle', {
      messaging_group_id: 'mg-web',
      thread_id: 'visitor-idle-01',
      last_active: iso(NOW - 45 * DAY),
    });
    session('sess-live', { messaging_group_id: 'mg-web', thread_id: 'visitor-live-01', last_active: iso(NOW - DAY) });
    addUser('web:visitor-idle-01');
    addUser('web:visitor-live-01');
    // Its Claude transcript, found through the continuation id the container stored.
    const out = new Database(outboundDbPath(AG, 'sess-idle'));
    out
      .prepare(`INSERT INTO session_state (key, value, updated_at) VALUES ('continuation:claude', 'sdk-123', ?)`)
      .run(OLD);
    out.close();
    const transcript = writeFile(
      path.join(ROOT, 'data/v2-sessions', AG, '.claude-shared/projects/-workspace-agent/sdk-123.jsonl'),
    );

    const r = await runRetentionSweep({ ...OFF, webSessionDays: 30 });
    expect(r).toMatchObject({ webSessions: 1, webUsers: 1 });
    expect(getSession('sess-idle')).toBeUndefined();
    expect(fs.existsSync(sessionDir(AG, 'sess-idle'))).toBe(false);
    expect(fs.existsSync(transcript)).toBe(false);
    expect(getDb().prepare('SELECT id FROM users ORDER BY id').all()).toEqual([{ id: 'web:visitor-live-01' }]);
    expect(getSession('sess-live')).toBeDefined();

    // The same visitor comes back: a new session, written to without errors.
    const { session: fresh, created } = resolveSession(AG, 'mg-web', 'visitor-idle-01', 'per-thread');
    expect(created).toBe(true);
    expect(fresh.id).not.toBe('sess-idle');
    writeSessionMessage(AG, fresh.id, {
      id: 'web-m1',
      kind: 'chat',
      timestamp: iso(NOW),
      content: JSON.stringify({ text: 'hello again', sender: 'Visitor', senderId: 'web:visitor-idle-01' }),
    });
    expect(ids(inboundDbPath(AG, fresh.id), 'messages_in')).toEqual(['web-m1']);
  });

  it('skips a session whose container is running, and keeps a users row something else needs', async () => {
    session('sess-a', { messaging_group_id: 'mg-web', thread_id: 'visitor-aaaa-01', last_active: iso(NOW - 45 * DAY) });
    session('sess-b', { messaging_group_id: 'mg-web', thread_id: 'visitor-bbbb-01', last_active: iso(NOW - 45 * DAY) });
    addUser('web:visitor-bbbb-01');
    getDb()
      .prepare(`INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`)
      .run('web:visitor-bbbb-01', AG, RECENT);
    busy.add('sess-a');

    const r = await runRetentionSweep({ ...OFF, webSessionDays: 30 });
    expect(r).toMatchObject({ webSessions: 1, webUsers: 0, sessionsSkippedBusy: 1 });
    expect(getSession('sess-a')).toBeDefined();
    expect(getSession('sess-b')).toBeUndefined();
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 1 });
  });
});

describe('wa-sent and logs', () => {
  it('deletes wa-sent copies older than the cutoff', async () => {
    const old = writeFile(path.join(ROOT, 'store/wa-sent/OLDID'), 'x', 20 * DAY);
    const fresh = writeFile(path.join(ROOT, 'store/wa-sent/NEWID'), 'x', DAY);
    const r = await runRetentionSweep({ ...OFF, waSentDays: 14 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(r.waSent).toBe(1);
  });

  it('copy-truncates the service logs in place and deletes rotated copies past the cutoff', async () => {
    const logs = path.join(ROOT, 'logs');
    const main = writeFile(path.join(logs, 'nanoclaw.log'), 'line one\n');
    writeFile(path.join(logs, 'nanoclaw.error.log'), '');
    const oldCopy = writeFile(path.join(logs, 'nanoclaw.log.20250101-000000'), 'old', 40 * DAY);
    const setupLog = writeFile(path.join(logs, 'setup.log'), 'keep', 400 * DAY);

    // An O_APPEND writer (what launchd/systemd hold) keeps writing after the truncate.
    const fd = fs.openSync(main, 'a');
    const r = await runRetentionSweep({ ...OFF, logDays: 30 });
    fs.writeSync(fd, 'line two\n');
    fs.closeSync(fd);

    expect(fs.readFileSync(main, 'utf-8')).toBe('line two\n');
    const rotated = fs.readdirSync(logs).filter((f) => /^nanoclaw\.log\.\d{8}-\d{6}$/.test(f));
    expect(rotated).toHaveLength(1);
    expect(fs.readFileSync(path.join(logs, rotated[0]), 'utf-8')).toBe('line one\n');
    expect(fs.existsSync(oldCopy)).toBe(false);
    expect(fs.existsSync(setupLog)).toBe(true);
    expect(r).toMatchObject({ logsRotated: 1, logsDeleted: 1 });
  });
});
