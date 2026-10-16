/**
 * Which WhatsApp a Miroflow install talks through (WHATSAPP_CHANNEL in .env,
 * switched from the admin panel):
 *
 * - `api`: the official Business API. People reach Miro through the web
 *   channel, one conversation per person (`waphone_<digits>`); the Miroflow
 *   control plane sends the replies through SamparkkSetu.
 * - `linked`: the number as a linked device (the whatsapp channel).
 *
 * Reminders and watches belong to the chat that set them up, which may be on
 * the other channel after a switch. `crossRoute` re-addresses such a send to
 * the same person on the channel in use, so nothing set up before a switch is
 * lost. Groups only exist on a linked device: a group send in `api` mode is
 * dropped (the Business API cannot post into an ordinary WhatsApp group).
 *
 * Unset (every non-Miroflow install): no re-routing at all.
 */
import { getDb } from './db/connection.js';
import { readEnvFile } from './env.js';

export type WaChannel = 'api' | 'linked';

export function waChannel(): WaChannel | null {
  const v = process.env.WHATSAPP_CHANNEL || readEnvFile(['WHATSAPP_CHANNEL']).WHATSAPP_CHANNEL;
  return v === 'api' || v === 'linked' ? v : null;
}

const WA_THREAD = /^waphone_(\d{8,15})$/;
const PHONE_JID = /^(\d{8,15})@s\.whatsapp\.net$/;

export type Route = { channel_type: string; platform_id: string; thread_id: string | null };

/** This agent group's official-WhatsApp web key (`web:wa...`), if it has one. */
export function waWebPlatformFor(agentGroupId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT mg.platform_id AS platform_id FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mga.agent_group_id = ? AND mg.channel_type = 'web' AND mg.platform_id LIKE 'web:wa%'
        ORDER BY mg.created_at DESC LIMIT 1`,
    )
    .get(agentGroupId) as { platform_id: string } | undefined;
  return row?.platform_id ?? null;
}

/**
 * Where a send should really go under the current mode: a new route, 'drop'
 * (a group, while on the Business API), or null to leave it as addressed.
 */
export function crossRoute(
  msg: Route,
  agentGroupId: string,
  mode: WaChannel | null = waChannel(),
  waPlatform: (agentGroupId: string) => string | null = waWebPlatformFor,
): Route | 'drop' | null {
  if (mode === 'linked' && msg.channel_type === 'web') {
    const m = WA_THREAD.exec(msg.thread_id ?? '');
    if (m) return { channel_type: 'whatsapp', platform_id: `${m[1]}@s.whatsapp.net`, thread_id: null };
    return null;
  }
  if (mode === 'api' && msg.channel_type === 'whatsapp') {
    if (msg.platform_id.endsWith('@g.us')) return 'drop';
    const m = PHONE_JID.exec(msg.platform_id);
    const platform = m ? waPlatform(agentGroupId) : null;
    if (m && platform) return { channel_type: 'web', platform_id: platform, thread_id: `waphone_${m[1]}` };
    return null;
  }
  return null;
}
