import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OUTBOUND_SCHEMA } from './db/schema.js';
import { buildUsageReport, findOutboundDbs } from './usage-report.js';

let dir: string;

function makeSession(agentGroup: string, session: string, withTable = true): Database.Database {
  const sdir = path.join(dir, agentGroup, session);
  fs.mkdirSync(sdir, { recursive: true });
  const db = new Database(path.join(sdir, 'outbound.db'));
  if (withTable) db.exec(OUTBOUND_SCHEMA);
  else db.exec('CREATE TABLE messages_out (id TEXT PRIMARY KEY)');
  return db;
}

function insert(db: Database.Database, ts: string, kind: string, model: string, cost: number): void {
  db.prepare(
    `INSERT INTO usage_log (ts, kind, model, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, api_calls, cost_usd)
     VALUES (?, ?, ?, 100, 1000, 40000, 500, 2, ?)`,
  ).run(ts, kind, model, cost);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-report-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildUsageReport', () => {
  it('aggregates across sessions and agent groups, honouring --since', () => {
    const a = makeSession('ag-a', 'sess-1');
    insert(a, '2026-09-20T10:00:00.000Z', 'chat', 'claude-sonnet-5', 0.02);
    insert(a, '2026-09-21T10:00:00.000Z', 'task', 'claude-sonnet-5', 0.03);
    insert(a, '2026-08-01T10:00:00.000Z', 'chat', 'claude-sonnet-5', 9); // before window
    a.close();
    const b = makeSession('ag-b', 'sess-2');
    insert(b, '2026-09-22T10:00:00.000Z', 'chat', 'claude-haiku-4-5', 0.01);
    b.close();

    const r = buildUsageReport(dir, '2026-09-01T00:00:00.000Z');

    expect(r.total.turns).toBe(3);
    expect(r.total.chatTurns).toBe(2);
    expect(r.total.taskTurns).toBe(1);
    expect(r.total.apiCalls).toBe(6);
    expect(r.total.cacheReadTokens).toBe(120000);
    expect(r.total.costUsd).toBeCloseTo(0.06);
    expect(r.byAgentGroup['ag-a'].turns).toBe(2);
    expect(r.byAgentGroup['ag-b'].turns).toBe(1);
    expect(r.byModel).toEqual({ 'claude-sonnet-5': 2, 'claude-haiku-4-5': 1 });
  });

  it('skips session DBs that predate usage_log', () => {
    makeSession('ag-old', 'sess-1', false).close();
    const r = buildUsageReport(dir, '2026-01-01T00:00:00.000Z');
    expect(r.total.turns).toBe(0);
  });

  it('returns an empty report when the sessions dir is missing', () => {
    const r = buildUsageReport(path.join(dir, 'nope'), '2026-01-01T00:00:00.000Z');
    expect(r.total.turns).toBe(0);
  });
});

describe('findOutboundDbs', () => {
  it('ignores dot-directories such as .claude-shared', () => {
    makeSession('ag-a', 'sess-1').close();
    fs.mkdirSync(path.join(dir, 'ag-a', '.claude-shared'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ag-a', '.claude-shared', 'outbound.db'), '');
    expect(findOutboundDbs(dir).map((d) => d.agentGroup)).toEqual(['ag-a']);
  });
});
