/**
 * Web channel (SaaS website widget and API).
 *
 * The node-agent relays website visitors' messages over a Unix socket
 * (data/web.sock, 0600, so only the install's own user can connect). One
 * messaging group per business, platform id "web:<key>", treated as a group
 * with threads: each visitor conversation is a thread, so each gets its own
 * session and memory. Nothing listens on the network.
 *
 * Wire format, one JSON object per line:
 *   client -> server  {"type":"message","platformId":"web:<key>","threadId":"<conversation>",
 *                      "id":"<message id>","text":"...","sender":"<display name>"}
 *   server -> client  {"type":"reply","platformId":"web:<key>","threadId":"<conversation>","text":"..."}
 *
 * One client (the node-agent) at a time; a newer connection replaces an
 * older one. Replies produced while no client is connected are kept in a
 * small buffer and sent when one connects.
 *
 * Off unless NANOCLAW_WEB_CHANNEL=true.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

export const WEB_PLATFORM_ID = /^web:[a-z0-9]{6,40}$/;
export const WEB_THREAD_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const MAX_TEXT = 4_000;
const MAX_BUFFER = 500;

/** Every message in a web conversation is for the assistant; threads give one session per visitor. */
const WEB_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

export function webSocketPath(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'web.sock');
}

export interface WebInbound {
  platformId: string;
  threadId: string;
  id: string;
  text: string;
  sender: string;
}

/** Validate one client line; null for anything malformed (dropped, never routed). */
export function parseWebLine(line: string): WebInbound | null {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (p.type !== 'message') return null;
  const { platformId, threadId, id, text } = p;
  if (typeof platformId !== 'string' || !WEB_PLATFORM_ID.test(platformId)) return null;
  if (typeof threadId !== 'string' || !WEB_THREAD_ID.test(threadId)) return null;
  if (typeof id !== 'string' || !MESSAGE_ID.test(id)) return null;
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT) return null;
  const sender = typeof p.sender === 'string' && p.sender.trim() ? p.sender.trim().slice(0, 60) : 'Website visitor';
  return { platformId, threadId, id, text, sender };
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

export function createWebAdapter(dataDir = DATA_DIR): ChannelAdapter {
  let server: net.Server | null = null;
  let client: net.Socket | null = null;
  const pending: string[] = [];

  const send = (line: string) => {
    if (client) {
      try {
        client.write(line + '\n');
        return;
      } catch (err) {
        log.warn('Web channel: write failed, buffering', { err });
      }
    }
    pending.push(line);
    if (pending.length > MAX_BUFFER) pending.shift();
  };

  const adapter: ChannelAdapter = {
    name: 'web',
    channelType: 'web',
    supportsThreads: true,
    defaults: WEB_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      const sock = webSocketPath(dataDir);
      try {
        fs.unlinkSync(sock);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
          log.warn('Web channel: could not remove stale socket', { err });
      }
      server = net.createServer((socket) => onConnection(socket, config));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(sock, () => {
          try {
            fs.chmodSync(sock, 0o600);
          } catch (err) {
            log.warn('Web channel: chmod failed', { err });
          }
          log.info('Web channel listening', { sock });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      client?.end();
      client = null;
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
      try {
        fs.unlinkSync(webSocketPath(dataDir));
      } catch {
        // already gone
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      if (!WEB_PLATFORM_ID.test(platformId) || !threadId) return undefined;
      const text = extractText(message);
      if (text === null || text.trim() === '') return undefined;
      send(JSON.stringify({ type: 'reply', platformId, threadId, text }));
      return undefined;
    },
  };

  function onConnection(socket: net.Socket, config: ChannelSetup): void {
    if (client && client !== socket) client.end();
    client = socket;
    log.info('Web channel client connected');
    while (pending.length && client) client.write(pending.shift()! + '\n');

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 64_000 && buffer.indexOf('\n') < 0) buffer = ''; // runaway line
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const m = parseWebLine(line);
        if (!m) {
          log.warn('Web channel: dropped a malformed line');
          continue;
        }
        void Promise.resolve(
          config.onInbound(m.platformId, m.threadId, {
            id: `web-${m.id}`,
            kind: 'chat',
            timestamp: new Date().toISOString(),
            isGroup: true,
            content: { text: m.text, sender: m.sender, senderId: `web:${m.threadId}` },
          }),
        ).catch((err) => log.error('Web channel: onInbound threw', { err }));
      }
    });
    socket.on('close', () => {
      if (client === socket) client = null;
    });
    socket.on('error', (err) => log.warn('Web channel socket error', { err }));
  }

  return adapter;
}

/** Off unless NANOCLAW_WEB_CHANNEL=true (SaaS installs): a personal NanoClaw never opens the socket. */
export function webChannelEnabled(): boolean {
  const v = process.env.NANOCLAW_WEB_CHANNEL || readEnvFile(['NANOCLAW_WEB_CHANNEL']).NANOCLAW_WEB_CHANNEL;
  return v === 'true';
}

registerChannelAdapter('web', {
  factory: () => (webChannelEnabled() ? createWebAdapter() : null),
  defaults: WEB_DEFAULTS,
});
