import { afterEach, describe, expect, it } from 'vitest';

import { installMode, isOwnNumber } from './install-mode.js';
import { tenantLocked } from './tenant-lock.js';
import { personalChatAllowed } from './channels/whatsapp.js';

const keys = ['NANOCLAW_SHARED_NUMBER', 'NANOCLAW_OWN_NUMBER'] as const;
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('install mode', () => {
  it('own number: tenant-locked like the shared number, but its own mode', () => {
    delete process.env.NANOCLAW_SHARED_NUMBER;
    process.env.NANOCLAW_OWN_NUMBER = 'true';
    expect(installMode()).toBe('own');
    expect(isOwnNumber()).toBe(true);
    expect(tenantLocked()).toBe(true);
  });

  it('shared wins if both are set; neither is a plain personal install', () => {
    process.env.NANOCLAW_SHARED_NUMBER = 'true';
    process.env.NANOCLAW_OWN_NUMBER = 'true';
    expect(installMode()).toBe('shared');
    process.env.NANOCLAW_SHARED_NUMBER = 'false';
    process.env.NANOCLAW_OWN_NUMBER = 'false';
    expect(installMode()).toBe('personal');
    expect(tenantLocked()).toBe(false);
  });
});

describe('personal chats on a business\'s own number', () => {
  it('are off unless turned on; allowed numbers still get through', () => {
    expect(personalChatAllowed('919974035496@s.whatsapp.net', {}, true)).toBe(false);
    expect(personalChatAllowed('919974035496@s.whatsapp.net', { WHATSAPP_PERSONAL_ALLOW: '919974035496' }, true)).toBe(true);
    expect(personalChatAllowed('919974035496@s.whatsapp.net', { WHATSAPP_PERSONAL_CHATS: 'on' }, true)).toBe(true);
    // A plain NanoClaw install keeps answering personal chats.
    expect(personalChatAllowed('919974035496@s.whatsapp.net', {}, false)).toBe(true);
  });
});
