import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

const deliver = vi.fn().mockResolvedValue(undefined);
vi.mock('./delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver }) }));

import type { InboundEvent } from './channels/adapter.js';
import { matchOwnerCommand, maybeHandleOwnerCommand } from './owner-commands.js';

const G = '120363000000000001@g.us';
const ev = (text: string, fromMe: boolean, platformId = G): InboundEvent =>
  ({
    channelType: 'whatsapp',
    platformId,
    threadId: null,
    message: { id: 'm', kind: 'chat', timestamp: new Date().toISOString(), isGroup: true, content: JSON.stringify({ text, fromMe, groupInfo: { name: 'Clients', size: 6, community: false } }) },
  }) as InboundEvent;

describe('owner commands on a business\'s own number', () => {
  it('matches "<name> start|stop" only', () => {
    expect(matchOwnerCommand('Miro start', 'Miro')).toBe('start');
    expect(matchOwnerCommand('  miro STOP. ', 'Miro')).toBe('stop');
    expect(matchOwnerCommand('Asha start', 'Asha')).toBe('start');
    expect(matchOwnerCommand('Miro, stop', 'Miro')).toBe('stop');
    expect(matchOwnerCommand('Miro: start', 'Miro')).toBe('start');
    expect(matchOwnerCommand('@Miro stop', 'Miro')).toBe('stop');
    expect(matchOwnerCommand('Miro start the meeting', 'Miro')).toBeNull();
    expect(matchOwnerCommand('Bob start', 'Miro')).toBeNull();
  });

  it('queues the owner\'s request with the group details; members are ignored; stop is confirmed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-'));
    expect(await maybeHandleOwnerCommand(ev('Miro start', false), dir, 0, true)).toBe(false); // a member
    expect(await maybeHandleOwnerCommand(ev('Miro start', true), dir, 0, false)).toBe(false); // not an own-number install
    expect(await maybeHandleOwnerCommand(ev('Miro start', true, '919999999999@s.whatsapp.net'), dir, 0, true)).toBe(false); // not a group
    expect(await maybeHandleOwnerCommand(ev('Miro start', true), dir, 0, true)).toBe(true);
    expect(await maybeHandleOwnerCommand(ev('Miro stop', true), dir, 0, true)).toBe(true);
    const lines = fs.readFileSync(path.join(dir, 'link-requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.action)).toEqual(['start', 'stop']);
    expect(lines[0]).toMatchObject({ kind: 'owner', platformId: G, group: { name: 'Clients', size: 6, community: false } });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.parse(deliver.mock.calls[0]![4]).text).toContain("I'm off in this group");
  });
});
