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
  expiresAt: string; // ISO-8601 UTC
}

export interface LinkRequest {
  ts: string;
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

  if (!isGroup && !PHONE_DM_JID.test(event.platformId)) {
    log.info('Join code in a DM from an unresolved sender', { channelType: event.channelType });
    await reply(event, "⚠️ I couldn't confirm your number. Please send the code again in a minute.");
    return true;
  }

  const armed = codes[code];
  if (!armed || Date.parse(armed.expiresAt) <= now) {
    const last = invalidRepliedAt.get(event.platformId) ?? 0;
    if (now - last >= INVALID_REPLY_COOLDOWN_MS) {
      invalidRepliedAt.set(event.platformId, now);
      await reply(
        event,
        "⚠️ That join code isn't valid or has expired. Get a new code from your dashboard and try again.",
      );
    }
    log.info('Join code rejected', { chat: idTag(event.platformId) });
    return true;
  }

  const request: LinkRequest = {
    ts: new Date(now).toISOString(),
    code,
    tenantId: armed.tenantId,
    agentGroupId: armed.agentGroupId,
    channelType: event.channelType,
    platformId: event.platformId,
    instance: event.instance ?? event.channelType,
  };
  fs.appendFileSync(linkRequestsPath(dataDir), JSON.stringify(request) + '\n', { mode: 0o600 });
  log.info('Join code accepted', { chat: idTag(event.platformId), tenantId: armed.tenantId });
  await reply(
    event,
    isGroup
      ? `✅ This group is now connected to **${armed.assistantName}**. Mention me with @ to ask anything.`
      : `✅ Your number is now connected to **${armed.assistantName}**. Message me here any time.`,
  );
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

/** Test hook. */
export function _resetJoinCodeCooldownForTest(): void {
  invalidRepliedAt.clear();
}
