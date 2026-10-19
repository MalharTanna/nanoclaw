import { describe, expect, it } from 'vitest';

import { MediaAroundMention } from './media-around-mention.js';

const pdf = [{ name: 'quote.pdf' }];

describe('files just before or after mentioning Miro in a group', () => {
  it('a mention brings that person\'s file from the last 5 minutes', () => {
    const m = new MediaAroundMention<{ name: string }>();
    expect(m.apply('g|alice', 0, { addressed: false, attachments: pdf })).toEqual({ addressed: false, attachments: pdf });
    expect(m.apply('g|alice', 60_000, { addressed: true, attachments: [] })).toEqual({ addressed: true, attachments: pdf });
    // Used once.
    expect(m.apply('g|alice', 70_000, { addressed: true, attachments: [] }).attachments).toEqual([]);
  });

  it('a file within 2 minutes after a mention counts as addressed', () => {
    const m = new MediaAroundMention<{ name: string }>();
    m.apply('g|alice', 0, { addressed: true, attachments: [] });
    expect(m.apply('g|alice', 90_000, { addressed: false, attachments: pdf })).toEqual({ addressed: true, attachments: pdf });
    expect(m.apply('g|alice', 100_000, { addressed: false, attachments: pdf }).addressed).toBe(false); // only the next one
  });

  it('never another person\'s file, and not after the time is up', () => {
    const m = new MediaAroundMention<{ name: string }>();
    m.apply('g|bob', 0, { addressed: false, attachments: pdf });
    expect(m.apply('g|alice', 10_000, { addressed: true, attachments: [] }).attachments).toEqual([]);
    m.apply('g|carol', 0, { addressed: false, attachments: pdf });
    expect(m.apply('g|carol', 6 * 60_000, { addressed: true, attachments: [] }).attachments).toEqual([]);
    m.apply('g|dave', 0, { addressed: true, attachments: [] });
    expect(m.apply('g|dave', 3 * 60_000, { addressed: false, attachments: pdf }).addressed).toBe(false);
  });
});
