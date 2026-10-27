import { describe, expect, it } from 'vitest';

import { FOLLOW_UP_MS, FollowUpWindow } from './follow-up-window.js';

describe('FollowUpWindow - talk to Miro without tagging every message', () => {
  const plain = { addressed: false, tagsSomeoneElse: false };
  it('answers the same person for 5 minutes after they addressed Miro, sliding with each message', () => {
    const w = new FollowUpWindow();
    expect(w.apply('g|a', 0, plain)).toBe(false); // nothing addressed yet
    expect(w.apply('g|a', 1_000, { addressed: true, tagsSomeoneElse: false })).toBe(true);
    expect(w.apply('g|a', 1_000 + FOLLOW_UP_MS - 1, plain)).toBe(true);
    expect(w.apply('g|a', 1_000 + 2 * FOLLOW_UP_MS - 2, plain)).toBe(true); // slid
    expect(w.apply('g|a', 1_000 + 4 * FOLLOW_UP_MS, plain)).toBe(false); // quiet too long
  });

  it('only that person, only that group; tagging someone else ends it', () => {
    const w = new FollowUpWindow();
    w.apply('g|a', 0, { addressed: true, tagsSomeoneElse: false });
    expect(w.apply('g|b', 10, plain)).toBe(false);
    expect(w.apply('h|a', 10, plain)).toBe(false);
    expect(w.apply('g|a', 20, { addressed: false, tagsSomeoneElse: true })).toBe(false);
    expect(w.apply('g|a', 30, plain)).toBe(false);
  });
});
