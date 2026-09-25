/**
 * Short, non-reversible stand-ins for personal identifiers in logs.
 *
 * Chat JIDs, phone-number user ids and web conversation ids are personal data
 * (DPDP). Logs keep a keyed hash instead: `#` + 10 hex chars of
 * HMAC-SHA256(salt, id). The same id always maps to the same tag, so an
 * operator can still follow one chat through the log, and can check a
 * specific id with `pnpm exec tsx -e` + idTag() on this install. A plain hash
 * of a phone number is trivially brute-forced, hence the per-install salt in
 * data/.log-id-salt (0600). If data/ doesn't exist yet (tests, first boot
 * before the DB) the salt lives in memory for this process only.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

let salt: Buffer | null = null;

function loadSalt(): Buffer {
  if (salt) return salt;
  const file = path.join(DATA_DIR, '.log-id-salt');
  try {
    salt = Buffer.from(fs.readFileSync(file, 'utf-8').trim(), 'hex');
    if (salt.length >= 16) return salt;
  } catch {
    // missing or unreadable - create below
  }
  salt = crypto.randomBytes(32);
  if (fs.existsSync(DATA_DIR)) {
    try {
      fs.writeFileSync(file, salt.toString('hex') + '\n', { mode: 0o600, flag: 'w' });
    } catch {
      // read-only data dir: keep the in-memory salt
    }
  }
  return salt;
}

/** `#` + 10 hex chars standing in for an identifier; null/empty passes through as null. */
export function idTag(id: string | null | undefined): string | null {
  if (!id) return null;
  return '#' + crypto.createHmac('sha256', loadSalt()).update(id).digest('hex').slice(0, 10);
}
