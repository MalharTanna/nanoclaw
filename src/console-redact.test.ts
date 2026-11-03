import { describe, expect, it } from 'vitest';

import { installConsoleRedaction, isSessionRecord, redactConsoleArgs } from './console-redact.js';

class SessionEntry {
  registrationId = 1;
  currentRatchet = { ephemeralKeyPair: { privKey: Buffer.from('secret') } };
  indexInfo = { closed: -1 };
}

describe('session records stay out of the logs', () => {
  it('hides a Signal session record, keeps the message', () => {
    expect(redactConsoleArgs(['Closing session:', new SessionEntry()])).toEqual(['Closing session:', '[session details hidden]']);
  });

  it('also catches a plain object shaped like one', () => {
    expect(isSessionRecord({ currentRatchet: {}, indexInfo: {} })).toBe(true);
  });

  it('leaves everything else alone', () => {
    const err = new Error('boom');
    expect(redactConsoleArgs(['text', 3, null, { a: 1 }, err])).toEqual(['text', 3, null, { a: 1 }, err]);
  });

  it('applies to console.info and console.warn', () => {
    const seen: unknown[][] = [];
    const fake = { log: (...a: unknown[]) => seen.push(a), info: (...a: unknown[]) => seen.push(a), warn: (...a: unknown[]) => seen.push(a), error: (...a: unknown[]) => seen.push(a), debug: (...a: unknown[]) => seen.push(a) } as unknown as Console;
    installConsoleRedaction(fake);
    fake.info('Closing session:', new SessionEntry());
    fake.warn('Removing old closed session:', new SessionEntry());
    expect(JSON.stringify(seen)).not.toContain('privKey');
    expect(seen[0]).toEqual(['Closing session:', '[session details hidden]']);
  });
});
