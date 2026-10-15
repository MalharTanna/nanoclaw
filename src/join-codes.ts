/**
 * Join codes (shared-number mode).
 *
 * On a shared bot number, a customer links a WhatsApp group by adding the
 * number and sending "join AB23CD" in the group. Sent in a direct message
 * instead, the same code links the sender's own number for DMs - WhatsApp
 * has already proved they own it, so no SMS code is needed. The node-agent
 * (single writer) keeps the
 * armed codes in `data/join-codes.json`; this module only READS that file:
 *
 *   - valid code  → reply "✅ connected", append the request to
 *                   `data/link-requests.jsonl` (the node-agent wires the chat
 *                   and reports it upstream)
 *   - bad code    → reply "not valid" (at most once per chat per 10 min)
 *
 * Only messages from chats with NO wiring that match the exact pattern are
 * looked at; nothing else from unwired chats is read or recorded. Installs
 * without a join-codes file (e.g. a personal NanoClaw) never enter this path.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import { idTag } from './log-redact.js';
import type { InboundEvent } from './channels/adapter.js';

export const JOIN_RE = /^\s*join\s+([A-HJ-NP-Z2-9]{6})\s*$/i;
const INVALID_REPLY_COOLDOWN_MS = 10 * 60_000;
/** A DM can only be linked once its sender resolved to a phone number (not an unresolved @lid). */
const PHONE_DM_JID = /^[0-9]{5,20}@s\.whatsapp\.net$/;

export interface ArmedCode {
  tenantId: string;
  agentGroupId: string;
  assistantName: string;
  /** The business that issued the code; named in the group notice. */
  businessName?: string;
  /** Largest group the business's plan allows. */
  maxGroupMembers?: number;
  expiresAt: string; // ISO-8601 UTC
}

export interface LinkRequest {
  ts: string;
  /** When the join message was sent (differs from ts for messages answered after an outage). */
  sentAt?: string;
  code: string;
  tenantId: string;
  agentGroupId: string;
  channelType: string;
  platformId: string;
  instance: string;
}

const invalidRepliedAt = new Map<string, number>();

export function joinCodesPath(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'join-codes.json');
}

export function linkRequestsPath(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'link-requests.jsonl');
}

/** The code in a message, uppercased, or null. */
export function matchJoinCode(text: string | undefined): string | null {
  const m = text ? JOIN_RE.exec(text) : null;
  return m ? m[1]!.toUpperCase() : null;
}

/** Armed codes, or null when this install doesn't use join codes (no file / unreadable). */
export function readArmedCodes(dataDir = DATA_DIR): Record<string, ArmedCode> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(joinCodesPath(dataDir), 'utf-8')) as {
      codes?: Record<string, ArmedCode>;
    };
    return parsed.codes ?? {};
  } catch {
    return null;
  }
}

async function reply(event: InboundEvent, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  try {
    await adapter.deliver(
      event.channelType,
      event.platformId,
      null,
      'chat',
      JSON.stringify({ text }),
      undefined,
      event.instance ?? event.channelType,
    );
  } catch (err) {
    log.warn('Join-code reply failed', { chat: idTag(event.platformId), err });
  }
}

export const PRIVACY_URL = 'https://miroflow.in/privacy';

/**
 * Posted once when a group is linked: the members' notice the legal review
 * asked for (the customer stays responsible for telling their group; this
 * makes sure everyone in it sees the basics).
 */
export function groupNotice(assistantName: string, businessName?: string): string {
  const who = businessName?.trim()
    ? `*${businessName.trim()}* has connected this group to`
    : 'This group is now connected to';
  return (
    `✅ ${who} **${assistantName}**, an AI assistant by Miroflow. I only reply when someone mentions me with @ or by name.\n\n` +
    `ℹ️ *For everyone in this group:* messages sent to ${assistantName}, and files shared with it, are processed by Miroflow and its AI provider to reply. ` +
    `Replies and those messages are kept while the business's Miroflow account is active, so the assistant can remember context. Privacy: ${PRIVACY_URL}\n\n` +
    `To remove me, a group admin can open the group info, tap ${assistantName} and choose Remove.`
  );
}

