/**
 * scripts/usage-report.ts — per-turn token usage from session outbound DBs.
 *
 * Usage:
 *   pnpm exec tsx scripts/usage-report.ts [--days 30] [--json]
 *
 * Reads usage_log rows written by the agent-runner (numbers only, no message
 * text). Cost is the SDK's own list-price estimate, so it reads in API terms
 * even when the install runs on a subscription login.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { buildUsageReport } from '../src/usage-report.js';

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 30;
if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number');
  process.exit(2);
}

const since = new Date(Date.now() - days * 86_400_000).toISOString();
const report = buildUsageReport(path.join(DATA_DIR, 'v2-sessions'), since);

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const t = report.total;
  const per = (n: number) => (t.turns > 0 ? Math.round(n / t.turns) : 0);
  console.log(`Since ${since}: ${t.turns} turns (${t.chatTurns} chat, ${t.taskTurns} task)`);
  console.log(`Models: ${JSON.stringify(report.byModel)}`);
  console.log(
    `Per turn avg: ${per(t.apiCalls)} calls, ${per(t.inputTokens)} in, ${per(t.cacheWriteTokens)} cache-write, ` +
      `${per(t.cacheReadTokens)} cache-read, ${per(t.outputTokens)} out`,
  );
  console.log(`Est. cost: $${t.costUsd.toFixed(2)} ($${t.turns > 0 ? (t.costUsd / t.turns).toFixed(4) : '0'}/turn)`);
  for (const [group, g] of Object.entries(report.byAgentGroup)) {
    console.log(`  ${group}: ${g.turns} turns, $${g.costUsd.toFixed(2)}`);
  }
}
