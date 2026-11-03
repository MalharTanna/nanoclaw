/**
 * The Signal library under Baileys prints whole session records with
 * console.info/warn ("Closing session: SessionEntry { ... privKey ... }").
 * Those carry the keys that encrypt chats, and console output lands in
 * logs/nanoclaw.log. Keep the message, hide the record. Imported first by
 * src/index.ts so it is in place before anything logs.
 */
const HIDDEN = '[session details hidden]';
const SESSION_FIELDS = ['currentRatchet', 'indexInfo', '_chains', 'registrationId', 'pendingPreKey'];

export function isSessionRecord(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  if ((v as object).constructor?.name === 'SessionEntry' || (v as object).constructor?.name === 'SessionRecord') return true;
  return SESSION_FIELDS.filter((k) => k in (v as object)).length >= 2;
}

export function redactConsoleArgs(args: unknown[]): unknown[] {
  return args.map((a) => (isSessionRecord(a) ? HIDDEN : a));
}

export function installConsoleRedaction(target: Console = console): void {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => original(...redactConsoleArgs(args));
  }
}

installConsoleRedaction();
