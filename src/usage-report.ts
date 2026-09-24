/**
 * Usage report — aggregates the per-turn `usage_log` rows the agent-runner
 * writes into each session's outbound.db. Read-only; numbers only.
 *
 * Consumed by scripts/usage-report.ts today and by the SaaS node-agent later
 * (monthly reply counts for plan limits, token cost per tenant).
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

export interface UsageTotals {
  turns: number;
  chatTurns: number;
  taskTurns: number;
  apiCalls: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageReport {
  since: string;
  total: UsageTotals;
  byAgentGroup: Record<string, UsageTotals>;
  byModel: Record<string, number>;
}

function emptyTotals(): UsageTotals {
  return {
    turns: 0,
    chatTurns: 0,
    taskTurns: 0,
    apiCalls: 0,
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

interface UsageRow {
  kind: string;
  model: string | null;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  api_calls: number;
  cost_usd: number | null;
}

function add(t: UsageTotals, r: UsageRow): void {
  t.turns++;
  if (r.kind === 'task') t.taskTurns++;
  else t.chatTurns++;
  t.apiCalls += r.api_calls;
  t.inputTokens += r.input_tokens;
  t.cacheWriteTokens += r.cache_write_tokens;
  t.cacheReadTokens += r.cache_read_tokens;
  t.outputTokens += r.output_tokens;
  t.costUsd += r.cost_usd ?? 0;
}

/** Every `<sessionsDir>/<agentGroup>/<session>/outbound.db` that exists. */
export function findOutboundDbs(sessionsDir: string): { agentGroup: string; dbPath: string }[] {
  const found: { agentGroup: string; dbPath: string }[] = [];
  let groups: fs.Dirent[];
  try {
    groups = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    for (const s of fs.readdirSync(path.join(sessionsDir, g.name), { withFileTypes: true })) {
      if (!s.isDirectory() || s.name.startsWith('.')) continue;
      const dbPath = path.join(sessionsDir, g.name, s.name, 'outbound.db');
      if (fs.existsSync(dbPath)) found.push({ agentGroup: g.name, dbPath });
    }
  }
  return found;
}

/** Aggregate usage since `sinceIso` across all session DBs under `sessionsDir`. */
export function buildUsageReport(sessionsDir: string, sinceIso: string): UsageReport {
  const report: UsageReport = { since: sinceIso, total: emptyTotals(), byAgentGroup: {}, byModel: {} };
  for (const { agentGroup, dbPath } of findOutboundDbs(sessionsDir)) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma('busy_timeout = 5000');
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_log'").get();
      if (!hasTable) continue;
      const rows = db
        .prepare(
          `SELECT kind, model, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, api_calls, cost_usd
             FROM usage_log WHERE ts >= ?`,
        )
        .all(sinceIso) as UsageRow[];
      const group = (report.byAgentGroup[agentGroup] ??= emptyTotals());
      for (const r of rows) {
        add(report.total, r);
        add(group, r);
        const model = r.model ?? 'unknown';
        report.byModel[model] = (report.byModel[model] ?? 0) + 1;
      }
    } finally {
      db.close();
    }
  }
  return report;
}
