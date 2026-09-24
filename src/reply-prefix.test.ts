import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  plainDashesEnabled,
  replyPrefixMode,
  toPlainDashes,
  withGroupPrefix,
  withPlainDashes,
} from './reply-prefix.js';

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
    expect(src).toContain('plainDashesEnabled() ? withPlainDashes(msg.kind, msg.content)');
    const prefix = src.indexOf('let outContent =');
    const deliver = src.indexOf('await deliveryAdapter.deliver(', prefix);
    expect(prefix).toBeGreaterThan(-1);
    expect(src.slice(deliver, deliver + 200)).toContain('outContent');
  });
});

describe('plain dashes', () => {
  it('turns long dashes into hyphens, keeping word spacing and ranges tight', () => {
    expect(toPlainDashes('Ahmedabad \u2014 Gujarat')).toBe('Ahmedabad - Gujarat');
    expect(toPlainDashes('Ahmedabad\u2014Gujarat')).toBe('Ahmedabad-Gujarat');
    expect(toPlainDashes('10\u201312 people')).toBe('10-12 people');
    expect(toPlainDashes('no dashes here - ok')).toBe('no dashes here - ok');
  });

  it('rewrites text, card titles and questions only for chat kinds', () => {
    const card = JSON.stringify({
      type: 'ask_question',
      title: 'Pick \u2014 one',
      question: 'A\u2013B?',
      options: ['x'],
    });
    expect(JSON.parse(withPlainDashes('chat-sdk', card))).toMatchObject({ title: 'Pick - one', question: 'A-B?' });
    expect(JSON.parse(withPlainDashes('chat', JSON.stringify({ text: 'Hi \u2014 there' }))).text).toBe('Hi - there');
    const sys = JSON.stringify({ text: 'a\u2014b' });
    expect(withPlainDashes('system', sys)).toBe(sys);
  });

  it('is off unless NANOCLAW_PLAIN_DASHES=true', () => {
    const orig = process.env.NANOCLAW_PLAIN_DASHES;
    process.env.NANOCLAW_PLAIN_DASHES = 'true';
    expect(plainDashesEnabled()).toBe(true);
    process.env.NANOCLAW_PLAIN_DASHES = '1';
    expect(plainDashesEnabled()).toBe(false);
    if (orig === undefined) delete process.env.NANOCLAW_PLAIN_DASHES;
    else process.env.NANOCLAW_PLAIN_DASHES = orig;
  });
});
