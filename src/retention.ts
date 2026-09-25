/**
 * Retention sweep - deletes personal data once it is older than the install's
 * retention periods (DPDP: keep it only as long as it is needed). Runs once a
 * day, first run 10 minutes after start. Every period is an env setting read
 * in config.ts; 0 or an empty value turns that part off.
 *
 *   NANOCLAW_MESSAGE_RETENTION_DAYS (365)
 *     - messages_in rows older than N days that are finished (completed /
 *       failed) or are unanswered context (trigger=0, never going to wake the
 *       agent). Kept: anything still due or in flight, every pending/paused
 *       scheduled task, completed rows still carrying a recurrence (the
 *       scheduler clones the next run from them), and the newest row so seq
 *       numbers never go backwards.
 *     - messages_out rows older than N days that were delivered (or gave up),
 *       with their `delivered` and processing_ack bookkeeping. Only while no
 *       container is running or starting for the session: outbound.db has
 *       exactly one writer, and that is the container whenever it is up.
 *     - inbox/<messageId>/ attachment dirs of deleted messages, and stray
 *       inbox/outbox dirs older than N days with no message row.
 *     - groups/<folder>/conversations/*.md transcript archives and
 *       groups/<folder>/tasks/*.md task run logs not modified for N days.
 *     usage_log (token counts only) is never touched.
 *   NANOCLAW_ROTATED_TRANSCRIPT_DAYS (30)
 *     `<id>.jsonl.rotated-<ms>` Claude transcripts moved aside by the
 *     agent-runner's size/age rotation, N days after the rotation. The live
 *     .jsonl the agent resumes from is never touched.
 *   NANOCLAW_WEB_SESSION_RETENTION_DAYS (30)
 *     Website-widget conversations with no visitor message for N days are
 *     removed entirely: session folder, its Claude transcripts, the sessions
 *     row and its pending questions/approvals, and the `web:<conversation>`
 *     users row when nothing else needs it. A returning visitor gets a fresh
 *     session the normal way (the router creates one when none exists).
 *   NANOCLAW_WA_SENT_RETENTION_DAYS (14)
 *     store/wa-sent/* copies of sent WhatsApp messages (kept only so Baileys
 *     can answer decryption-retry requests), by mtime.
 *   NANOCLAW_LOG_RETENTION_DAYS (30)
 *     logs/nanoclaw.log and nanoclaw.error.log are written by launchd/systemd
 *     redirecting stdout/stderr with O_APPEND. Each sweep copies a non-empty
 *     log to `<name>.<YYYYMMDD-HHMMSS>` and truncates the original in place
 *     (copy-truncate): O_APPEND writers keep writing at the new end, so no
 *     restart and no sparse file. Lines written between the copy and the
 *     truncate (microseconds) are lost. Rotated copies older than N days are
 *     deleted.
 *
 * Only counts are logged, never ids, names or text.
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import {
  GROUPS_DIR,
  LOG_RETENTION_DAYS,
  LOGS_DIR,
  MESSAGE_RETENTION_DAYS,
  ROTATED_TRANSCRIPT_DAYS,
  STORE_DIR,
  WA_SENT_RETENTION_DAYS,
  WEB_SESSION_RETENTION_DAYS,
} from './config.js';
import { isContainerBusy } from './container-runner.js';
import { getDb, hasTable } from './db/connection.js';
import { log } from './log.js';
import {
  inboundDbPath,
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  outboundDbPath,
  sessionDir,
  sessionsBaseDir,
} from './session-manager.js';
import { isUserReferenced } from './tenant-purge.js';
import type { Session } from './types.js';

const DAY_MS = 86_400_000;
const FIRST_RUN_DELAY_MS = 10 * 60_000;
const INTERVAL_MS = DAY_MS;
const CHUNK = 500;
const LOG_FILES = ['nanoclaw.log', 'nanoclaw.error.log'];
const ROTATED_RE = /\.jsonl\.rotated-(\d+)$/;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export interface RetentionOptions {
  messageDays: number;
  rotatedTranscriptDays: number;
  webSessionDays: number;
  waSentDays: number;
  logDays: number;
  now: number;
}

export interface RetentionResult {
  messagesIn: number;
  messagesOut: number;
  sessionsWithDeletions: number;
  sessionsSkippedBusy: number;
  attachmentDirs: number;
  archives: number;
  rotatedTranscripts: number;
  webSessions: number;
  webUsers: number;
  waSent: number;
  logsRotated: number;
  logsDeleted: number;
}

function defaults(): RetentionOptions {
  return {
    messageDays: MESSAGE_RETENTION_DAYS,
    rotatedTranscriptDays: ROTATED_TRANSCRIPT_DAYS,
    webSessionDays: WEB_SESSION_RETENTION_DAYS,
    waSentDays: WA_SENT_RETENTION_DAYS,
    logDays: LOG_RETENTION_DAYS,
    now: Date.now(),
  };
}

function emptyResult(): RetentionResult {
  return {
    messagesIn: 0,
    messagesOut: 0,
    sessionsWithDeletions: 0,
    sessionsSkippedBusy: 0,
    attachmentDirs: 0,
    archives: 0,
    rotatedTranscripts: 0,
    webSessions: 0,
    webUsers: 0,
    waSent: 0,
    logsRotated: 0,
    logsDeleted: 0,
  };
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function deleteIn(db: Database.Database, table: string, column: string, ids: string[]): number {
  let n = 0;
  for (const part of chunks(ids)) {
    n += db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${part.map(() => '?').join(',')})`).run(...part).changes;
  }
  return n;
}

function safeLstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Remove a file, dir or symlink (never follows a symlink). */
function removeEntry(p: string): boolean {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Delete entries of `dir` whose own mtime is before `cutoffMs` and that pass `filter`. */
function deleteOldEntries(dir: string, cutoffMs: number, filter: (name: string, st: fs.Stats) => boolean): number {
  let n = 0;
  for (const name of listDir(dir)) {
    const p = path.join(dir, name);
    const st = safeLstat(p);
    if (!st || st.mtimeMs >= cutoffMs || !filter(name, st)) continue;
    if (removeEntry(p)) n++;
  }
  return n;
}

// ── messages ──

/** Rows of messages_in that retention may delete. See the header for the rules. */
const EXPIRED_IN_SQL = `
  SELECT id FROM messages_in
   WHERE datetime(timestamp) < datetime(?)
     AND (seq IS NULL OR seq < (SELECT MAX(seq) FROM messages_in))
     AND recurrence IS NULL
     AND (status IN ('completed', 'failed')
          OR (status = 'pending' AND trigger = 0 AND kind != 'task'))`;

const EXPIRED_OUT_SQL = `
  SELECT id FROM messages_out
   WHERE datetime(timestamp) < datetime(?)
     AND (seq IS NULL OR seq < (SELECT MAX(seq) FROM messages_out))`;

/** Apply message retention to one session. Exported for tests. */
export function sweepSessionMessages(session: Session, cutoffMs: number, result: RetentionResult): void {
  const agentGroupId = session.agent_group_id;
  if (!fs.existsSync(inboundDbPath(agentGroupId, session.id))) return;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const busy = isContainerBusy(session.id);
  if (busy) result.sessionsSkippedBusy++;
  const dir = sessionDir(agentGroupId, session.id);

  let deletedIn: string[] = [];
  let deletedOut: string[] = [];
  const inDb = openInboundDb(agentGroupId, session.id);
  try {
    inDb.pragma('secure_delete = ON');
    deletedIn = (inDb.prepare(EXPIRED_IN_SQL).all(cutoffIso) as Array<{ id: string }>).map((r) => r.id);
    if (deletedIn.length > 0) {
      inDb.transaction(() => deleteIn(inDb, 'messages_in', 'id', deletedIn))();
      result.messagesIn += deletedIn.length;
    }

    // outbound.db belongs to the container while it runs. Delivered rows only:
    // the delivery poll reads messages_out and `delivered` together, so an
    // undelivered row must never disappear from under it.
    if (!busy && fs.existsSync(outboundDbPath(agentGroupId, session.id))) {
      const delivered = new Set(
        (inDb.prepare('SELECT message_out_id FROM delivered').all() as Array<{ message_out_id: string }>).map(
          (r) => r.message_out_id,
        ),
      );
      const outDb = openOutboundDbRw(agentGroupId, session.id);
      try {
        outDb.pragma('secure_delete = ON');
        deletedOut = (outDb.prepare(EXPIRED_OUT_SQL).all(cutoffIso) as Array<{ id: string }>)
          .map((r) => r.id)
          .filter((id) => delivered.has(id));
        outDb.transaction(() => {
          if (deletedOut.length > 0) deleteIn(outDb, 'messages_out', 'id', deletedOut);
          if (deletedIn.length > 0) deleteIn(outDb, 'processing_ack', 'message_id', deletedIn);
        })();
      } finally {
        outDb.close();
      }
      if (deletedOut.length > 0) {
        inDb.transaction(() => deleteIn(inDb, 'delivered', 'message_out_id', deletedOut))();
        result.messagesOut += deletedOut.length;
      }
    }

    // Attachments: dirs of the rows just deleted, plus old dirs with no row.
    const gone = new Set(deletedIn);
    const hasRow = inDb.prepare('SELECT 1 FROM messages_in WHERE id = ?');
    for (const name of listDir(path.join(dir, 'inbox'))) {
      const p = path.join(dir, 'inbox', name);
      const st = safeLstat(p);
      if (!st) continue;
      const expired = gone.has(name) || (st.mtimeMs < cutoffMs && hasRow.get(name) === undefined);
      if (expired && removeEntry(p)) result.attachmentDirs++;
    }
  } finally {
    inDb.close();
  }

  // outbox/ is container-writable and normally emptied on delivery; only
  // clear leftovers while the container is down.
  if (!busy) {
    let outIds: Set<string> | null = null;
    try {
      const outDb = openOutboundDb(agentGroupId, session.id);
      try {
        outIds = new Set(
          (outDb.prepare('SELECT id FROM messages_out').all() as Array<{ id: string }>).map((r) => r.id),
        );
      } finally {
        outDb.close();
      }
    } catch {
      outIds = null; // no outbound.db yet - nothing to compare against, leave outbox alone
    }
    if (outIds) {
      const known = outIds;
      result.attachmentDirs += deleteOldEntries(path.join(dir, 'outbox'), cutoffMs, (name) => !known.has(name));
    }
  }

  if (deletedIn.length > 0 || deletedOut.length > 0) result.sessionsWithDeletions++;
}

/** conversations/*.md archives and tasks/*.md run logs untouched for N days. */
function sweepGroupArchives(cutoffMs: number, result: RetentionResult): void {
  const rows = getDb().prepare('SELECT folder FROM agent_groups').all() as Array<{ folder: string }>;
  for (const { folder } of rows) {
    if (!SAFE_NAME.test(folder)) continue;
    for (const sub of ['conversations', 'tasks']) {
      result.archives += deleteOldEntries(
        path.join(GROUPS_DIR, folder, sub),
        cutoffMs,
        (name, st) => name.endsWith('.md') && (st.isFile() || st.isSymbolicLink()),
      );
    }
  }
}

// ── transcripts ──

/** Delete `.jsonl.rotated-<ms>` transcripts rotated before the cutoff. */
function sweepRotatedTranscripts(cutoffMs: number, result: RetentionResult): void {
  for (const group of listDir(sessionsBaseDir())) {
    const projects = path.join(sessionsBaseDir(), group, '.claude-shared', 'projects');
    for (const project of listDir(projects)) {
      const dir = path.join(projects, project);
      for (const name of listDir(dir)) {
        const m = ROTATED_RE.exec(name);
        if (!m) continue;
        const p = path.join(dir, name);
        const st = safeLstat(p);
        if (!st || st.isDirectory()) continue;
        const rotatedAt = Number(m[1]) || st.mtimeMs;
        if (rotatedAt < cutoffMs && removeEntry(p)) result.rotatedTranscripts++;
      }
    }
  }
}

/**
 * Claude transcripts (live and rotated) for the SDK sessions this NanoClaw
 * session resumed from. The ids come from the container-written
 * session_state table, so they are validated before touching the filesystem.
 */
function deleteSessionTranscripts(agentGroupId: string, sessionId: string): void {
  let ids: string[] = [];
  try {
    const outDb = openOutboundDb(agentGroupId, sessionId);
    try {
      ids = (
        outDb.prepare("SELECT value FROM session_state WHERE key LIKE 'continuation:%'").all() as Array<{
          value: string;
        }>
      )
        .map((r) => r.value)
        .filter((v) => SAFE_NAME.test(v));
    } finally {
      outDb.close();
    }
  } catch {
    return;
  }
  if (ids.length === 0) return;
  const projects = path.join(sessionsBaseDir(), agentGroupId, '.claude-shared', 'projects');
  for (const project of listDir(projects)) {
    const dir = path.join(projects, project);
    for (const name of listDir(dir)) {
      if (ids.some((id) => name === id || name === `${id}.jsonl` || name.startsWith(`${id}.jsonl.rotated-`))) {
        removeEntry(path.join(dir, name));
      }
    }
  }
}

// ── web sessions ──

/** Remove website-widget conversations idle since before the cutoff. Exported for tests. */
export function sweepWebSessions(cutoffMs: number, result: RetentionResult): void {
  const db = getDb();
  const cutoffIso = new Date(cutoffMs).toISOString();
  const expired = db
    .prepare(
      `SELECT s.* FROM sessions s
         JOIN messaging_groups mg ON mg.id = s.messaging_group_id
        WHERE mg.channel_type = 'web'
          AND s.thread_id IS NOT NULL
          AND COALESCE(s.last_active, s.created_at) < ?`,
    )
    .all(cutoffIso) as Session[];
  if (expired.length === 0) return;
  db.pragma('secure_delete = ON');
  const hasApprovals = hasTable(db, 'pending_approvals');

  for (const s of expired) {
    if (isContainerBusy(s.id)) {
      result.sessionsSkippedBusy++;
      continue;
    }
    deleteSessionTranscripts(s.agent_group_id, s.id);
    db.transaction(() => {
      db.prepare('DELETE FROM pending_questions WHERE session_id = ?').run(s.id);
      if (hasApprovals) db.prepare('DELETE FROM pending_approvals WHERE session_id = ?').run(s.id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
      // The visitor's users row (`web:<conversation>`), unless another
      // session with the same conversation id or a role/membership needs it.
      const userId = `web:${s.thread_id}`;
      const stillUsed =
        db.prepare('SELECT 1 FROM sessions WHERE thread_id = ? LIMIT 1').get(s.thread_id) !== undefined ||
        isUserReferenced(db, userId);
      if (!stillUsed) result.webUsers += db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes;
    })();
    removeEntry(sessionDir(s.agent_group_id, s.id));
    result.webSessions++;
  }
}

// ── wa-sent and logs ──

function sweepWaSent(cutoffMs: number, result: RetentionResult): void {
  result.waSent += deleteOldEntries(path.join(STORE_DIR, 'wa-sent'), cutoffMs, (_n, st) => st.isFile());
}

function stamp(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Copy-truncate the service logs, then drop rotated copies older than the cutoff. Exported for tests. */
export function rotateLogs(now: number, cutoffMs: number, result: RetentionResult): void {
  for (const name of LOG_FILES) {
    const file = path.join(LOGS_DIR, name);
    const st = safeLstat(file);
    if (!st || !st.isFile() || st.size === 0) continue;
    try {
      fs.copyFileSync(file, `${file}.${stamp(now)}`);
      fs.truncateSync(file, 0);
      result.logsRotated++;
    } catch (err) {
      log.warn('Retention: log rotation failed', { file: name, err });
    }
  }
  result.logsDeleted += deleteOldEntries(
    LOGS_DIR,
    cutoffMs,
    (name, st) => st.isFile() && LOG_FILES.some((f) => name.startsWith(`${f}.`)),
  );
}

// ── driver ──

/** Run every enabled part of the sweep once. */
export async function runRetentionSweep(overrides: Partial<RetentionOptions> = {}): Promise<RetentionResult> {
  const o = { ...defaults(), ...overrides };
  const result = emptyResult();
  const cutoff = (days: number) => o.now - days * DAY_MS;
  const step = async (name: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log.error('Retention sweep step failed', { step: name, err });
    }
    // Yield so channel adapters and delivery keep flowing between steps.
    await new Promise((r) => setImmediate(r));
  };

  if (o.webSessionDays > 0) await step('web-sessions', () => sweepWebSessions(cutoff(o.webSessionDays), result));
  if (o.messageDays > 0) {
    const sessions = getDb().prepare('SELECT * FROM sessions').all() as Session[];
    for (const s of sessions) {
      await step('messages', () => sweepSessionMessages(s, cutoff(o.messageDays), result));
    }
    await step('archives', () => sweepGroupArchives(cutoff(o.messageDays), result));
  }
  if (o.rotatedTranscriptDays > 0)
    await step('rotated-transcripts', () => sweepRotatedTranscripts(cutoff(o.rotatedTranscriptDays), result));
  if (o.waSentDays > 0) await step('wa-sent', () => sweepWaSent(cutoff(o.waSentDays), result));
  if (o.logDays > 0) await step('logs', () => rotateLogs(o.now, cutoff(o.logDays), result));

  log.info('Retention sweep done', { ...result });
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startRetentionSweep(): void {
  if (timer) return;
  const tick = () => {
    runRetentionSweep()
      .catch((err) => log.error('Retention sweep failed', { err }))
      .finally(() => {
        if (!timer) return; // stopped meanwhile
        timer = setTimeout(tick, INTERVAL_MS);
        timer.unref?.();
      });
  };
  timer = setTimeout(tick, FIRST_RUN_DELAY_MS);
  timer.unref?.();
}

export function stopRetentionSweep(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
