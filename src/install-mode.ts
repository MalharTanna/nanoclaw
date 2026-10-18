/**
 * How a Miroflow install uses its WhatsApp number (.env):
 *
 * - `shared` (NANOCLAW_SHARED_NUMBER=true): one Miroflow number serves many
 *   businesses; chats are linked with join codes; the bot phone's own
 *   messages are never requests.
 * - `own` (NANOCLAW_OWN_NUMBER=true): Miro is a linked device on one
 *   business's own number. The owner's own messages (fromMe) count when they
 *   address Miro; chats nobody turned on are ignored silently; personal chats
 *   only from allowed numbers; replies carry the assistant's name.
 * - `personal` (neither): a plain NanoClaw install, as upstream.
 *
 * Both Miroflow modes are tenant-locked (src/tenant-lock.ts) and keep the
 * WhatsApp safety limits (src/wa-limits.ts).
 */
import { readEnvFile } from './env.js';

export type InstallMode = 'shared' | 'own' | 'personal';

export function installMode(): InstallMode {
  const env = readEnvFile(['NANOCLAW_SHARED_NUMBER', 'NANOCLAW_OWN_NUMBER']);
  if ((process.env.NANOCLAW_SHARED_NUMBER || env.NANOCLAW_SHARED_NUMBER) === 'true') return 'shared';
  if ((process.env.NANOCLAW_OWN_NUMBER || env.NANOCLAW_OWN_NUMBER) === 'true') return 'own';
  return 'personal';
}

export function isOwnNumber(): boolean {
  return installMode() === 'own';
}
