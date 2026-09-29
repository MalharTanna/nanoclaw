import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deliver = vi.fn();
vi.mock('./delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver }) }));

import type { InboundEvent } from './channels/adapter.js';
import type { MessagingGroupAgent } from './types.js';
import { answerAllNotice, answersEverything, maybePostAnswerAllNotice } from './member-notice.js';

let dir: string;
let origShared: string | undefined;

const event = {
  channelType: 'whatsapp',
  platformId: '120363413823499258@g.us',
  threadId: null,
} as unknown as InboundEvent;
const group = { id: 'mg-1', is_group: 1 };
type Wiring = Pick<MessagingGroupAgent, 'engage_mode' | 'engage_pattern'>;
const all: Wiring[] = [{ engage_mode: 'pattern', engage_pattern: '.' }];
const mention: Wiring[] = [{ engage_mode: 'mention', engage_pattern: null }];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-notice-'));
  deliver.mockReset().mockResolvedValue(undefined);
  origShared = process.env.NANOCLAW_SHARED_NUMBER;
  process.env.NANOCLAW_SHARED_NUMBER = 'true';
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (origShared === undefined) delete process.env.NANOCLAW_SHARED_NUMBER;
  else process.env.NANOCLAW_SHARED_NUMBER = origShared;
});

describe('answer-everything notice', () => {
  it('recognises the "answer every message" wiring only', () => {
    expect(answersEverything({ engage_mode: 'pattern', engage_pattern: '.' })).toBe(true);
    expect(answersEverything({ engage_mode: 'pattern', engage_pattern: null })).toBe(true);
    expect(answersEverything({ engage_mode: 'pattern', engage_pattern: '(?i)\\bmiro\\b' })).toBe(false);
    expect(answersEverything({ engage_mode: 'mention', engage_pattern: null })).toBe(false);
  });

  it('posts once after a switch to "answer everything", and again only after switching back and forth', async () => {
    expect(await maybePostAnswerAllNotice(event, group, mention, 'Miro', dir)).toBe(false);
    expect(await maybePostAnswerAllNotice(event, group, all, 'Miro', dir)).toBe(true);
    expect(await maybePostAnswerAllNotice(event, group, all, 'Miro', dir)).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
    const text = JSON.parse(deliver.mock.calls[0][4]).text as string;
    expect(text).toBe(answerAllNotice('Miro'));
    expect(text).toContain('reads every message here');
    expect(text).toContain('https://miroflow.in/privacy');

    await maybePostAnswerAllNotice(event, group, mention, 'Miro', dir);
    expect(await maybePostAnswerAllNotice(event, group, all, 'Miro', dir)).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('also covers a group linked straight into "answer everything"', async () => {
    expect(await maybePostAnswerAllNotice(event, group, all, 'Miro', dir)).toBe(true);
  });

  it('does nothing for personal chats or on a non-shared install', async () => {
    expect(await maybePostAnswerAllNotice(event, { id: 'mg-dm', is_group: 0 }, all, 'Miro', dir)).toBe(false);
    process.env.NANOCLAW_SHARED_NUMBER = 'false';
    expect(await maybePostAnswerAllNotice(event, group, all, 'Miro', dir)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});
