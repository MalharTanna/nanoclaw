import { afterEach, describe, expect, it } from 'vitest';

import { addressesAssistant, assistantNames, displayName } from './assistant-names.js';
import { matchOwnerCommand } from './owner-commands.js';
import { ASSISTANT_NAME } from './config.js';

afterEach(() => delete process.env.ASSISTANT_ALIAS);

describe('Miro stays the name; a business may add its own', () => {
  it('shows "Miro (Asha)" and answers to either name', () => {
    expect(displayName(null)).toBe(ASSISTANT_NAME);
    expect(displayName('Asha')).toBe(`${ASSISTANT_NAME} (Asha)`);
    process.env.ASSISTANT_ALIAS = 'Asha';
    expect(assistantNames()).toEqual([ASSISTANT_NAME, 'Asha']);
    expect(addressesAssistant('asha, what time is it?')).toBe(true);
    expect(addressesAssistant(`hey ${ASSISTANT_NAME.toLowerCase()}`)).toBe(true);
    expect(addressesAssistant('Ashaben is here')).toBe(false);
    expect(matchOwnerCommand('Asha start')).toBe('start');
    expect(matchOwnerCommand('Miro stop')).toBe('stop');
  });

  it('an alias equal to the name is no alias', () => {
    process.env.ASSISTANT_ALIAS = ASSISTANT_NAME.toUpperCase();
    expect(displayName()).toBe(ASSISTANT_NAME);
  });
});
