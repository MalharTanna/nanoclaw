/**
 * Has this business used its assistant in this group before? True when the
 * group is wired to it now, or it has a conversation there. Conversations
 * carry over a move between numbers (scripts/agent-group-move.ts); the wiring
 * does not, so a business moved to the shared number gets its old groups back
 * without waiting for new-group join slots (src/wa-limits.ts).
 */
import { getDb } from './db/connection.js';

export function isReturningGroup(agentGroupId: string, channelType: string, platformId: string): boolean {
  try {
    const row = getDb()
      .prepare(
        `SELECT 1 FROM messaging_groups mg
          WHERE mg.channel_type = ? AND mg.platform_id = ?
            AND (EXISTS (SELECT 1 FROM messaging_group_agents a WHERE a.messaging_group_id = mg.id AND a.agent_group_id = ?)
              OR EXISTS (SELECT 1 FROM sessions s WHERE s.messaging_group_id = mg.id AND s.agent_group_id = ?))
          LIMIT 1`,
      )
      .get(channelType, platformId, agentGroupId, agentGroupId);
    return row !== undefined;
  } catch {
    return false; // no central DB (tests, tools): treat as new
  }
}
