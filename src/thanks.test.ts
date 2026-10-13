import { describe, expect, it } from 'vitest';

import { isPureThanks } from './thanks.js';

describe('isPureThanks', () => {
  it('recognises plain thanks in several languages and emoji', () => {
    for (const t of ['thanks', '@919800000000 Thank you so much Miro!', 'thx bhai', 'dhanyavad 🙏', 'Aabhar', 'ખૂબ આભાર'.replace('ખૂબ ', ''), 'धन्यवाद जी'.replace(' जी', ''), '🙏', '👍👍', 'thank you, great job', 'tysm'])
      expect(isPureThanks(t), t).toBe(true);
  });
  it('leaves anything that may need an answer to the AI', () => {
    for (const t of ['ok', 'yes', 'thanks, and what about tomorrow?', 'thanks, remind me at 5', 'nice', '😂', 'thanks for the pdf can you also send the invoice', '', 'no thanks stop the reminder'])
      expect(isPureThanks(t), t).toBe(false);
  });
});
