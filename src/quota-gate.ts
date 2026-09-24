/**
 * Quota gate — stops the agent from being woken once the install's plan limit
 * is reached, so no API spend happens past 100%.
 *
 * The state is decided outside the engine (SaaS control plane → node-agent)
 * and written to `data/quota.json`:
 *
 *   { "state": "ok" | "warn" | "blocked", "period_end": "<ISO-8601 UTC>" }
 *
 * Fail-open: a missing, unreadable, or malformed file means `ok`, so an
 * outage of the control plane never silences every bot.
 *
 * When blocked, inbound messages are still stored (trigger=0, "context only")
 * so history and legal export stay complete; the container is simply not
 * woken. The owner gets one "limit reached" DM per period — never the
 * customers in the chat. The host records that notice in its own file
 * (`data/quota-notice.json`) so quota.json keeps a single writer.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import { pickApprovalDelivery, pickApprover } from './modules/approvals/primitive.js';

export type QuotaStateName = 'ok' | 'warn' | 'blocked';

export interface QuotaState {
  state: QuotaStateName;
  periodEnd: string | null;
}

const OK: QuotaState = { state: 'ok', periodEnd: null };

export const QUOTA_NOTICE_TEXT =
  'Your monthly bot reply limit has been reached, so the bot has paused replying. ' +
  'Messages are still being saved. Upgrade your plan or add a reply pack to resume.';

export function quotaFilePath(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'quota.json');
}

function noticeFilePath(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'quota-notice.json');
}

/** Read the quota state. Never throws; anything unexpected is treated as `ok`. */
export function readQuotaState(dataDir: string = DATA_DIR): QuotaState {
  let raw: string;
  try {
    raw = fs.readFileSync(quotaFilePath(dataDir), 'utf-8');
  } catch {
    return OK;
  }
  try {
    const parsed = JSON.parse(raw) as { state?: unknown; period_end?: unknown };
    const state = parsed.state;
    if (state !== 'ok' && state !== 'warn' && state !== 'blocked') {
      log.warn('quota.json has an unknown state — treating as ok', { state: String(state) });
      return OK;
    }
    const periodEnd = typeof parsed.period_end === 'string' ? parsed.period_end : null;
    // A block whose period has already ended is stale (the control plane
    // missed the rollover) — fail open rather than stay silent forever.
    if (state === 'blocked' && periodEnd && Date.parse(periodEnd) <= Date.now()) {
      return { state: 'ok', periodEnd };
    }
    return { state, periodEnd };
  } catch {
    log.warn('quota.json is not valid JSON — treating as ok');
    return OK;
  }
}

export function isQuotaBlocked(dataDir: string = DATA_DIR): boolean {
  return readQuotaState(dataDir).state === 'blocked';
}

/**
 * True if the owner notice for this period has not been sent yet. Keyed by
 * period_end so a new period (or a missing period_end) re-arms it.
 */
export function shouldSendQuotaNotice(periodEnd: string | null, dataDir: string = DATA_DIR): boolean {
  try {
    const sent = JSON.parse(fs.readFileSync(noticeFilePath(dataDir), 'utf-8')) as { period_end?: string | null };
    return (sent.period_end ?? null) !== periodEnd;
  } catch {
    return true;
  }
}

export function markQuotaNoticeSent(periodEnd: string | null, dataDir: string = DATA_DIR): void {
  const file = noticeFilePath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ period_end: periodEnd, sent_at: new Date().toISOString() }) + '\n');
  fs.renameSync(tmp, file);
}

let noticeInFlight = false;

/**
 * DM the owner (or the group's admin) once per period that the limit is hit.
 * Best-effort: failures are logged and retried on the next blocked message.
 */
export async function notifyOwnerQuotaReached(
  agentGroupId: string,
  originChannelType: string,
  dataDir: string = DATA_DIR,
): Promise<void> {
  const { periodEnd } = readQuotaState(dataDir);
  if (noticeInFlight || !shouldSendQuotaNotice(periodEnd, dataDir)) return;
  noticeInFlight = true;
  try {
    const target = await pickApprovalDelivery(pickApprover(agentGroupId), originChannelType);
    const adapter = getDeliveryAdapter();
    if (!target || !adapter) {
      log.warn('Quota reached but no owner DM is reachable', { agentGroupId });
      return;
    }
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat',
      JSON.stringify({ text: QUOTA_NOTICE_TEXT }),
    );
    markQuotaNoticeSent(periodEnd, dataDir);
    log.info('Quota-reached notice sent to owner', { agentGroupId, userId: target.userId });
  } catch (err) {
    log.error('Failed to send quota-reached notice', { agentGroupId, err });
  } finally {
    noticeInFlight = false;
  }
}
