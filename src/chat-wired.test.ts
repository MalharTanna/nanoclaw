import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearWiredCache, isChatWired } from './chat-wired.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from './db/messaging-groups.js';

const now = () => new Date().toISOString();

beforeEach(() => {
  runMigrations(initTestDb());
  clearWiredCache();
});
afterEach(() => closeDb());

describe('isChatWired - own number leaves other chats alone', () => {
  it('true only for a chat wired to an assistant', () => {
    createAgentGroup({ id: 'ag-1', name: 'Miro', folder: 'b', agent_provider: null, created_at: now() });
    createMessagingGroup({ id: 'mg-on', channel_type: 'whatsapp', platform_id: '120363000000000001@g.us', name: null, is_group: 1, unknown_sender_policy: 'public', created_at: now() });
    createMessagingGroup({ id: 'mg-seen', channel_type: 'whatsapp', platform_id: '120363000000000002@g.us', name: null, is_group: 1, unknown_sender_policy: 'public', created_at: now() });
    createMessagingGroupAgent({ id: 'mga-1', messaging_group_id: 'mg-on', agent_group_id: 'ag-1', engage_mode: 'mention', engage_pattern: null, sender_scope: 'all', ignored_message_policy: 'drop', session_mode: 'shared', priority: 0, created_at: now() });
    expect(isChatWired('120363000000000001@g.us')).toBe(true);
    expect(isChatWired('120363000000000002@g.us')).toBe(false);
    expect(isChatWired('120363000000000003@g.us')).toBe(false);
  });
});
