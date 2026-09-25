import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup } from './adapter.js';
import { createWebAdapter, parseWebLine, webChannelEnabled, webSocketPath } from './web.js';

const good = {
  type: 'message',
  platformId: 'web:ab12cd34',
  threadId: 'conv_12345678',
  id: 'm1',
  text: 'Hello',
  sender: 'Asha',
};

describe('parseWebLine', () => {
  it('accepts a well-formed message', () => {
    expect(parseWebLine(JSON.stringify(good))).toEqual({
      platformId: 'web:ab12cd34',
      threadId: 'conv_12345678',
      id: 'm1',
      text: 'Hello',
      sender: 'Asha',
    });
    expect(parseWebLine(JSON.stringify({ ...good, sender: undefined }))!.sender).toBe('Website visitor');
  });
  it('drops anything malformed', () => {
    for (const bad of [
      'not json',
      JSON.stringify({ ...good, type: 'reply' }),
      JSON.stringify({ ...good, platformId: '120363@g.us' }),
      JSON.stringify({ ...good, platformId: 'web:AB' }),
      JSON.stringify({ ...good, threadId: 'short' }),
      JSON.stringify({ ...good, threadId: '../../etc/passwd' }),
      JSON.stringify({ ...good, id: 'x'.repeat(81) }),
      JSON.stringify({ ...good, text: '   ' }),
      JSON.stringify({ ...good, text: 'x'.repeat(4001) }),
    ]) {
      expect(parseWebLine(bad)).toBeNull();
    }
  });
});

describe('web adapter', () => {
  let dir: string;
  let adapter: ChannelAdapter;
  const onInbound = vi.fn();
  const setup = {
    onInbound,
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  } as unknown as ChannelSetup;

  beforeEach(async () => {
    // A short path: Unix socket paths are limited to ~104 bytes on macOS.
    dir = fs.mkdtempSync(path.join('/tmp', 'webch-'));
    onInbound.mockReset();
    adapter = createWebAdapter(dir);
    await adapter.setup(setup);
  });
  afterEach(async () => {
    await adapter.teardown?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const connect = () =>
    new Promise<{ sock: net.Socket; lines: string[] }>((resolve) => {
      const lines: string[] = [];
      const sock = net.connect(webSocketPath(dir), () => resolve({ sock, lines }));
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
    });
  const tick = () => new Promise((r) => setTimeout(r, 50));

  it('listens on an owner-only socket and routes a visitor message as a threaded group message', async () => {
    expect(fs.statSync(webSocketPath(dir)).mode & 0o777).toBe(0o600);
    const { sock } = await connect();
    sock.write(JSON.stringify(good) + '\nnot json\n');
    await tick();
    expect(onInbound).toHaveBeenCalledTimes(1);
    const [platformId, threadId, msg] = onInbound.mock.calls[0]!;
    expect([platformId, threadId]).toEqual(['web:ab12cd34', 'conv_12345678']);
    expect(msg).toMatchObject({
      id: 'web-m1',
      kind: 'chat',
      isGroup: true,
      content: { text: 'Hello', sender: 'Asha', senderId: 'web:conv_12345678' },
    });
    sock.end();
  });

  it('sends replies to the client, and buffers them while nobody is connected', async () => {
    await adapter.deliver('web:ab12cd34', 'conv_12345678', {
      kind: 'chat',
      content: { text: 'While offline' },
    } as never);
    const { sock, lines } = await connect();
    await adapter.deliver('web:ab12cd34', 'conv_12345678', { kind: 'chat', content: { text: 'Namaste!' } } as never);
    await adapter.deliver('120363@g.us', 'conv_12345678', { kind: 'chat', content: { text: 'not mine' } } as never);
    await tick();
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { type: 'reply', platformId: 'web:ab12cd34', threadId: 'conv_12345678', text: 'While offline' },
      { type: 'reply', platformId: 'web:ab12cd34', threadId: 'conv_12345678', text: 'Namaste!' },
    ]);
    sock.end();
  });

  it('is off unless enabled', () => {
    const orig = process.env.NANOCLAW_WEB_CHANNEL;
    try {
      delete process.env.NANOCLAW_WEB_CHANNEL;
      expect(webChannelEnabled()).toBe(false);
      process.env.NANOCLAW_WEB_CHANNEL = 'true';
      expect(webChannelEnabled()).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.NANOCLAW_WEB_CHANNEL;
      else process.env.NANOCLAW_WEB_CHANNEL = orig;
    }
  });
});
