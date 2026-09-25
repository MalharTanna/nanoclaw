/**
 * Complete removal of one agent group's personal data from the central DB
 * (`ncl groups delete --id <id> --purge`), plus the shared "is this user row
 * still needed?" check the retention sweep uses for expired web visitors.
 *
 * `groups delete` alone cascades the rows that point AT the agent group
 * (wirings, sessions, roles, memberships). It leaves behind the rows that
 * describe the people and chats the group talked to: messaging_groups (chat
 * JID + name), users (phone JID + display name, one per sender ever seen),
 * user_dms, unregistered_senders. On a shared number several tenants can talk
 * to the same chat or the same person, so a row is only removed once nothing
 * that survives the delete still refers to it:
 *
 *   - a messaging group survives while any wiring, session, pending approval
 *     or channel destination still points at it;
 *   - a user survives while any role, membership, DM cache row, pending
 *     approval or dropped-message record names it, or while any other agent
 *     group's session DB holds a message from it.
 *
 * Out of scope here: files on disk (the caller removes groups/<folder> and
 * data/v2-sessions/<id>) and store/wa-sent copies, which carry no chat id and
 * are aged out by the retention sweep instead.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { hasTable } from './db/connection.js';
import { log } from './log.js';
import { sessionsBaseDir } from './session-manager.js';

export interface PurgeScope {
  /** Messaging groups this agent group was wired to or had sessions in. */
  messagingGroupIds: string[];
  /** users.id values this agent group has seen or granted. */
  candidateUserIds: Set<string>;
}

export interface PurgeCounts {
  messaging_groups: number;
  user_dms: number;
  unregistered_senders: number;
  users: number;
}

const CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/**
 * Raw sender handles found in one session's inbound.db. Mirrors the sender
 * fields the permissions module reads (senderId, sender, author.userId). The
 * returned handles are un-namespaced when the adapter sent them that way; use
 * handleMatchesUser to compare with users.id.
 */
export function senderHandlesInSession(inboundPath: string): Set<string> {
  const handles = new Set<string>();
  if (!fs.existsSync(inboundPath)) return handles;
  let db: Database.Database | null = null;
  try {
    db = new Database(inboundPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    const rows = db
      .prepare(
        `SELECT DISTINCT
           json_extract(content, '$.senderId') AS a,
           json_extract(content, '$.sender') AS b,
           json_extract(content, '$.author.userId') AS c
         FROM messages_in WHERE json_valid(content)`,
      )
      .all() as Array<{ a: unknown; b: unknown; c: unknown }>;
    for (const r of rows) {
      for (const v of [r.a, r.b, r.c]) if (typeof v === 'string' && v) handles.add(v);
    }
  } catch (err) {
    log.warn('Purge: could not read a session DB for sender ids', { err });
  } finally {
    db?.close();
  }
  return handles;
}

/** Same derivation as the permissions module: a handle with a ':' is already namespaced. */
export function handleMatchesUser(handles: Set<string>, userId: string): boolean {
  if (handles.has(userId)) return true;
  const i = userId.indexOf(':');
  return i > 0 && handles.has(userId.slice(i + 1));
}

function sessionDirsOf(agentGroupId: string): string[] {
  const base = path.join(sessionsBaseDir(), agentGroupId);
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('sess-'))
      .map((d) => path.join(base, d.name));
  } catch {
    return [];
  }
}

