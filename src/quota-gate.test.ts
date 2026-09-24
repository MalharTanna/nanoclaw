import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deliver = vi.fn();
const pickApprovalDelivery = vi.fn();

vi.mock('./delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver }) }));
vi.mock('./modules/approvals/primitive.js', () => ({
  pickApprover: () => ['whatsapp:owner'],
  pickApprovalDelivery: (...args: unknown[]) => pickApprovalDelivery(...args),
}));

import {
  QUOTA_NOTICE_TEXT,
  isQuotaBlocked,
  notifyOwnerQuotaReached,
  quotaFilePath,
  readQuotaState,
  shouldSendQuotaNotice,
} from './quota-gate.js';

let dir: string;
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();
const writeQuota = (body: unknown) =>
  fs.writeFileSync(quotaFilePath(dir), typeof body === 'string' ? body : JSON.stringify(body));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-gate-'));
  deliver.mockReset().mockResolvedValue(undefined);
  pickApprovalDelivery.mockReset().mockResolvedValue({
    userId: 'whatsapp:owner',
    messagingGroup: { channel_type: 'whatsapp', platform_id: 'owner@s.whatsapp.net' },
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readQuotaState', () => {
  it('fails open when the file is missing', () => {
    expect(readQuotaState(dir)).toEqual({ state: 'ok', periodEnd: null });
    expect(isQuotaBlocked(dir)).toBe(false);
  });

  it('fails open on invalid JSON', () => {
    writeQuota('{not json');
    expect(isQuotaBlocked(dir)).toBe(false);
  });

  it('fails open on an unknown state', () => {
    writeQuota({ state: 'paused' });
    expect(isQuotaBlocked(dir)).toBe(false);
  });

  it('reports warn without blocking', () => {
    writeQuota({ state: 'warn', period_end: future() });
    expect(readQuotaState(dir).state).toBe('warn');
    expect(isQuotaBlocked(dir)).toBe(false);
  });

  it('blocks while the period is current', () => {
    writeQuota({ state: 'blocked', period_end: future() });
    expect(isQuotaBlocked(dir)).toBe(true);
  });

  it('blocks when no period_end is given', () => {
    writeQuota({ state: 'blocked' });
    expect(isQuotaBlocked(dir)).toBe(true);
  });

  it('treats a block whose period has ended as stale (ok)', () => {
    writeQuota({ state: 'blocked', period_end: past() });
    expect(isQuotaBlocked(dir)).toBe(false);
  });
});

describe('notifyOwnerQuotaReached', () => {
  it('DMs the owner once per period', async () => {
    const periodEnd = future();
    writeQuota({ state: 'blocked', period_end: periodEnd });

    await notifyOwnerQuotaReached('ag-1', 'whatsapp', dir);
    await notifyOwnerQuotaReached('ag-1', 'whatsapp', dir);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      'whatsapp',
      'owner@s.whatsapp.net',
      null,
      'chat',
      JSON.stringify({ text: QUOTA_NOTICE_TEXT }),
    );
    expect(shouldSendQuotaNotice(periodEnd, dir)).toBe(false);
  });

  it('re-arms for a new period', async () => {
    writeQuota({ state: 'blocked', period_end: future() });
    await notifyOwnerQuotaReached('ag-1', 'whatsapp', dir);

    writeQuota({ state: 'blocked', period_end: new Date(Date.now() + 40 * 86_400_000).toISOString() });
    await notifyOwnerQuotaReached('ag-1', 'whatsapp', dir);

    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('does not mark the notice sent when delivery fails, so it retries', async () => {
    const periodEnd = future();
    writeQuota({ state: 'blocked', period_end: periodEnd });
    deliver.mockRejectedValueOnce(new Error('socket closed'));

    await notifyOwnerQuotaReached('ag-1', 'whatsapp', dir);
    expect(shouldSendQuotaNotice(periodEnd, dir)).toBe(true);

    await notifyOwnerQuotaReached('ag-1', 'whatsapp', dir);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(shouldSendQuotaNotice(periodEnd, dir)).toBe(false);
  });

  it('sends nothing when no owner DM is reachable', async () => {
    writeQuota({ state: 'blocked', period_end: future() });
    pickApprovalDelivery.mockResolvedValue(null);

    await notifyOwnerQuotaReached('ag-1', 'whatsapp', dir);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('quota gate wiring (structural)', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', f), 'utf-8');

  it('router stores the message with trigger=0 instead of waking when blocked', () => {
    const src = read('router.ts');
    const gate = src.indexOf('if (wake && isQuotaBlocked())');
    const write = src.indexOf('trigger: wake ? 1 : 0');
    expect(gate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(gate);
  });

  it('host sweep checks the gate before waking for due messages', () => {
    const src = read('host-sweep.ts');
    const gate = src.indexOf('isQuotaBlocked()');
    const wake = src.indexOf('await wakeContainer(session)');
    expect(gate).toBeGreaterThan(-1);
    expect(wake).toBeGreaterThan(gate);
  });
});
