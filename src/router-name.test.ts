import { describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({ wakeContainer: vi.fn(), isContainerRunning: vi.fn(() => false), killContainer: vi.fn() }));

import { addressesByName } from './router.js';

describe('addressesByName', () => {
  it('a message that starts with the name or types @Name addresses the assistant', () => {
    for (const t of ['Miro, what is the GST on this?', 'miro summarise this', 'Hey Miro remind me at 5', '@Miro hi', 'please check this @miro', '  MIRO: status?'])
      expect(addressesByName(t, 'Miro'), t).toBe(true);
  });
  it('mentioning the name in passing does not', () => {
    for (const t of ['I asked miro yesterday', 'Mirov is here', 'the miroflow plan', '', 'ok thanks'])
      expect(addressesByName(t, 'Miro'), t).toBe(false);
  });
});
