import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { idTag } from './log-redact.js';

describe('idTag', () => {
  it('is stable per id, short, and does not contain the id', () => {
    const jid = '919876543210@s.whatsapp.net';
    const tag = idTag(jid)!;
    expect(tag).toMatch(/^#[0-9a-f]{10}$/);
    expect(idTag(jid)).toBe(tag);
    expect(tag).not.toContain('9876543210');
    expect(idTag('whatsapp:' + jid)).not.toBe(tag);
  });

  it('passes empty values through as null', () => {
    expect(idTag(null)).toBeNull();
    expect(idTag(undefined)).toBeNull();
    expect(idTag('')).toBeNull();
  });
});

describe('info-level logs carry tags, not raw ids or chat names (structural)', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', f), 'utf-8');

  it('router logs the sender and chat as tags', () => {
    const src = read('router.ts');
    expect(src).toMatch(/'Message routed', \{[^}]*user: idTag\(userId\)/s);
    expect(src).toMatch(/'Auto-created messaging group', \{[^}]*chat: idTag\(event\.platformId\)/s);
    expect(src).not.toMatch(/log\.\w+\([^)]*\{[^}]*platformId: event\.platformId/s);
  });

  it('channel metadata (chat name) is not logged at info', () => {
    const src = read('index.ts');
    expect(src).toMatch(/log\.debug\('Channel metadata discovered', \{[^}]*chat: idTag\(platformId\)/s);
    expect(src).not.toMatch(/'Channel metadata discovered', \{[^}]*\bname\b/s);
  });
});