/**
 * Largest group (members) that can be linked when the code doesn't say (the
 * control plane sends the plan's limit: Standard 20, Premium 50). Community
 * and announcement groups can't be linked at all.
 */
export const MAX_GROUP_MEMBERS = 50;

function groupInfoOf(event: InboundEvent): { size: number; community: boolean } | null {
  try {
    const raw = event.message.content as unknown;
    const c = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      groupInfo?: { size?: unknown; community?: unknown };
    } | null;
    const g = c?.groupInfo;
    if (!g || typeof g.size !== 'number') return null;
    return { size: g.size, community: g.community === true };
  } catch {
    return null;
  }
}

export function groupTooLargeNotice(info: { size: number; community: boolean }, limit = MAX_GROUP_MEMBERS): string {
  const why = info.community
    ? 'this is a WhatsApp community or announcement group'
    : `this group has ${info.size} members, and this plan allows groups of up to ${limit}`;
  return (
    `⚠️ Miro can't be added here: ${why}. Miro is meant for teams and clients who know each other; ` +
    'large and community groups can get its WhatsApp number blocked. Please use it in a smaller group. Your join code still works there.'
  );
}

/**
 * Handle a possible join message from an UNWIRED group. Returns true when the
 * message was a join attempt on a join-code install (so routing stops).
 */
export async function maybeHandleJoinCode(
  event: InboundEvent,
  text: string | undefined,
  dataDir = DATA_DIR,
  now: number = Date.now(),
): Promise<boolean> {
  const isGroup = event.message.isGroup === true;
  const code = matchJoinCode(text);
  if (!code) return false;
  const codes = readArmedCodes(dataDir);
  if (codes === null) return false;

  // Personal chats get no reply at all on the shared number (a reply in a
  // brand-new chat preceded both of its logouts); the dashboard shows the result.
  if (!isGroup && !PHONE_DM_JID.test(event.platformId)) {
    log.info('Join code in a DM from an unresolved sender', { channelType: event.channelType });
    return true;
  }

  // A code is judged by when the message was sent, so one sent during an
  // outage and handled once Miro is back still counts.
  const sent = Date.parse(event.message.timestamp);
  const sentAt = Number.isFinite(sent) ? Math.min(now, sent) : now;
  const armed = codes[code];
  if (!armed || Date.parse(armed.expiresAt) <= sentAt) {
    const last = invalidRepliedAt.get(event.platformId) ?? 0;
    if (isGroup && now - last >= INVALID_REPLY_COOLDOWN_MS) {
      invalidRepliedAt.set(event.platformId, now);
      await reply(
        event,
        "⚠️ That join code isn't valid or has expired. Get a new code from your dashboard and try again.",
      );
    }
    log.info('Join code rejected', { chat: idTag(event.platformId) });
    return true;
  }

  // Large and community groups are refused: members there often don't know
  // each other, and reports from them are what gets a number blocked.
  if (isGroup) {
    const info = groupInfoOf(event);
    const limit = armed.maxGroupMembers ?? MAX_GROUP_MEMBERS;
    if (info && (info.community || info.size > limit)) {
      const last = invalidRepliedAt.get(event.platformId) ?? 0;
      if (now - last >= INVALID_REPLY_COOLDOWN_MS) {
        invalidRepliedAt.set(event.platformId, now);
        await reply(event, groupTooLargeNotice(info, limit));
      }
      log.info('Join code refused: group too large or a community', { chat: idTag(event.platformId), size: info.size });
      return true;
    }
  }

  const request: LinkRequest = {
    ts: new Date(now).toISOString(),
    ...(sentAt < now ? { sentAt: new Date(sentAt).toISOString() } : {}),
    code,
    tenantId: armed.tenantId,
    agentGroupId: armed.agentGroupId,
    channelType: event.channelType,
    platformId: event.platformId,
    instance: event.instance ?? event.channelType,
  };
  fs.appendFileSync(linkRequestsPath(dataDir), JSON.stringify(request) + '\n', { mode: 0o600 });
  log.info('Join code accepted', { chat: idTag(event.platformId), tenantId: armed.tenantId });
  if (isGroup) await reply(event, groupNotice(armed.assistantName, armed.businessName));
  return true;
}

