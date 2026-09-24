import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deliver = vi.fn();
const pickApprovalDelivery = vi.fn();
const getAdminsOfAgentGroup = vi.fn();

vi.mock('./delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver }) }));
vi.mock('./modules/approvals/primitive.js', () => ({
  pickApprover: () => ['whatsapp:install-owner'],
  pickApprovalDelivery: (...args: unknown[]) => pickApprovalDelivery(...args),
}));
vi.mock('./modules/permissions/db/user-roles.js', () => ({
  getAdminsOfAgentGroup: (...args: unknown[]) => getAdminsOfAgentGroup(...args),
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
const writeQuota = (body: unknown, agentGroupId?: string) => {
  const file = quotaFilePath(dir, agentGroupId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-gate-'));
  deliver.mockReset().mockResolvedValue(undefined);
  pickApprovalDelivery.mockReset().mockImplementation(async (approvers: string[]) => ({
    userId: approvers[0],
    messagingGroup: { channel_type: 'whatsapp', platform_id: `${approvers[0]}@s.whatsapp.net` },
  }));
  getAdminsOfAgentGroup.mockReset().mockReturnValue([{ user_id: 'whatsapp:tenant-owner' }]);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readQuotaState - install scope', () => {
  it('fails open when the file is missing', () => {
    expect(readQuotaState(null, dir)).toEqual({ state: 'ok', periodEnd: null, scope: 'install' });
    expect(isQuotaBlocked(null, dir)).toBe(false);
  });

  it('fails open on invalid JSON and unknown states', () => {
    writeQuota('{not json');
    expect(isQuotaBlocked(null, dir)).toBe(false);
    writeQuota({ state: 'paused' });
    expect(isQuotaBlocked(null, dir)).toBe(false);
  });

  it('reports warn without blocking', () => {
    writeQuota({ state: 'warn', period_end: future() });
    expect(readQuotaState(null, dir).state).toBe('warn');
    expect(isQuotaBlocked(null, dir)).toBe(false);
  });

  it('blocks while the period is current, or with no period_end', () => {
    writeQuota({ state: 'blocked', period_end: future() });
    expect(isQuotaBlocked(null, dir)).toBe(true);
    writeQuota({ state: 'blocked' });
    expect(isQuotaBlocked(null, dir)).toBe(true);
  });

  it('treats a block whose period has ended as stale (ok)', () => {
    writeQuota({ state: 'blocked', period_end: past() });
    expect(isQuotaBlocked(null, dir)).toBe(false);
  });
});

describe('readQuotaState - per agent group (shared-number tenants)', () => {
  it('a tenant block affects only that tenant', () => {
    writeQuota({ state: 'blocked', period_end: future() }, 'ag-tenant-a');
    expect(isQuotaBlocked('ag-tenant-a', dir)).toBe(true);
    expect(isQuotaBlocked('ag-tenant-b', dir)).toBe(false);
    expect(readQuotaState('ag-tenant-a', dir).scope).toBe('group');
  });

  it('the group file wins over the install file', () => {
    writeQuota({ state: 'blocked', period_end: future() });
    writeQuota({ state: 'ok', period_end: future() }, 'ag-tenant-a');
    expect(isQuotaBlocked('ag-tenant-a', dir)).toBe(false);
    expect(isQuotaBlocked('ag-other', dir)).toBe(true); // falls back to install
  });

  it('refuses path-traversal agent group ids', () => {
    expect(() => quotaFilePath(dir, '../../etc/passwd')).toThrow();
    // Reading with a bad id never throws - it just falls back to the install.
    expect(readQuotaState('../x', dir)).toMatchObject({ scope: 'install', state: 'ok' });
  });
});

describe('notifyOwnerQuotaReached', () => {
  it('install scope: DMs the install owner once per period', async () => {
    const periodEnd = future();
    writeQuota({ state: 'blocked', period_end: periodEnd });

    await notifyOwnerQuotaReached('ag-1', 'whatsapp', dir);
    await notifyOwnerQuotaReached('ag-1', 'whatsapp', dir);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      'whatsapp',
      'whatsapp:install-owner@s.whatsapp.net',
      null,
      'chat',
      JSON.stringify({ text: QUOTA_NOTICE_TEXT }),
    );
    expect(shouldSendQuotaNotice(periodEnd, dir)).toBe(false);
  });

  it("group scope: DMs ONLY that tenant's admins, never the install owner", async () => {
    writeQuota({ state: 'blocked', period_end: future() }, 'ag-tenant-a');
    await notifyOwnerQuotaReached('ag-tenant-a', 'whatsapp', dir);
    expect(getAdminsOfAgentGroup).toHaveBeenCalledWith('ag-tenant-a');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![1]).toBe('whatsapp:tenant-owner@s.whatsapp.net');
  });

  it('group scope with no tenant admin: sends nothing (does not fall back to the install owner)', async () => {
    writeQuota({ state: 'blocked', period_end: future() }, 'ag-tenant-a');
    getAdminsOfAgentGroup.mockReturnValue([]);
    await notifyOwnerQuotaReached('ag-tenant-a', 'whatsapp', dir);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('tracks the once-per-period notice separately per tenant', async () => {
    writeQuota({ state: 'blocked', period_end: future() }, 'ag-a');
    writeQuota({ state: 'blocked', period_end: future() }, 'ag-b');
    await notifyOwnerQuotaReached('ag-a', 'whatsapp', dir);
    await notifyOwnerQuotaReached('ag-b', 'whatsapp', dir);
    await notifyOwnerQuotaReached('ag-a', 'whatsapp', dir);
    expect(deliver).toHaveBeenCalledTimes(2);
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

  it('router gates per agent group and stores the message with trigger=0 instead of waking', () => {
    const src = read('router.ts');
    const gate = src.indexOf('if (wake && isQuotaBlocked(agent.agent_group_id))');
    const write = src.indexOf('trigger: wake ? 1 : 0');
    expect(gate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(gate);
  });

  it("host sweep checks the session's agent group before waking for due messages", () => {
    const src = read('host-sweep.ts');
    const gate = src.indexOf('isQuotaBlocked(session.agent_group_id)');
    const wake = src.indexOf('await wakeContainer(session)');
    expect(gate).toBeGreaterThan(-1);
    expect(wake).toBeGreaterThan(gate);
  });
});