/** Collect what the group touched. Run BEFORE the groups-delete cascade removes the links. */
export function collectPurgeScope(db: Database.Database, agentGroupId: string): PurgeScope {
  const mg = new Set<string>();
  const add = (sql: string, ...params: unknown[]) => {
    for (const r of db.prepare(sql).all(...params) as Array<{ v: string | null }>) if (r.v) mg.add(r.v);
  };
  add('SELECT messaging_group_id AS v FROM messaging_group_agents WHERE agent_group_id = ?', agentGroupId);
  add('SELECT messaging_group_id AS v FROM sessions WHERE agent_group_id = ?', agentGroupId);
  if (hasTable(db, 'pending_channel_approvals'))
    add('SELECT messaging_group_id AS v FROM pending_channel_approvals WHERE agent_group_id = ?', agentGroupId);
  if (hasTable(db, 'pending_sender_approvals'))
    add('SELECT messaging_group_id AS v FROM pending_sender_approvals WHERE agent_group_id = ?', agentGroupId);
  const messagingGroupIds = [...mg];

  const users = new Set<string>();
  const addUsers = (sql: string, ...params: unknown[]) => {
    for (const r of db.prepare(sql).all(...params) as Array<{ v: string | null }>) if (r.v) users.add(r.v);
  };
  addUsers('SELECT user_id AS v FROM user_roles WHERE agent_group_id = ?', agentGroupId);
  addUsers('SELECT user_id AS v FROM agent_group_members WHERE agent_group_id = ?', agentGroupId);
  if (hasTable(db, 'pending_sender_approvals'))
    addUsers('SELECT sender_identity AS v FROM pending_sender_approvals WHERE agent_group_id = ?', agentGroupId);
  if (hasTable(db, 'unregistered_senders'))
    addUsers('SELECT user_id AS v FROM unregistered_senders WHERE agent_group_id = ?', agentGroupId);
  for (const ids of chunks(messagingGroupIds)) {
    const q = ids.map(() => '?').join(',');
    addUsers(`SELECT user_id AS v FROM user_dms WHERE messaging_group_id IN (${q})`, ...ids);
    if (hasTable(db, 'unregistered_senders'))
      addUsers(`SELECT user_id AS v FROM unregistered_senders WHERE messaging_group_id IN (${q})`, ...ids);
  }

  // Everyone who ever wrote in this group's sessions (the router creates a
  // users row for every sender in a wired chat, triggering or not).
  const handles = new Set<string>();
  for (const dir of sessionDirsOf(agentGroupId)) {
    for (const h of senderHandlesInSession(path.join(dir, 'inbound.db'))) handles.add(h);
  }
  if (handles.size > 0) {
    for (const r of db.prepare('SELECT id FROM users').all() as Array<{ id: string }>) {
      if (handleMatchesUser(handles, r.id)) users.add(r.id);
    }
  }

  return { messagingGroupIds, candidateUserIds: users };
}

