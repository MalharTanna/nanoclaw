/**
 * Per-agent-group reply prefix (shared-number mode).
 *
 * On a shared bot number every tenant's bot speaks from the same WhatsApp
 * account, so each reply is prefixed with THAT tenant's assistant name
 * ("**Miro:** …"). Opt-in per install with NANOCLAW_REPLY_PREFIX=group in
 * .env; shared installs also set ASSISTANT_HAS_OWN_NUMBER=true so the
 * adapter's install-wide prefix is off. Default: unchanged behaviour.
 */
import { readEnvFile } from './env.js';

export function replyPrefixMode(): 'group' | 'off' {
  const v = process.env.NANOCLAW_REPLY_PREFIX || readEnvFile(['NANOCLAW_REPLY_PREFIX']).NANOCLAW_REPLY_PREFIX;
  return v === 'group' ? 'group' : 'off';
}

/**
 * Prefix a plain chat message's text with the assistant name. Anything that
 * isn't a simple text message (cards, edits, reactions, files-only) is
 * returned unchanged.
 */
export function withGroupPrefix(kind: string, rawContent: string, assistantName: string | null | undefined): string {
  if (kind !== 'chat' || !assistantName) return rawContent;
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return rawContent;
  }
  if (typeof content.text !== 'string' || content.text.trim() === '') return rawContent;
  if (content.type !== undefined || content.operation !== undefined) return rawContent;
  const prefix = `**${assistantName}:** `;
  if (content.text.startsWith(prefix)) return rawContent;
  return JSON.stringify({ ...content, text: prefix + content.text });
}