/**
 * NANOCLAW_SHARED_NUMBER=true (SaaS shared-number installs): a chat with no
 * wiring is none of our business - drop it silently after the join-code
 * check, instead of auto-registering it and asking the install owner (us)
 * to approve every stranger who messages the number.
 */
export function isSharedNumber(): boolean {
  const v = process.env.NANOCLAW_SHARED_NUMBER || readEnvFile(['NANOCLAW_SHARED_NUMBER']).NANOCLAW_SHARED_NUMBER;
  return v === 'true';
}

export const UNLINKED_GROUP_REPLY = [
  "👋 Hi, I'm Miro, Miroflow's assistant. This group isn't connected yet, so I can't help here. To connect it:",
  '',
  '1. Sign in at app.miroflow.in (new here? create an account at miroflow.in)',
  '2. Open *Connect WhatsApp* - you will see a code like *join AB23CD*',
  '3. Send that exact message in this group',
  '',
  'The code works once and expires in a few minutes, so send it right away. Only the business account owner or an admin can get it. After that, mention me with @ to ask anything.',
].join('\n');
const UNLINKED_REPLY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const GROUP_JID = /^[0-9-]{5,40}@g\.us$/;

export function unlinkedRepliesPath(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'unlinked-chat-replies.json');
}

/**
 * Shared number, a group no business has linked: when someone mentions the
 * assistant (@ or by name), one reply a day with the steps to get and send a
 * join code. Personal chats stay silent.
 * Anything else stays silent, as do messages typed on the bot phone itself.
 * The cooldown file keeps only a hash of the chat id and the time, so no
 * number is stored. Returns true if it replied.
 */
export async function maybeReplyToUnlinkedChat(
  event: InboundEvent,
  addressed: boolean,
  dataDir = DATA_DIR,
  now: number = Date.now(),
): Promise<boolean> {
  if (event.channelType !== 'whatsapp' || event.message.kind !== 'chat') return false;
  const isGroup = event.message.isGroup === true;
  // Personal chats no business linked get no reply: the shared number never
  // writes to someone it doesn't already serve.
  if (!isGroup || !addressed || !GROUP_JID.test(event.platformId)) return false;
  try {
    const raw = event.message.content as unknown;
    const content = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { fromMe?: unknown } | null;
    if (content?.fromMe === true) return false;
  } catch {
    /* unparsable content: treat as an ordinary incoming message */
  }
  const file = unlinkedRepliesPath(dataDir);
  let seen: Record<string, number> = {};
  try {
    seen = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>;
  } catch {
    /* first reply, or unreadable - start fresh */
  }
  const key = crypto.createHash('sha256').update(event.platformId).digest('hex').slice(0, 32);
  if (typeof seen[key] === 'number' && now - seen[key] < UNLINKED_REPLY_COOLDOWN_MS) return false;
  for (const [k, t] of Object.entries(seen)) if (now - t >= UNLINKED_REPLY_COOLDOWN_MS) delete seen[k];
  seen[key] = now;
  try {
    fs.writeFileSync(file, JSON.stringify(seen));
  } catch (err) {
    log.warn('Could not save unlinked-chat reply time', { err });
  }
  await reply(event, UNLINKED_GROUP_REPLY);
  log.info('Replied to unlinked chat', { chat: idTag(event.platformId), isGroup });
  return true;
}

/** Test hook. */
export function _resetJoinCodeCooldownForTest(): void {
  invalidRepliedAt.clear();
}
