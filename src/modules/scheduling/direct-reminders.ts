/**
 * Plain reminders (`ncl tasks create --message`): when due, the host posts the
 * saved text straight to the chat the reminder was set in, without waking the
 * agent. A reminder like "take the i-cards" then costs no AI run at all.
 *
 * The row is marked completed like any fired task, so recurrence fan-out and
 * the run log work as usual. If the chat can't be resolved or the channel is
 * down, the row is left alone: the next sweep retries, and if the chat can
 * never be resolved the agent still gets it the normal way (its prompt says
 * to send the text as written).
 */
import type Database from 'better-sqlite3';

import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { getDestinationByName } from '../agent-to-agent/db/agent-destinations.js';
import { plainReminderText } from './create.js';
import { appendRunLog } from './run-log.js';

interface DueRow {
  id: string;
  series_id: string | null;
  content: string;
}

export async function deliverDuePlainReminders(inDb: Database.Database, agentGroupId: string): Promise<number> {
  const rows = inDb
    .prepare(
      `SELECT id, series_id, content FROM messages_in
        WHERE kind = 'task' AND status = 'pending'
          AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
          AND (content LIKE '%"message":%' OR content LIKE '%"prompt":"%eminder%')`,
    )
    .all() as DueRow[];
  let sent = 0;
  for (const row of rows) {
    let content: { message?: unknown; prompt?: unknown; originDestination?: unknown; script?: unknown };
    try {
      content = JSON.parse(row.content);
    } catch {
      continue;
    }
    // Older rows (created before --message) still go direct when the prompt is just the reminder text.
    if (typeof content.message !== 'string' || !content.message) {
      const plain = typeof content.prompt === 'string' ? plainReminderText(content.prompt, content.script as string | null) : null;
      if (!plain) continue;
      content.message = plain;
    }
    if (content.script) continue;
    const text = content.message as string;
    if (typeof content.originDestination !== 'string') continue;
    const dest = getDestinationByName(agentGroupId, content.originDestination);
    if (!dest || dest.target_type !== 'channel') continue;
    const mg = getMessagingGroup(dest.target_id);
    if (!mg) continue;
    const adapter = getChannelAdapterExact(mg.channel_type);
    if (!adapter || (typeof adapter.isConnected === 'function' && !adapter.isConnected())) continue; // retry next sweep

    // Claim first, so a slow send can never be fired twice by the next tick.
    const claimed = inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ? AND status = 'pending'").run(row.id).changes;
    if (!claimed) continue;
    try {
      await adapter.deliver(mg.platform_id, null, { kind: 'chat', content: { text } });
      sent++;
      try {
        appendRunLog(agentGroupId, row.series_id ?? row.id, `Posted the reminder directly (no agent run): ${text.slice(0, 120)}`);
      } catch {
        /* the log is best effort */
      }
    } catch (err) {
      // Put it back for the next sweep.
      inDb.prepare("UPDATE messages_in SET status = 'pending' WHERE id = ?").run(row.id);
      log.warn('Plain reminder delivery failed; will retry', { taskId: row.id, err });
    }
  }
  return sent;
}
