import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/nanoclaw-test-cli-notify-${process.pid}`;
  return {
    dataDir: `${dir}/data`,
    outside: `${dir}/outside`,
    adapter: {
      isConnected: vi.fn(() => true),
      deliver: vi.fn(async (_to: string, _thread: string | null, _msg: unknown) => 'WAMSG1' as string | undefined),
    },
    present: { value: true },
  };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: h.dataDir };
});

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapterExact: (key: string) => (key === 'whatsapp' && h.present.value ? h.adapter : undefined),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import './notify.js';

const host: CallerContext = { caller: 'host' };
const agent: CallerContext = { caller: 'agent', agentGroupId: 'ag-1', sessionId: 's-1', messagingGroupId: 'mg-1' };
const TO = '919876543210@s.whatsapp.net';
const PDF = Buffer.from('%PDF-1.4\n%fake invoice\n');

function send(args: Record<string, unknown>, ctx: CallerContext = host) {
  return dispatch({ id: 'r1', command: 'notify-send', args }, ctx);
}

function writeFile(dir: string, name: string, data: Buffer = PDF): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-1',
    name: 'AG1',
    folder: 'ag-1',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  fs.mkdirSync(h.dataDir, { recursive: true });
  h.present.value = true;
  h.adapter.isConnected.mockReset().mockReturnValue(true);
  h.adapter.deliver.mockReset().mockResolvedValue('WAMSG1');
});

afterEach(() => {
  closeDb();
  delete process.env.NANOCLAW_SHARED_NUMBER;
});

afterAll(() => {
  fs.rmSync(path.dirname(h.dataDir), { recursive: true, force: true });
});

describe('ncl notify send', () => {
  it('host: sends text through the WhatsApp adapter and returns the message id', async () => {
    const r = await send({ to: TO, text: 'Your Miroflow plan renews on 1 Nov.' });
    expect(r).toEqual({ id: 'r1', ok: true, data: { delivered: true, messageId: 'WAMSG1' } });
    expect(h.adapter.deliver).toHaveBeenCalledWith(TO, null, {
      kind: 'chat',
      content: { text: 'Your Miroflow plan renews on 1 Nov.' },
      files: undefined,
    });
  });

  it('host: decodes --text-b64 (text that starts with "--" survives)', async () => {
    const text = '-- Invoice INV-7 --\nAmount: Rs 7,080';
    const r = await send({ to: TO, 'text-b64': Buffer.from(text).toString('base64') });
    expect(r.ok).toBe(true);
    expect(h.adapter.deliver.mock.calls[0]![2]).toMatchObject({ content: { text } });
  });

  it('host: sends a PDF from the data dir with the shown file name, failing loudly on file errors', async () => {
    const file = writeFile(path.join(h.dataDir, 'notify-out'), 'abc123.pdf');
    const r = await send({ to: TO, text: 'Invoice attached', file, name: 'Miroflow Invoice INV-7.pdf' });
    expect(r).toMatchObject({ ok: true, data: { delivered: true, messageId: 'WAMSG1' } });
    expect(h.adapter.deliver).toHaveBeenCalledWith(TO, null, {
      kind: 'chat',
      content: { text: 'Invoice attached', failOnFileError: true },
      files: [{ filename: 'Miroflow Invoice INV-7.pdf', data: PDF }],
    });
  });

  it('reports delivered=false when the adapter returns no id', async () => {
    h.adapter.deliver.mockResolvedValue(undefined);
    expect(await send({ to: TO, text: 'hi' })).toMatchObject({ ok: true, data: { delivered: false, messageId: null } });
  });

  it('refuses when WhatsApp is not connected or not running (no queued double-sends)', async () => {
    h.adapter.isConnected.mockReturnValue(false);
    expect(await send({ to: TO, text: 'hi' })).toMatchObject({
      ok: false,
      error: { message: 'WhatsApp is not connected' },
    });
    h.present.value = false;
    expect(await send({ to: TO, text: 'hi' })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('not running') },
    });
    expect(h.adapter.deliver).not.toHaveBeenCalled();
  });

  it('agent callers are refused, on personal and shared (tenant-locked) installs', async () => {
    for (const shared of [false, true]) {
      if (shared) process.env.NANOCLAW_SHARED_NUMBER = 'true';
      const r = await send({ to: TO, text: 'hi' }, agent);
      expect(r).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(h.adapter.deliver).not.toHaveBeenCalled();
  });

  it('refuses group, LID and malformed JIDs', async () => {
    for (const to of [
      '120363413823499258@g.us',
      '123456789012345@lid',
      '919876543210',
      'x@s.whatsapp.net',
      '91-1@s.whatsapp.net',
    ]) {
      const r = await send({ to, text: 'hi' });
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'handler-error', message: expect.stringContaining('--to') },
      });
    }
    expect(h.adapter.deliver).not.toHaveBeenCalled();
  });

  it('refuses files outside the data dir, symlink escapes, non-PDFs and relative paths', async () => {
    const outside = writeFile(h.outside, 'secret.pdf');
    const link = path.join(h.dataDir, 'notify-out', 'link.pdf');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(outside, link);
    const env = writeFile(path.join(h.dataDir, 'notify-out'), 'env.txt', Buffer.from('SECRET=1'));
    const fakePdf = writeFile(path.join(h.dataDir, 'notify-out'), 'fake.pdf', Buffer.from('not a pdf'));
    const cases: Array<[string, string]> = [
      [outside, 'inside the install data directory'],
      [path.join(h.dataDir, '..', 'outside', 'secret.pdf'), 'inside the install data directory'],
      [link, 'inside the install data directory'],
      [env, '.pdf'],
      [fakePdf, 'not a PDF'],
      ['data/notify-out/x.pdf', 'absolute'],
      [path.join(h.dataDir, 'missing.pdf'), 'not found'],
      [os.tmpdir(), '.pdf'],
    ];
    for (const [file, msg] of cases) {
      const r = await send({ to: TO, text: 'hi', file });
      expect(r, file).toMatchObject({ ok: false, error: { message: expect.stringContaining(msg) } });
    }
    expect(h.adapter.deliver).not.toHaveBeenCalled();
  });

  it('validates text and the shown file name', async () => {
    const file = writeFile(path.join(h.dataDir, 'notify-out'), 'ok.pdf');
    expect((await send({ to: TO })).ok).toBe(false); // no text
    expect((await send({ to: TO, text: 'a', 'text-b64': 'YQ==' })).ok).toBe(false); // both
    expect((await send({ to: TO, text: 'x'.repeat(4_001) })).ok).toBe(false);
    expect((await send({ to: TO, text: 'hi', file, name: '../evil.pdf' })).ok).toBe(false);
    expect((await send({ to: TO, text: 'hi', file, name: 'invoice.exe' })).ok).toBe(false);
    expect((await send({ to: TO, text: 'hi', name: 'invoice.pdf' })).ok).toBe(false); // --name without --file
    expect((await send({ to: TO, text: 'hi', shell: 'x' })).ok).toBe(false); // unknown flag
    expect(h.adapter.deliver).not.toHaveBeenCalled();
  });
});
