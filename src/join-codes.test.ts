import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deliver = vi.fn();
vi.mock('./delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver }) }));

import type { InboundEvent } from './channels/adapter.js';
import {
  _resetJoinCodeCooldownForTest,
  joinCodesPath,
  linkRequestsPath,
  matchJoinCode,
  isSharedNumber,
  maybeHandleJoinCode,
} from './join-codes.js';

let dir: string;
const NOW = Date.parse('2026-09-25T10:00:00.000Z');

function event(isGroup = true, platformId = '120363413823499258@g.us'): InboundEvent {
  return {
    channelType: 'whatsapp',
    platformId,
    threadId: null,
    message: { id: 'm1', kind: 'chat', content: '{}', timestamp: new Date(NOW).toISOString(), isGroup },
  } as InboundEvent;
}

function arm(codes: Record<string, { expiresAt: string }>) {
  const full = Object.fromEntries(
    Object.entries(codes).map(([c, v]) => [
      c,
      { tenantId: 'org_1', agentGroupId: 'ag-org-1', assistantName: 'Miro', ...v },
    ]),
  );
  fs.writeFileSync(joinCodesPath(dir), JSON.stringify({ codes: full }));
}

const requests = () =>
  fs.existsSync(linkRequestsPath(dir))
    ? fs
        .readFileSync(linkRequestsPath(dir), 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-codes-'));
  deliver.mockReset().mockResolvedValue(undefined);
  _resetJoinCodeCooldownForTest();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('matchJoinCode', () => {
  it('accepts only the exact pattern, case-insensitive, without ambiguous characters', () => {
    expect(matchJoinCode('join AB23CD')).toBe('AB23CD');
    expect(matchJoinCode('  JOIN ab23cd ')).toBe('AB23CD');
    expect(matchJoinCode('please join AB23CD')).toBeNull();
    expect(matchJoinCode('join AB23CD now')).toBeNull();
    expect(matchJoinCode('join AB10CD')).toBeNull(); // 1 and 0 excluded
    expect(matchJoinCode(undefined)).toBeNull();
  });
});

describe('maybeHandleJoinCode', () => {
  it('does nothing on installs without a join-codes file (e.g. a personal NanoClaw)', async () => {
    expect(await maybeHandleJoinCode(event(), 'join AB23CD', dir, NOW)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('ignores non-join text', async () => {
    arm({ AB23CD: { expiresAt: '2026-09-26T00:00:00.000Z' } });
    expect(await maybeHandleJoinCode(event(), 'hello team', dir, NOW)).toBe(false);
    expect(await maybeHandleJoinCode(event(false, '919876543210@s.whatsapp.net'), 'hi', dir, NOW)).toBe(false);
    expect(requests()).toEqual([]);
  });

  it('links a DM sender by phone number, with a DM-specific confirmation', async () => {
    arm({ AB23CD: { expiresAt: '2026-09-26T00:00:00.000Z' } });
    expect(await maybeHandleJoinCode(event(false, '919876543210@s.whatsapp.net'), 'join AB23CD', dir, NOW)).toBe(true);
    expect(requests()).toEqual([
      expect.objectContaining({ code: 'AB23CD', platformId: '919876543210@s.whatsapp.net' }),
    ]);
    expect(JSON.parse(deliver.mock.calls[0][4]).text).toContain('Your number is now connected to **Miro**');
  });

  it('refuses a DM whose sender is still an unresolved @lid', async () => {
    arm({ AB23CD: { expiresAt: '2026-09-26T00:00:00.000Z' } });
    expect(await maybeHandleJoinCode(event(false, '123456789012345@lid'), 'join AB23CD', dir, NOW)).toBe(true);
    expect(requests()).toEqual([]);
    expect(JSON.parse(deliver.mock.calls[0][4]).text).toContain("couldn't confirm your number");
  });

  it('accepts an armed code: records the request and confirms in the group', async () => {
    arm({ AB23CD: { expiresAt: '2026-09-26T00:00:00.000Z' } });
    expect(await maybeHandleJoinCode(event(), 'join ab23cd', dir, NOW)).toBe(true);
    expect(requests()).toEqual([
      {
        ts: '2026-09-25T10:00:00.000Z',
        code: 'AB23CD',
        tenantId: 'org_1',
        agentGroupId: 'ag-org-1',
        channelType: 'whatsapp',
        platformId: '120363413823499258@g.us',
        instance: 'whatsapp',
      },
    ]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.parse(deliver.mock.calls[0]![4]).text).toContain('connected to **Miro**');
    // The request file holds no message text or sender.
    expect(fs.readFileSync(linkRequestsPath(dir), 'utf-8')).not.toContain('sender');
  });

  it('rejects unknown and expired codes, replying at most once per chat per 10 minutes', async () => {
    arm({ AB23CD: { expiresAt: '2026-09-25T09:00:00.000Z' } });
    expect(await maybeHandleJoinCode(event(), 'join AB23CD', dir, NOW)).toBe(true);
    expect(await maybeHandleJoinCode(event(), 'join ZZ99ZZ', dir, NOW + 60_000)).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.parse(deliver.mock.calls[0]![4]).text).toContain("isn't valid");
    await maybeHandleJoinCode(event(), 'join ZZ99ZZ', dir, NOW + 11 * 60_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(requests()).toEqual([]);
  });
});

describe('router wiring (structural)', () => {
  it('checks join codes only in the unwired branches, before the mention gate', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'router.ts'), 'utf-8');
    const calls = src.split('maybeHandleJoinCode(event').length - 1;
    expect(calls).toBe(2);
    const notFound = src.indexOf('if (!found) {');
    const firstHook = src.indexOf('maybeHandleJoinCode(event', notFound);
    const firstGate = src.indexOf('if (!isMention) return;', notFound);
    expect(firstHook).toBeGreaterThan(notFound);
    expect(firstHook).toBeLessThan(firstGate);
    const unwired = src.indexOf('if (agentCount === 0) {');
    const secondHook = src.indexOf('maybeHandleJoinCode(event', unwired);
    expect(secondHook).toBeLessThan(src.indexOf('if (!isMention) return;', unwired));
  });
});

describe('isSharedNumber', () => {
  it('is on only for NANOCLAW_SHARED_NUMBER=true', () => {
    const orig = process.env.NANOCLAW_SHARED_NUMBER;
    try {
      process.env.NANOCLAW_SHARED_NUMBER = 'true';
      expect(isSharedNumber()).toBe(true);
      process.env.NANOCLAW_SHARED_NUMBER = 'yes';
      expect(isSharedNumber()).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.NANOCLAW_SHARED_NUMBER;
      else process.env.NANOCLAW_SHARED_NUMBER = orig;
    }
  });
});
