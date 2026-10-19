/**
 * A business's own number (own-number mode): the owner turns Miro on or off
 * in a group by typing, from their own phone, "Miro start" or "Miro stop"
 * (the assistant's name, or "Miro"). Only the owner's own messages (fromMe)
 * count, so members can't switch it on.
 *
 * The request goes to the node-agent through data/link-requests.jsonl (the
 * same queue join codes use); the control plane checks the plan, turns the
 * group on and has the members' notice posted. "stop" is confirmed here
 * straight away.
 */
import fs from 'fs';

import { ASSISTANT_NAME } from './config.js';
import { assistantNames } from './assistant-names.js';
import { DATA_DIR } from './config.js';
import { getDeliveryAdapter } from './delivery.js';
import { isOwnNumber } from './install-mode.js';
import type { InboundEvent } from './channels/adapter.js';
import { linkRequestsPath } from './join-codes.js';
import { log } from './log.js';
import { idTag } from './log-redact.js';

const GROUP_JID = /^[0-9-]{10,40}@g\.us$/;

/** "Miro start" / "miro STOP" (or the assistant's own name), nothing else in the message. */
export function matchOwnerCommand(text: string | undefined, names: string | string[] = assistantNames()): 'start' | 'stop' | null {
  const m = /^\s*(.{1,40}?)\s+(start|stop)\s*[.!]?\s*$/i.exec(text ?? '');
  if (!m) return null;
  // "Miro start", "Miro, start", "Miro: stop", "@Miro stop"
  const name = m[1]!.trim().replace(/^@/, '').replace(/[,:;]+$/, '').trim().toLowerCase();
  const ok = ['miro', ...(Array.isArray(names) ? names : [names]).map((n) => n.trim().toLowerCase())];
  if (!ok.includes(name)) return null;
  return m[2]!.toLowerCase() as 'start' | 'stop';
}

export interface OwnerRequest {
  ts: string;
  kind: 'owner';
  action: 'start' | 'stop';
  channelType: string;
  platformId: string;
  instance: string;
  group?: { name?: string; size: number; community: boolean };
}

export async function maybeHandleOwnerCommand(event: InboundEvent, dataDir = DATA_DIR, now: number = Date.now(), ownNumber = isOwnNumber()): Promise<boolean> {
  if (!ownNumber || event.channelType !== 'whatsapp' || !GROUP_JID.test(event.platformId)) return false;
  let content: { text?: string; fromMe?: boolean; groupInfo?: OwnerRequest['group'] };
  try {
    content = JSON.parse(event.message.content) as typeof content;
  } catch {
    return false;
  }
  const action = matchOwnerCommand(content.text);
  if (!action) return false;
  if (content.fromMe !== true) return false; // only the owner's own phone
  const request: OwnerRequest = {
    ts: new Date(now).toISOString(),
    kind: 'owner',
    action,
    channelType: event.channelType,
    platformId: event.platformId,
    instance: event.instance ?? event.channelType,
    ...(content.groupInfo ? { group: content.groupInfo } : {}),
  };
  fs.appendFileSync(linkRequestsPath(dataDir), JSON.stringify(request) + '\n', { mode: 0o600 });
  log.info('Owner turned Miro ' + (action === 'start' ? 'on' : 'off') + ' in a group', { chat: idTag(event.platformId) });
  if (action === 'stop') {
    const adapter = getDeliveryAdapter();
    try {
      await adapter?.deliver(event.channelType, event.platformId, null, 'chat', JSON.stringify({ text: `Okay, I'm off in this group. Type "${ASSISTANT_NAME} start" to turn me back on.` }), undefined, event.instance ?? event.channelType);
    } catch (err) {
      log.warn('Stop confirmation not sent', { chat: idTag(event.platformId), err });
    }
  }
  return true;
}
