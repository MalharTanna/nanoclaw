/**
 * Miroflow: the assistant is always "Miro" (ASSISTANT_NAME). A business on its
 * own number may add its own name (ASSISTANT_ALIAS, e.g. "Asha"): replies are
 * then marked "Miro (Asha):" and either name addresses the assistant.
 * Read from .env per call, so a rename applies without a restart.
 */
import { ASSISTANT_NAME } from './config.js';
import { readEnvFile } from './env.js';

export function assistantAlias(): string | null {
  const v = (process.env.ASSISTANT_ALIAS || readEnvFile(['ASSISTANT_ALIAS']).ASSISTANT_ALIAS || '').trim();
  return v && v.toLowerCase() !== ASSISTANT_NAME.toLowerCase() ? v : null;
}

/** "Miro", or "Miro (Asha)". */
export function displayName(alias: string | null = assistantAlias()): string {
  return alias ? `${ASSISTANT_NAME} (${alias})` : ASSISTANT_NAME;
}

/** The names that address the assistant: always ASSISTANT_NAME, plus the alias. */
export function assistantNames(alias: string | null = assistantAlias()): string[] {
  return alias ? [ASSISTANT_NAME, alias] : [ASSISTANT_NAME];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Either name as a whole word anywhere in the text, in any case ("Miro, hi", "ask asha"). */
export function addressesAssistant(text: string, names: string[] = assistantNames()): boolean {
  return names.some((n) => n.length >= 2 && new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(n)}(?![\\p{L}\\p{N}_])`, 'iu').test(text));
}
