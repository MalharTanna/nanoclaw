import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { isMember } from './modules/permissions/db/agent-group-members.js';
import { ensureOwnerSelfChat } from './owner-self-chat.js';

const SELF = '917069841155@s.whatsapp.net';
const now = () => new Date().toISOString();

beforeEach(() => {
  runMigrations(initTestDb());
});
afterEach(() => closeDb());

describe("ensureOwnerSelfChat - the owner's own chat on their number", () => {
  it('wires the chat to the install assistant, answering every message, once', () => {
    createAgentGroup({ id: 'ag-1', name: 'Miro', folder: 'b', agent_provider: null, created_at: now() });
    expect(ensureOwnerSelfChat(SELF)).toBe(true);
    expect(ensureOwnerSelfChat(SELF)).toBe(true);
    const mg = getMessagingGroupByPlatform('whatsapp', SELF)!;
    expect(mg.is_group).toBe(0);
    const wirings = getMessagingGroupAgents(mg.id);
    expect(wirings).toHaveLength(1);
    expect(wirings[0]).toMatchObject({ agent_group_id: 'ag-1', engage_mode: 'pattern', engage_pattern: '.' });
    expect(isMember(`whatsapp:${SELF}`, 'ag-1')).toBe(true);
  });

  it('does nothing before the assistant is set up', () => {
    expect(ensureOwnerSelfChat(SELF)).toBe(false);
    expect(getMessagingGroupByPlatform('whatsapp', SELF)).toBeUndefined();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
  });
});
