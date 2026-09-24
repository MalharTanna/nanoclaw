import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { replyPrefixMode, withGroupPrefix } from './reply-prefix.js';

describe('withGroupPrefix', () => {
  const chat = (c: object) => JSON.stringify(c);

  it('prefixes a plain text reply with the tenant bot name', () => {
    expect(JSON.parse(withGroupPrefix('chat', chat({ text: 'Hello!' }), 'Miro')).text).toBe('**Miro:** Hello!');
  });

  it('keeps other content fields', () => {
    const out = JSON.parse(withGroupPrefix('chat', chat({ text: 'See file', files: ['a.pdf'] }), 'Miro'));
    expect(out).toEqual({ text: '**Miro:** See file', files: ['a.pdf'] });
  });

  it('does not double-prefix', () => {
    const once = withGroupPrefix('chat', chat({ text: 'Hi' }), 'Miro');
    expect(withGroupPrefix('chat', once, 'Miro')).toBe(once);
  });

  it('leaves cards, edits, reactions, non-chat kinds, empty text and unnamed bots alone', () => {
    const cases: Array<[string, string, string | null]> = [
      ['chat-sdk', chat({ type: 'ask_question', text: 'Q' }), 'Miro'],
      ['chat', chat({ type: 'ask_question', text: 'Q' }), 'Miro'],
      ['chat', chat({ operation: 'edit', text: 'fixed' }), 'Miro'],
      ['system', chat({ text: 'x' }), 'Miro'],
      ['chat', chat({ text: '' }), 'Miro'],
      ['chat', chat({ files: ['a.pdf'] }), 'Miro'],
      ['chat', chat({ text: 'Hi' }), null],
      ['chat', 'not json', 'Miro'],
    ];
    for (const [kind, raw, name] of cases) expect(withGroupPrefix(kind, raw, name)).toBe(raw);
  });
});

describe('replyPrefixMode', () => {
  const orig = process.env.NANOCLAW_REPLY_PREFIX;
  afterEach(() => {
    if (orig === undefined) delete process.env.NANOCLAW_REPLY_PREFIX;
    else process.env.NANOCLAW_REPLY_PREFIX = orig;
  });

  it('is off unless explicitly set to group', () => {
    process.env.NANOCLAW_REPLY_PREFIX = 'group';
    expect(replyPrefixMode()).toBe('group');
    process.env.NANOCLAW_REPLY_PREFIX = 'yes';
    expect(replyPrefixMode()).toBe('off');
  });
});

describe('delivery wiring (structural)', () => {
  it("prefixes only when the install opts in, using the session group's assistant name", () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'delivery.ts'), 'utf-8');
    expect(src).toContain("replyPrefixMode() === 'group'");
    expect(src).toContain('getContainerConfig(session.agent_group_id)?.assistant_name');
    const prefix = src.indexOf('const outContent =');
    const deliver = src.indexOf('await deliveryAdapter.deliver(', prefix);
    expect(prefix).toBeGreaterThan(-1);
    expect(src.slice(deliver, deliver + 200)).toContain('outContent');
  });
});
