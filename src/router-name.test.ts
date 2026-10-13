import { describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn(),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
}));

import { addressesByName } from './router.js';

describe('addressesByName', () => {
  it('the name as a whole word anywhere, in any case, addresses the assistant', () => {
    for (const t of [
      'Miro, what is the GST on this?',
      'miro summarise this',
      'Hey Miro remind me at 5',
      '@Miro hi',
      'please check this @miro',
      '  MIRO: status?',
      'goodbye miro. removing you from group.',
      'I asked miro yesterday',
      'can mIrO check this?',
      'ok miro',
      'miro',
    ])
      expect(addressesByName(t, 'Miro'), t).toBe(true);
  });
  it('the name inside a longer word does not', () => {
    for (const t of [
      'MiroFlow is great',
      'see miroflow.in',
      'Mirov is here',
      'amiro',
      'miro_bot',
      'miro2',
      '',
      'ok thanks',
    ])
      expect(addressesByName(t, 'Miro'), t).toBe(false);
  });
});
