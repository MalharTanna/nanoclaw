import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dir: `${process.env.TMPDIR ?? '/tmp'}/nanoclaw-test-direct-reminders-${process.pid}`,
  adapter: {
    isConnected: vi.fn(() => true),
    deliver: vi.fn(async (_to: string, _thread: string | null, _msg: unknown) => 'WAMSG1' as string | undefined),
  },
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: h.dir, GROUPS_DIR: `${h.dir}/groups`, TIMEZONE: 'UTC' };
});
vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapterExact: (key: string) => (key === 'whatsapp' ? h.adapter : undefined),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import '../../cli/resources/tasks.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { countDueMessages } from '../../db/session-db.js';
import { inboundDbPath, initSessionFolder } from '../../session-manager.js';
import { createDestination } from '../agent-to-agent/db/agent-destinations.js';
import { deliverDuePlainReminders } from './direct-reminders.js';

const now = () => new Date().toISOString();
const chat: CallerContext = { caller: 'agent', agentGroupId: 'ag-1', sessionId: 'chat-1', messagingGroupId: 'mg-1' };

beforeEach(() => {
  if (fs.existsSync(h.dir)) fs.rmSync(h.dir, { recursive: true });
  fs.mkdirSync(h.dir, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({ id: 'ag-1', name: 'ag-1', folder: 'ag-1', agent_provider: null, created_at: now() });
  createMessagingGroup({ id: 'mg-1', channel_type: 'whatsapp', platform_id: '120363000000000001@g.us', name: null, is_group: 1, unknown_sender_policy: 'public', created_at: now() });
  createDestination({ agent_group_id: 'ag-1', local_name: 'whatsapp-mg1', target_type: 'channel', target_id: 'mg-1', created_at: now() });
  createSession({ id: 'chat-1', agent_group_id: 'ag-1', messaging_group_id: 'mg-1', thread_id: null, agent_provider: null, status: 'active', container_status: 'stopped', last_active: null, created_at: now() });
  initSessionFolder('ag-1', 'chat-1');
  h.adapter.deliver.mockClear();
  h.adapter.isConnected.mockReturnValue(true);
});
afterEach(() => {
  closeDb();
  if (fs.existsSync(h.dir)) fs.rmSync(h.dir, { recursive: true });
});

async function create(args: Record<string, unknown>) {
  const r = await dispatch({ id: 'c', command: 'tasks-create', args }, chat);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data as { session_id: string; series_id: string };
}

describe('plain reminders (--message)', () => {
  it('a prompt that is just "Reminder: ..." also goes direct, and an identical repeat is not created twice', async () => {
    const first = await create({ name: 'llm-cert', prompt: 'Reminder: Krina, check the LLM certificate', process_after: '2020-01-01T00:00:00Z' });
    const again = await dispatch({ id: 'c2', command: 'tasks-create', args: { name: 'check-cert', prompt: 'Reminder: Krina, check LLM certificate', process_after: '2020-01-01T00:00:00Z' } }, chat);
    expect(again.ok && (again.data as { duplicate?: boolean; series_id: string })).toMatchObject({ duplicate: true, series_id: first.series_id });
    const db = new Database(inboundDbPath('ag-1', first.session_id));
    expect(await deliverDuePlainReminders(db, 'ag-1')).toBe(1);
    expect(h.adapter.deliver).toHaveBeenCalledTimes(1);
    expect(h.adapter.deliver).toHaveBeenCalledWith('120363000000000001@g.us', null, { kind: 'chat', content: { text: 'Reminder: Krina, check the LLM certificate' } });
    db.close();
  });

  it('a different time is a different reminder; instructions still go to the agent', async () => {
    await create({ name: 'a', message: 'Reminder: call Krina', process_after: '2999-01-01T10:00:00Z' });
    const b = await dispatch({ id: 'b', command: 'tasks-create', args: { message: 'Reminder: call Krina', process_after: '2999-01-01T11:00:00Z' } }, chat);
    expect(b.ok && (b.data as { duplicate?: boolean }).duplicate).toBeFalsy();
    const t = await create({ name: 'watch', prompt: 'Reminder: check the court board and send a WhatsApp message to whatsapp-mg1 when Court 12 reaches 40', process_after: '2020-01-01T00:00:00Z' });
    const db = new Database(inboundDbPath('ag-1', t.session_id));
    expect(await deliverDuePlainReminders(db, 'ag-1')).toBe(0);
    db.close();
  });

  it('are posted to the chat they were set in without waking the agent', async () => {
    const t = await create({ name: 'icards', message: 'Reminder: Krina, take the i-cards', process_after: '2020-01-01T00:00:00Z' });
    const db = new Database(inboundDbPath('ag-1', t.session_id));
    expect(countDueMessages(db)).toBe(1);

    expect(await deliverDuePlainReminders(db, 'ag-1')).toBe(1);
    expect(h.adapter.deliver).toHaveBeenCalledWith('120363000000000001@g.us', null, { kind: 'chat', content: { text: 'Reminder: Krina, take the i-cards' } });
    expect(countDueMessages(db)).toBe(0); // nothing left to wake the agent for
    expect(await deliverDuePlainReminders(db, 'ag-1')).toBe(0); // never twice
    db.close();
  });

  it('wait while WhatsApp is down, and future ones wait for their time', async () => {
    const t = await create({ name: 'later', message: 'Later', process_after: '2999-01-01T00:00:00Z' });
    const now1 = await create({ name: 'now', message: 'Now', process_after: '2020-01-01T00:00:00Z' });
    h.adapter.isConnected.mockReturnValue(false);
    const db1 = new Database(inboundDbPath('ag-1', now1.session_id));
    expect(await deliverDuePlainReminders(db1, 'ag-1')).toBe(0);
    h.adapter.isConnected.mockReturnValue(true);
    expect(await deliverDuePlainReminders(db1, 'ag-1')).toBe(1);
    const db2 = new Database(inboundDbPath('ag-1', t.session_id));
    expect(await deliverDuePlainReminders(db2, 'ag-1')).toBe(0);
    db1.close();
    db2.close();
  });

  it('tasks with a prompt or a script still go to the agent; --message and --script cannot be combined', async () => {
    const t = await create({ name: 'thinking', prompt: 'Check the court board', process_after: '2020-01-01T00:00:00Z' });
    const db = new Database(inboundDbPath('ag-1', t.session_id));
    expect(await deliverDuePlainReminders(db, 'ag-1')).toBe(0);
    expect(countDueMessages(db)).toBe(1);
    db.close();
    const r = await dispatch({ id: 'x', command: 'tasks-create', args: { message: 'x', script: 'echo', process_after: '2020-01-01T00:00:00Z' } }, chat);
    expect(r.ok).toBe(false);
  });
});
