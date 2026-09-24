/**
 * Quota gate — stops the agent from being woken once a plan limit is reached,
 * so no API spend happens past 100%.
 *
 * The state is decided outside the engine (SaaS control plane → node-agent),
 * which owns each customer's cap. Two scopes:
 *
 *   data/quota/<agentGroupId>.json  — one tenant's bot (shared-number installs)
 *   data/quota.json                 — the whole install (dedicated installs)
 *
 *   { "state": "ok" | "warn" | "blocked", "period_end": "<ISO-8601 UTC>" }
 *
 * The per-group file wins when present. Fail-open: a missing, unreadable, or
 * malformed file means `ok`, so a control-plane outage never silences bots.
 *
 * When blocked, inbound messages are still stored (trigger=0, "context only")
 * so history and legal export stay complete; the container is simply not
 * woken. The owner gets one "limit reached" DM per period — never the
 * customers in the chat. For a per-group block that means ONLY that tenant's
 * scoped admins (never the install's global owner, who may be another
 * business entirely on a shared number). The host records the notice in its
 * own file next to the state file, so the state file keeps a single writer.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import { pickApprovalDelivery, pickApprover } from './modules/approvals/primitive.js';
import { getAdminsOfAgentGroup } from './modules/permissions/db/user-roles.js';

export type QuotaStateName = 'ok' | 'warn' | 'blocked';

export interface QuotaState {
  state: QuotaStateName;
  periodEnd: string | null;
  scope: 'group' | 'install';
}

export const QUOTA_NOTICE_TEXT =
  'Your monthly bot reply limit has been reached, so the bot has paused replying. ' +
  'Messages are still being saved. Upgrade your plan or add a reply pack to resume.';

/** Agent group ids are generated (`ag-…`); anything else is refused so it can't escape the dir. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function quotaFilePath(dataDir: string = DATA_DIR, agentGroupId?: string | null): string {
  if (agentGroupId) {
    if (!SAFE_ID.test(agentGroupId)) throw new Error('unsafe agent group id');
    return path.join(dataDir, 'quota', `${agentGroupId}.json`);
  }
  return path.join(dataDir, 'quota.json');
}

function noticeFilePath(dataDir: string, scope: QuotaState['scope'], agentGroupId?: string | null): string {
  return scope === 'group' && agentGroupId
    ? path.join(dataDir, 'quota', `${agentGroupId}.notice.json`)
    : path.join(dataDir, 'quota-notice.json');
}

function parseState(raw: string, scope: QuotaState['scope']): QuotaState {
  try {
    const parsed = JSON.parse(raw) as { state?: unknown; period_end?: unknown };
    const state = parsed.state;
    if (state !== 'ok' && state !== 'warn' && state !== 'blocked') {
      log.warn('Quota file has an unknown state — treating as ok', { scope, state: String(state) });
      return { state: 'ok', periodEnd: null, scope };
    }
    const periodEnd = typeof parsed.period_end === 'string' ? parsed.period_end : null;
    // A block whose period has already ended is stale (the control plane
    // missed the rollover) — fail open rather than stay silent forever.
    if (state === 'blocked' && periodEnd && Date.parse(periodEnd) <= Date.now()) {
      return { state: 'ok', periodEnd, scope };
    }
    return { state, periodEnd, scope };
  } catch {
    log.warn('Quota file is not valid JSON — treating as ok', { scope });
    return { state: 'ok', periodEnd: null, scope };
  }
}

/** Read the quota state for an agent group (falls back to the install). Never throws. */
export function readQuotaState(agentGroupId?: string | null, dataDir: string = DATA_DIR): QuotaState {
  if (agentGroupId && SAFE_ID.test(agentGroupId)) {
    try {
      return parseState(fs.readFileSync(quotaFilePath(dataDir, agentGroupId), 'utf-8'), 'group');
    } catch {
      // No per-group file — fall through to the install-wide state.
    }
  }
  try {
    return parseState(fs.readFileSync(quotaFilePath(dataDir), 'utf-8'), 'install');
  } catch {
    return { state: 'ok', periodEnd: null, scope: 'install' };
  }
}

export function isQuotaBlocked(agentGroupId?: string | null, dataDir: string = DATA_DIR): boolean {
  return readQuotaState(agentGroupId, dataDir).state === 'blocked';
}

/**
 * True if the owner notice for this period has not been sent yet. Keyed by
 * period_end so a new period (or a missing period_end) re-arms it.
 */
export function shouldSendQuotaNotice(
  periodEnd: string | null,
  dataDir: string = DATA_DIR,
  scope: QuotaState['scope'] = 'install',
  agentGroupId?: string | null,
): boolean {
  try {
    const sent = JSON.parse(fs.readFileSync(noticeFilePath(dataDir, scope, agentGroupId), 'utf-8')) as {
      period_end?: string | null;
    };
    return (sent.period_end ?? null) !== periodEnd;
  } catch {
    return true;
  }
}

export function markQuotaNoticeSent(
  periodEnd: string | null,
  dataDir: string = DATA_DIR,
  scope: QuotaState['scope'] = 'install',
  agentGroupId?: string | null,
): void {
  const file = noticeFilePath(dataDir, scope, agentGroupId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ period_end: periodEnd, sent_at: new Date().toISOString() }) + '\n');
  fs.renameSync(tmp, file);
}

const noticeInFlight = new Set<string>();

/**
 * DM the right person once per period that the limit is hit. Best-effort:
 * failures are logged and retried on the next blocked message.
 */
export async function notifyOwnerQuotaReached(
  agentGroupId: string,
  originChannelType: string,
  dataDir: string = DATA_DIR,
): Promise<void> {
  const { periodEnd, scope } = readQuotaState(agentGroupId, dataDir);
  const key = scope === 'group' ? `group:${agentGroupId}` : 'install';
  if (noticeInFlight.has(key) || !shouldSendQuotaNotice(periodEnd, dataDir, scope, agentGroupId)) return;
  noticeInFlight.add(key);
  try {
    const approvers =
      scope === 'group' ? getAdminsOfAgentGroup(agentGroupId).map((r) => r.user_id) : pickApprover(agentGroupId);
    const target = approvers.length > 0 ? await pickApprovalDelivery(approvers, originChannelType) : null;
    const adapter = getDeliveryAdapter();
    if (!target || !adapter) {
      log.warn('Quota reached but no owner DM is reachable', { agentGroupId, scope });
      return;
    }
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat',
      JSON.stringify({ text: QUOTA_NOTICE_TEXT }),
    );
    markQuotaNoticeSent(periodEnd, dataDir, scope, agentGroupId);
    log.info('Quota-reached notice sent', { agentGroupId, scope, userId: target.userId });
  } catch (err) {
    log.error('Failed to send quota-reached notice', { agentGroupId, err });
  } finally {
    noticeInFlight.delete(key);
  }
}