function exists(db: Database.Database, sql: string, ...params: unknown[]): boolean {
  return db.prepare(sql).get(...params) !== undefined;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

/** True while any central-DB row still needs this user. */
export function isUserReferenced(db: Database.Database, userId: string): boolean {
  if (exists(db, 'SELECT 1 FROM user_roles WHERE user_id = ? OR granted_by = ? LIMIT 1', userId, userId)) return true;
  if (exists(db, 'SELECT 1 FROM agent_group_members WHERE user_id = ? OR added_by = ? LIMIT 1', userId, userId))
    return true;
  if (exists(db, 'SELECT 1 FROM user_dms WHERE user_id = ? LIMIT 1', userId)) return true;
  if (
    hasTable(db, 'pending_sender_approvals') &&
    exists(
      db,
      'SELECT 1 FROM pending_sender_approvals WHERE sender_identity = ? OR approver_user_id = ? LIMIT 1',
      userId,
      userId,
    )
  )
    return true;
  if (
    hasTable(db, 'pending_channel_approvals') &&
    exists(db, 'SELECT 1 FROM pending_channel_approvals WHERE approver_user_id = ? LIMIT 1', userId)
  )
    return true;
  if (
    hasColumn(db, 'pending_approvals', 'approver_user_id') &&
    exists(db, 'SELECT 1 FROM pending_approvals WHERE approver_user_id = ? LIMIT 1', userId)
  )
    return true;
  if (
    hasTable(db, 'unregistered_senders') &&
    exists(db, 'SELECT 1 FROM unregistered_senders WHERE user_id = ? LIMIT 1', userId)
  )
    return true;
  return false;
}

function isMessagingGroupReferenced(db: Database.Database, mgId: string): boolean {
  if (exists(db, 'SELECT 1 FROM messaging_group_agents WHERE messaging_group_id = ? LIMIT 1', mgId)) return true;
  if (exists(db, 'SELECT 1 FROM sessions WHERE messaging_group_id = ? LIMIT 1', mgId)) return true;
  if (
    hasTable(db, 'pending_channel_approvals') &&
    exists(db, 'SELECT 1 FROM pending_channel_approvals WHERE messaging_group_id = ? LIMIT 1', mgId)
  )
    return true;
  if (
    hasTable(db, 'pending_sender_approvals') &&
    exists(db, 'SELECT 1 FROM pending_sender_approvals WHERE messaging_group_id = ? LIMIT 1', mgId)
  )
    return true;
  if (
    hasTable(db, 'agent_destinations') &&
    exists(db, "SELECT 1 FROM agent_destinations WHERE target_type = 'channel' AND target_id = ? LIMIT 1", mgId)
  )
    return true;
  return false;
}

/**
 * Sender handles in every session DB that belongs to a surviving agent group,
 * limited to the handles that could match a candidate (keeps memory bounded).
 */
function handlesStillInUse(db: Database.Database, excludeAgentGroupId: string, candidates: Set<string>): Set<string> {
  const wanted = new Set<string>();
  for (const id of candidates) {
    wanted.add(id);
    const i = id.indexOf(':');
    if (i > 0) wanted.add(id.slice(i + 1));
  }
  const inUse = new Set<string>();
  const groups = db.prepare('SELECT id FROM agent_groups WHERE id != ?').all(excludeAgentGroupId) as Array<{
    id: string;
  }>;
  for (const g of groups) {
    for (const dir of sessionDirsOf(g.id)) {
      for (const h of senderHandlesInSession(path.join(dir, 'inbound.db'))) if (wanted.has(h)) inUse.add(h);
    }
  }
  return inUse;
}

/**
 * Remove chats and people nothing else needs any more. Run AFTER the
 * groups-delete cascade, with the scope collected before it.
 */
export function purgeUnreferenced(db: Database.Database, agentGroupId: string, scope: PurgeScope): PurgeCounts {
  const counts: PurgeCounts = { messaging_groups: 0, user_dms: 0, unregistered_senders: 0, users: 0 };
  const hasUnregistered = hasTable(db, 'unregistered_senders');
  // Overwrite freed pages so deleted names and numbers don't linger in the file.
  db.pragma('secure_delete = ON');

  // Read other tenants' session DBs outside the write transaction.
  const inUse = handlesStillInUse(db, agentGroupId, scope.candidateUserIds);

  db.transaction(() => {
    for (const mgId of scope.messagingGroupIds) {
      if (isMessagingGroupReferenced(db, mgId)) continue;
      const mg = db.prepare('SELECT channel_type, platform_id FROM messaging_groups WHERE id = ?').get(mgId) as
        | { channel_type: string; platform_id: string }
        | undefined;
      if (!mg) continue;
      counts.user_dms += db.prepare('DELETE FROM user_dms WHERE messaging_group_id = ?').run(mgId).changes;
      if (hasUnregistered) {
        counts.unregistered_senders += db
          .prepare(
            'DELETE FROM unregistered_senders WHERE messaging_group_id = ? OR (channel_type = ? AND platform_id = ?)',
          )
          .run(mgId, mg.channel_type, mg.platform_id).changes;
      }
      counts.messaging_groups += db.prepare('DELETE FROM messaging_groups WHERE id = ?').run(mgId).changes;
    }
    if (hasUnregistered) {
      counts.unregistered_senders += db
        .prepare('DELETE FROM unregistered_senders WHERE agent_group_id = ?')
        .run(agentGroupId).changes;
    }
    for (const userId of scope.candidateUserIds) {
      if (handleMatchesUser(inUse, userId)) continue;
      if (isUserReferenced(db, userId)) continue;
      counts.users += db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes;
    }
  })();

  return counts;
}

// ── OneCLI vault agent ──

export type OnecliRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

const defaultRunner: OnecliRunner = (args) =>
  new Promise((resolve) => {
    execFile('onecli', args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const code = err
        ? typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : 1
        : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

let runner: OnecliRunner = defaultRunner;

/** Test seam: swap the `onecli` invocation. Pass null to restore the real one. */
export function setOnecliRunnerForTesting(fn: OnecliRunner | null): void {
  runner = fn ?? defaultRunner;
}

export type OnecliAgentResult = 'deleted' | 'not_found' | 'unavailable' | 'failed';

/**
 * Delete the OneCLI vault agent registered for this agent group
 * (container-runner calls ensureAgent with identifier = agent group id).
 * Same CLI path the uninstaller uses (setup/uninstall/onecli-agents.ts): list,
 * match on identifier, delete by the vault's own uuid. Best effort: a missing
 * or unreachable onecli is reported, never thrown.
 */
export async function deleteOnecliAgent(agentGroupId: string): Promise<OnecliAgentResult> {
  let listed: { code: number; stdout: string };
  try {
    listed = await runner(['agents', 'list']);
  } catch {
    return 'unavailable';
  }
  if (listed.code !== 0) return 'unavailable';
  let data: unknown;
  try {
    const parsed = JSON.parse(listed.stdout) as unknown;
    data = parsed && typeof parsed === 'object' && 'data' in parsed ? (parsed as { data: unknown }).data : parsed;
  } catch {
    return 'unavailable';
  }
  if (!Array.isArray(data)) return 'unavailable';
  const match = data.find(
    (a): a is { id: string; identifier: string } =>
      !!a && typeof a === 'object' && (a as { identifier?: unknown }).identifier === agentGroupId,
  );
  if (!match || typeof match.id !== 'string' || !match.id) return 'not_found';
  try {
    const res = await runner(['agents', 'delete', '--id', match.id]);
    return res.code === 0 ? 'deleted' : 'failed';
  } catch {
    return 'failed';
  }
}
