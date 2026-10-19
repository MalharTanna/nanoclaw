/**
 * Own number: the owner's "Message yourself" chat talks to Miro, with no
 * setup. Nobody else is in that chat, so it is always safe to answer, and it
 * doesn't count as one of the business's personal chats.
 *
 * Wired on every WhatsApp connect (idempotent): the owner's user, membership
 * of the install's assistant, the chat, and a wiring that answers every
 * message. An install holds one business's assistant; with none (not set up
 * yet) or several, nothing is wired.
 */
import crypto from 'crypto';

import { getAllAgentGroups } from './db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroupAgentByPair, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { log } from './log.js';
import { addMember } from './modules/permissions/db/agent-group-members.js';
import { upsertUser } from './modules/permissions/db/users.js';

const id = (prefix: string) => `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

/** `selfJid` is the number's own chat, e.g. "919876543210@s.whatsapp.net". */
export function ensureOwnerSelfChat(selfJid: string, now: string = new Date().toISOString()): boolean {
  const groups = getAllAgentGroups();
  if (groups.length !== 1) return false;
  const ag = groups[0]!;
  const userId = `whatsapp:${selfJid}`;
  upsertUser({ id: userId, kind: 'whatsapp', display_name: null, created_at: now });
  addMember({ user_id: userId, agent_group_id: ag.id, added_by: null, added_at: now });
  let mg = getMessagingGroupByPlatform('whatsapp', selfJid);
  if (!mg) {
    createMessagingGroup({ id: id('mg'), channel_type: 'whatsapp', platform_id: selfJid, name: null, is_group: 0, unknown_sender_policy: 'strict', created_at: now });
    mg = getMessagingGroupByPlatform('whatsapp', selfJid)!;
  }
  if (getMessagingGroupAgentByPair(mg.id, ag.id)) return true;
  createMessagingGroupAgent({
    id: id('mga'),
    messaging_group_id: mg.id,
    agent_group_id: ag.id,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
  log.info('Owner self-chat wired', { agentGroup: ag.id });
  return true;
}
