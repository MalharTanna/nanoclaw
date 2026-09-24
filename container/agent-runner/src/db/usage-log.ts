/**
 * Per-turn token usage (container side).
 *
 * One row per completed agent turn in outbound.db `usage_log`. The container
 * is the sole writer of outbound.db, so this keeps the single-writer rule; the
 * host (and later the SaaS node-agent) reads it read-only for metering.
 * Numbers only - no message text is ever stored here.
 */
import type { TurnUsage } from '../providers/types.js';
import { getOutboundDb } from './connection.js';

/** Kept in sync with the host's OUTBOUND_SCHEMA (src/db/schema.ts). */
export const USAGE_LOG_DDL = `
CREATE TABLE IF NOT EXISTS usage_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 TEXT NOT NULL,
  kind               TEXT NOT NULL,
  model              TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  api_calls          INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,
  duration_ms        INTEGER
);
`;

let tableReady = false;

/**
 * Record one turn. Best-effort: metering must never break a reply, so any
 * failure is swallowed and reported through the optional logger.
 */
export function recordTurnUsage(usage: TurnUsage, kind: 'chat' | 'task', onError?: (msg: string) => void): void {
  try {
    const db = getOutboundDb();
    if (!tableReady) {
      // Older session DBs predate the table - create it lazily.
      db.exec(USAGE_LOG_DDL);
      tableReady = true;
    }
    db.prepare(
      `INSERT INTO usage_log (ts, kind, model, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, api_calls, cost_usd, duration_ms)
       VALUES ($ts, $kind, $model, $input_tokens, $cache_write_tokens, $cache_read_tokens, $output_tokens, $api_calls, $cost_usd, $duration_ms)`,
    ).run({
      $ts: new Date().toISOString(),
      $kind: kind,
      $model: usage.model,
      $input_tokens: usage.inputTokens,
      $cache_write_tokens: usage.cacheWriteTokens,
      $cache_read_tokens: usage.cacheReadTokens,
      $output_tokens: usage.outputTokens,
      $api_calls: usage.apiCalls,
      $cost_usd: usage.costUsd,
      $duration_ms: usage.durationMs,
    });
  } catch (err) {
    onError?.(`usage_log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Test hook: forget that the table was created (new in-memory DB per test). */
export function _resetUsageLogForTest(): void {
  tableReady = false;
}
