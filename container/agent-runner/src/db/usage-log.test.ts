import { beforeEach, describe, expect, test } from 'bun:test';

import { countResearchCalls, extractTurnUsage } from '../providers/claude.js';
import { getOutboundDb, initTestSessionDb } from './connection.js';
import { _resetUsageLogForTest, recordTurnUsage } from './usage-log.js';

beforeEach(() => {
  initTestSessionDb();
  _resetUsageLogForTest();
});

const sample = {
  model: 'claude-sonnet-5',
  inputTokens: 120,
  cacheWriteTokens: 3000,
  cacheReadTokens: 40000,
  outputTokens: 550,
  apiCalls: 2,
  costUsd: 0.0215,
  durationMs: 8400,
};

describe('recordTurnUsage', () => {
  test('writes one numeric row per turn', () => {
    recordTurnUsage(sample, 'chat');
    const rows = getOutboundDb().prepare('SELECT * FROM usage_log').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'chat',
      model: 'claude-sonnet-5',
      input_tokens: 120,
      cache_write_tokens: 3000,
      cache_read_tokens: 40000,
      output_tokens: 550,
      api_calls: 2,
      cost_usd: 0.0215,
      duration_ms: 8400,
    });
    expect(String(rows[0].ts)).toMatch(/Z$/);
  });

  test('records research calls, and adds the column to an older table', () => {
    getOutboundDb().exec('DROP TABLE IF EXISTS usage_log');
    getOutboundDb().exec(
      'CREATE TABLE usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL, model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, api_calls INTEGER NOT NULL DEFAULT 0, cost_usd REAL, duration_ms INTEGER)',
    );
    _resetUsageLogForTest();
    recordTurnUsage({ ...sample, researchCalls: 2 }, 'chat');
    recordTurnUsage(sample, 'chat');
    const rows = getOutboundDb().prepare('SELECT research_calls FROM usage_log ORDER BY id').all() as { research_calls: number }[];
    expect(rows.map((r) => r.research_calls)).toEqual([2, 0]);
  });

  test('creates the table lazily on an older DB that lacks it', () => {
    getOutboundDb().exec('DROP TABLE IF EXISTS usage_log');
    recordTurnUsage(sample, 'task');
    const n = getOutboundDb().prepare('SELECT COUNT(*) AS n FROM usage_log').get() as { n: number };
    expect(n.n).toBe(1);
  });

  test('never throws - reports failure through the logger', () => {
    getOutboundDb().exec('DROP TABLE IF EXISTS usage_log');
    getOutboundDb().exec('CREATE TABLE usage_log (id INTEGER PRIMARY KEY)'); // incompatible shape
    _resetUsageLogForTest();
    const errors: string[] = [];
    expect(() => recordTurnUsage(sample, 'chat', (m) => errors.push(m))).not.toThrow();
    expect(errors[0]).toContain('usage_log write failed');
  });
});

describe('extractTurnUsage', () => {
  test('maps an SDK result message', () => {
    const usage = extractTurnUsage({
      type: 'result',
      subtype: 'success',
      result: 'secret text that must not be copied',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 40,
      },
      modelUsage: { 'claude-haiku-4-5': {} },
      num_turns: 3,
      total_cost_usd: 0.01,
      duration_ms: 1234,
    });
    expect(usage).toEqual({
      model: 'claude-haiku-4-5',
      inputTokens: 10,
      cacheWriteTokens: 20,
      cacheReadTokens: 30,
      outputTokens: 40,
      apiCalls: 3,
      costUsd: 0.01,
      durationMs: 1234,
    });
    expect(JSON.stringify(usage)).not.toContain('secret');
  });

  test("turns the cumulative query cost into this turn's share", () => {
    const msg = { usage: { output_tokens: 1 }, total_cost_usd: 0.0266 };
    expect(extractTurnUsage(msg, 0.022)?.costUsd).toBeCloseTo(0.0046, 6);
  });

  test('treats a total lower than the prior as a fresh query', () => {
    const msg = { usage: { output_tokens: 1 }, total_cost_usd: 0.01 };
    expect(extractTurnUsage(msg, 0.05)?.costUsd).toBeCloseTo(0.01, 6);
  });

  test('returns undefined without a usage block', () => {
    expect(extractTurnUsage({ type: 'result', result: 'x' })).toBeUndefined();
  });

  test('defaults missing numbers to 0 / null', () => {
    expect(extractTurnUsage({ usage: {} })).toEqual({
      model: null,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      apiCalls: 0,
      costUsd: null,
      durationMs: null,
    });
  });
});

describe('countResearchCalls', () => {
  test('counts web search and fetch tool uses, client or server side', () => {
    expect(
      countResearchCalls({
        message: {
          content: [
            { type: 'text', text: 'looking' },
            { type: 'tool_use', name: 'WebSearch' },
            { type: 'tool_use', name: 'WebFetch' },
            { type: 'server_tool_use', name: 'web_search' },
            { type: 'tool_use', name: 'Bash' },
          ],
        },
      }),
    ).toBe(3);
    expect(countResearchCalls({ message: { content: 'plain' } })).toBe(0);
    expect(countResearchCalls(null)).toBe(0);
  });
});
