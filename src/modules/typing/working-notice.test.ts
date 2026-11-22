/**
 * "Working on it" notice: sent once when a WhatsApp request is still being
 * worked on WORKING_NOTICE_AFTER_MS after it arrived; never when a reply
 * already went out, the agent went idle, or for other channels.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-working-notice' };
});

import { heartbeatPath } from '../../session-manager.js';
import {
  WORKING_NOTICE_AFTER_MS,
  WORKING_NOTICE_TEXT,
  pauseTypingRefreshAfterDelivery,
  setTypingAdapter,
  startTypingRefresh,
  stopTypingRefresh,
} from './index.js';

type Sent = { platformId: string; content: string; instance?: string };

function capture(): Sent[] {
  const sent: Sent[] = [];
  setTypingAdapter({
    async setTyping() {},
    async deliver(_c, platformId, _t, _k, content, _f, instance) {
      sent.push({ platformId, content, instance });
      return 'id';
    },
  });
  return sent;
}

/** Keep the session's heartbeat fresh (the agent is working). */
function beat(): void {
  const p = heartbeatPath('ag-1', 'sess-1');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const now = new Date();
  fs.writeFileSync(p, '');
  fs.utimesSync(p, now, now);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  vi.useRealTimers();
});

async function workFor(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 2000) {
    beat();
    await vi.advanceTimersByTimeAsync(2000);
  }
}

describe('working notice', () => {
  it('is sent once to the chat when the request is still being worked on', async () => {
    const sent = capture();
    startTypingRefresh('sess-1', 'ag-1', 'whatsapp', 'wa:123@g.us', null, 'whatsapp');
    await workFor(WORKING_NOTICE_AFTER_MS + 2000);
    expect(sent).toEqual([
      { platformId: 'wa:123@g.us', content: JSON.stringify({ text: WORKING_NOTICE_TEXT }), instance: 'whatsapp' },
    ]);
    // A follow-up message in the same request does not repeat it.
    startTypingRefresh('sess-1', 'ag-1', 'whatsapp', 'wa:123@g.us', null, 'whatsapp');
    await workFor(WORKING_NOTICE_AFTER_MS + 2000);
    expect(sent).toHaveLength(1);
  });

  it('is not sent when a reply went out first, and re-arms for the next request', async () => {
    const sent = capture();
    startTypingRefresh('sess-1', 'ag-1', 'whatsapp', 'wa:123@g.us', null);
    await workFor(8000);
    pauseTypingRefreshAfterDelivery('sess-1');
    await workFor(WORKING_NOTICE_AFTER_MS);
    expect(sent).toHaveLength(0);
    startTypingRefresh('sess-1', 'ag-1', 'whatsapp', 'wa:123@g.us', null);
    await workFor(WORKING_NOTICE_AFTER_MS + 2000);
    expect(sent).toHaveLength(1);
  });

  it('is not sent when the agent finished without replying', async () => {
    const sent = capture();
    startTypingRefresh('sess-1', 'ag-1', 'whatsapp', 'wa:123@g.us', null);
    fs.rmSync(heartbeatPath('ag-1', 'sess-1'), { force: true });
    await vi.advanceTimersByTimeAsync(WORKING_NOTICE_AFTER_MS + 4000);
    expect(sent).toHaveLength(0);
  });

  it('is only for WhatsApp', async () => {
    const sent = capture();
    startTypingRefresh('sess-1', 'ag-1', 'web', 'web:abc', null);
    await workFor(WORKING_NOTICE_AFTER_MS + 2000);
    expect(sent).toHaveLength(0);
  });
});
