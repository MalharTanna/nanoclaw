import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deliver = vi.fn();
vi.mock('./delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver }) }));

import type { InboundEvent } from './channels/adapter.js';
import {
  _resetJoinCodeCooldownForTest,
  groupNotice,
  isSharedNumber,
  joinCodesPath,
  linkRequestsPath,
  matchJoinCode,
  maybeHandleJoinCode,
  maybeReplyToUnlinkedChat,
  flushQueuedJoins,
  queuedJoinsPath,
  UNLINKED_GROUP_REPLY,
  unlinkedRepliesPath,
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

function arm(codes: Record<string, { expiresAt: string; maxGroupMembers?: number }>) {
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

  it('links a DM sender by phone number without replying in the chat (the dashboard confirms)', async () => {
    arm({ AB23CD: { expiresAt: '2026-09-26T00:00:00.000Z' } });
    expect(await maybeHandleJoinCode(event(false, '919876543210@s.whatsapp.net'), 'join AB23CD', dir, NOW)).toBe(true);
    expect(requests()).toEqual([
      expect.objectContaining({ code: 'AB23CD', platformId: '919876543210@s.whatsapp.net' }),
    ]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('ignores a DM whose sender is still an unresolved @lid, silently', async () => {
    arm({ AB23CD: { expiresAt: '2026-09-26T00:00:00.000Z' } });
    expect(await maybeHandleJoinCode(event(false, '123456789012345@lid'), 'join AB23CD', dir, NOW)).toBe(true);
    expect(requests()).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not answer a bad code in a personal chat', async () => {
    arm({ AB23CD: { expiresAt: '2026-09-25T09:00:00.000Z' } });
    expect(await maybeHandleJoinCode(event(false, '919876543210@s.whatsapp.net'), 'join AB23CD', dir, NOW)).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
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

  it('refuses groups over the plan limit (default 50) and community groups, without using the code', async () => {
    arm({ AB23CD: { expiresAt: '2026-09-26T00:00:00.000Z' } });
    const big = event();
    big.message.content = JSON.stringify({ text: 'join AB23CD', groupInfo: { size: 120, community: false } });
    expect(await maybeHandleJoinCode(big, 'join AB23CD', dir, NOW)).toBe(true);
    expect(requests()).toEqual([]);
    expect(JSON.parse(deliver.mock.calls[0]![4]).text).toContain('120 members');

    deliver.mockClear();
    const community = event(true, '120363000000000099@g.us');
    community.message.content = JSON.stringify({ text: 'join AB23CD', groupInfo: { size: 8, community: true } });
    expect(await maybeHandleJoinCode(community, 'join AB23CD', dir, NOW)).toBe(true);
    expect(JSON.parse(deliver.mock.calls[0]![4]).text).toContain('community');

    const small = event(true, '120363000000000098@g.us');
    small.message.content = JSON.stringify({ text: 'join AB23CD', groupInfo: { size: 12, community: false } });
    expect(await maybeHandleJoinCode(small, 'join AB23CD', dir, NOW)).toBe(true);
    expect(requests()).toHaveLength(1);
  });

  it('uses the plan limit the code carries (Standard: 20)', async () => {
    arm({ KM4PQR: { expiresAt: '2026-09-26T00:00:00.000Z', maxGroupMembers: 20 } });
    const g = event(true, '120363000000000097@g.us');
    g.message.content = JSON.stringify({ text: 'join KM4PQR', groupInfo: { size: 25, community: false } });
    expect(await maybeHandleJoinCode(g, 'join KM4PQR', dir, NOW)).toBe(true);
    expect(requests()).toEqual([]);
    expect(JSON.parse(deliver.mock.calls[0]![4]).text).toContain('this plan allows groups of up to 20');
  });

  it('accepts a code that was valid when the message was sent, even if handled later (after an outage)', async () => {
    arm({ AB23CD: { expiresAt: '2026-09-25T09:00:00.000Z' } }); // expired an hour before NOW
    const late = event();
    late.message.timestamp = '2026-09-25T08:45:00.000Z'; // sent while it was still valid
    expect(await maybeHandleJoinCode(late, 'join AB23CD', dir, NOW)).toBe(true);
    expect(requests()).toEqual([expect.objectContaining({ code: 'AB23CD', sentAt: '2026-09-25T08:45:00.000Z' })]);
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

describe('group notice', () => {
  it('names the business that added the assistant, says it only replies when mentioned, and how to remove it', () => {
    const text = groupNotice('Miro', 'Fidiots Media');
    expect(text).toContain('*Fidiots Media* has connected this group to **Miro**');
    expect(text).toContain('I only reply when someone mentions me');
    expect(text).toContain('open the group info, tap Miro and choose Remove');
  });

  it('tells every member what is processed, for how long, and where the privacy notice is', () => {
    const text = groupNotice('Miro');
    expect(text).toContain('connected to **Miro**, an AI assistant by Miroflow');
    expect(text).toContain('For everyone in this group');
    expect(text).toContain('processed by Miroflow and its AI provider');
    expect(text).toContain('account is active');
    expect(text).toContain('https://miroflow.in/privacy');
  });
});

describe('maybeReplyToUnlinkedChat', () => {
  beforeEach(() => deliver.mockClear());
  const sentText = (n: number) => JSON.parse(deliver.mock.calls[n][4]).text as string;

  it('never writes to an unlinked personal chat', async () => {
    expect(await maybeReplyToUnlinkedChat(event(false, '918287614988@s.whatsapp.net'), true, dir, NOW)).toBe(false);
    expect(await maybeReplyToUnlinkedChat(event(false, '14624464351359@lid'), true, dir, NOW)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('in an unlinked group, answers a mention with the join code steps, once a day', async () => {
    const group = event(true);
    expect(await maybeReplyToUnlinkedChat(group, false, dir, NOW)).toBe(false);
    expect(await maybeReplyToUnlinkedChat(group, true, dir, NOW)).toBe(true);
    expect(sentText(0)).toBe(UNLINKED_GROUP_REPLY);
    expect(sentText(0)).toContain('Connect WhatsApp');
    expect(sentText(0)).toContain('join AB23CD');
    expect(await maybeReplyToUnlinkedChat(group, true, dir, NOW + 60 * 1000)).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(unlinkedRepliesPath(dir), 'utf8')).not.toContain('120363413823499258');
  });

  it('stays silent for broadcasts, non-message events and messages typed on the bot phone', async () => {
    expect(await maybeReplyToUnlinkedChat(event(false, 'status@broadcast'), true, dir, NOW)).toBe(false);
    const reaction = event(true);
    reaction.message.kind = 'reaction' as never;
    expect(await maybeReplyToUnlinkedChat(reaction, true, dir, NOW)).toBe(false);
    const typedOnBotPhone = event(true);
    typedOnBotPhone.message.content = JSON.stringify({ text: 'hello', fromMe: true });
    expect(await maybeReplyToUnlinkedChat(typedOnBotPhone, true, dir, NOW)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('group join cooling on linked device', () => {
  let store: string;
  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'join-store-'));
    process.env.WHATSAPP_CHANNEL = 'linked';
  });
  afterEach(() => {
    delete process.env.WHATSAPP_CHANNEL;
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('joins the first 3 groups today, queues the 4th with its time, and releases it when due', async () => {
    const now = Date.parse('2026-10-20T04:30:00.000Z'); // 10:00 AM IST
    arm({ AB23CD: { expiresAt: new Date(now + 6 * 3_600_000).toISOString() } });
    for (let i = 0; i < 3; i++) {
      const at = now + i * 31 * 60_000;
      expect(await maybeHandleJoinCode({ ...event(true, `12036341382349925${i}@g.us`), message: { ...event().message, timestamp: new Date(at).toISOString() } } as InboundEvent, 'join AB23CD', dir, at, store)).toBe(true);
    }
    expect(requests()).toHaveLength(3);
    deliver.mockClear();
    const at = now + 95 * 60_000;
    expect(await maybeHandleJoinCode({ ...event(true, '120363413823499259@g.us'), message: { ...event().message, timestamp: new Date(at).toISOString() } } as InboundEvent, 'join AB23CD', dir, at, store)).toBe(true);
    expect(requests()).toHaveLength(3); // not yet
    expect(JSON.parse(deliver.mock.calls[0]![4]).text).toContain("I'll start in this group at 8:00 AM tomorrow");

    expect(await flushQueuedJoins(dir, at + 60_000)).toBe(0);
    deliver.mockClear();
    expect(await flushQueuedJoins(dir, Date.parse('2026-10-21T02:31:00.000Z'))).toBe(1);
    const released = requests().at(-1);
    expect(released).toMatchObject({ platformId: '120363413823499259@g.us', code: 'AB23CD', sentAt: new Date(at).toISOString() });
    expect(JSON.parse(deliver.mock.calls[0]![4]).text).toContain('connected to **Miro**');
    expect(fs.readFileSync(queuedJoinsPath(dir), 'utf8')).toBe('');
  });
});
