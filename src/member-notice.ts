/**
 * Shared-number installs: when a group is switched to "answer every message"
 * (engage_mode 'pattern' with '.'), everyone in it should know that all their
 * messages now reach the assistant, not only the ones addressed to it. The
 * first message routed after such a switch posts a notice once; switching the
 * group back to mention/keyword re-arms it for the next switch.
 *
 * State lives in data/member-notices.json: messaging group id -> 'all' | 'other'.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getDeliveryAdapter } from './delivery.js';
import { PRIVACY_URL, isSharedNumber } from './join-codes.js';
import { log } from './log.js';
import { idTag } from './log-redact.js';
import type { InboundEvent } from './channels/adapter.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

type NoticeState = Record<string, 'all' | 'other'>;

export function noticeStatePath(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'member-notices.json');
}

function readState(dataDir: string): NoticeState {
  try {
    return JSON.parse(fs.readFileSync(noticeStatePath(dataDir), 'utf8')) as NoticeState;
  } catch {
    return {};
  }
}

function writeState(dataDir: string, state: NoticeState): void {
  const file = noticeStatePath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** True when this wiring answers every message in the chat. */
export function answersEverything(agent: Pick<MessagingGroupAgent, 'engage_mode' | 'engage_pattern'>): boolean {
  return agent.engage_mode === 'pattern' && (agent.engage_pattern ?? '.') === '.';
}

export function answerAllNotice(assistantName: string): string {
  return (
    `ℹ️ *For everyone in this group:* ${assistantName} now reads every message here, not only the ones sent to it. ` +
    `Messages and files shared in this group are processed by Miroflow and its AI provider to reply, and kept up to 12 months. ` +
    `Privacy: ${PRIVACY_URL}`
  );
}

/**
 * Post the "answers everything" notice if this group has just been switched to
 * that mode. Best effort: a failed send is logged and never blocks routing.
 */
export async function maybePostAnswerAllNotice(
  event: InboundEvent,
  mg: Pick<MessagingGroup, 'id' | 'is_group'>,
  agents: Array<Pick<MessagingGroupAgent, 'engage_mode' | 'engage_pattern'>>,
  assistantName: string,
  dataDir = DATA_DIR,
): Promise<boolean> {
  if (!isSharedNumber() || mg.is_group !== 1 || agents.length === 0) return false;
  const now = agents.some(answersEverything) ? 'all' : 'other';
  const state = readState(dataDir);
  const before = state[mg.id];
  if (before === now) return false;
  state[mg.id] = now;
  writeState(dataDir, state);
  if (now !== 'all') return false;

  const adapter = getDeliveryAdapter();
  if (!adapter) return false;
  try {
    await adapter.deliver(
      event.channelType,
      event.platformId,
      null,
      'chat',
      JSON.stringify({ text: answerAllNotice(assistantName) }),
      undefined,
      event.instance ?? event.channelType,
    );
    log.info('Posted answer-everything notice', { chat: idTag(event.platformId) });
    return true;
  } catch (err) {
    log.warn('Answer-everything notice failed', { chat: idTag(event.platformId), err });
    return false;
  }
}
