import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from './db/messaging-groups.js';
import { createSession } from './db/sessions.js';
import { isReturningGroup } from './returning-group.js';

const now = () => new Date().toISOString();
const group = (id: string, platformId: string) =>
  createMessagingGroup({ id, channel_type: 'whatsapp', platform_id: platformId, name: null, is_group: 1, unknown_sender_policy: 'public', created_at: now() });

beforeEach(() => runMigrations(initTestDb()));
afterEach(() => closeDb());

describe('isReturningGroup - old groups skip the new-group join queue', () => {
  it('true for a wired group or one with a conversation (carried over a move); false for new groups and other businesses', () => {
    createAgentGroup({ id: 'ag-1', name: 'Miro', folder: 'b1', agent_provider: null, created_at: now() });
    createAgentGroup({ id: 'ag-2', name: 'Miro', folder: 'b2', agent_provider: null, created_at: now() });
    group('mg-wired', '120363000000000001@g.us');
    group('mg-moved', '120363000000000002@g.us');
    group('mg-seen', '120363000000000003@g.us');
    createMessagingGroupAgent({ id: 'mga-1', messaging_group_id: 'mg-wired', agent_group_id: 'ag-1', engage_mode: 'mention', engage_pattern: null, sender_scope: 'all', ignored_message_policy: 'drop', session_mode: 'shared', priority: 0, created_at: now() });
    createSession({ id: 's-1', agent_group_id: 'ag-1', messaging_group_id: 'mg-moved', thread_id: null, agent_provider: null, status: 'active', container_status: 'stopped', last_active: null, created_at: now() });

    expect(isReturningGroup('ag-1', 'whatsapp', '120363000000000001@g.us')).toBe(true);
    expect(isReturningGroup('ag-1', 'whatsapp', '120363000000000002@g.us')).toBe(true);
    expect(isReturningGroup('ag-1', 'whatsapp', '120363000000000003@g.us')).toBe(false);
    expect(isReturningGroup('ag-1', 'whatsapp', '120363000000000009@g.us')).toBe(false);
    expect(isReturningGroup('ag-2', 'whatsapp', '120363000000000002@g.us')).toBe(false);
  });

  it('false without a central DB', () => {
    closeDb();
    expect(isReturningGroup('ag-1', 'whatsapp', '120363000000000001@g.us')).toBe(false);
  });
});
