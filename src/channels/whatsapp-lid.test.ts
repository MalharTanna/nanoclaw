import { describe, expect, it } from 'vitest';

import { lidMentionJids, parseWhatsAppMentions, rewriteLidMentions } from './whatsapp.js';

describe('rewriteLidMentions', () => {
  const map = { '57900554821694': '917016211523' };

  it("swaps a member's hidden LID tag for their phone number", () => {
    expect(rewriteLidMentions('Reminder: @57900554821694 go toys shopping', map)).toBe(
      'Reminder: @917016211523 go toys shopping',
    );
  });

  it('leaves phone tags, unknown numbers and plain text alone', () => {
    expect(rewriteLidMentions('@919974035496 hi', map)).toBe('@919974035496 hi');
    expect(rewriteLidMentions('call 57900554821694 now', map)).toBe('call 57900554821694 now');
    expect(rewriteLidMentions('no tags', map)).toBe('no tags');
  });

  it('then tags the phone JID, which WhatsApp shows as the member name', () => {
    const { mentions } = parseWhatsAppMentions(rewriteLidMentions('@57900554821694 hello', map));
    expect(mentions).toEqual(['917016211523@s.whatsapp.net']);
  });
});

describe('lidMentionJids', () => {
  it('tags a member whose LID has no known phone by the LID JID, so WhatsApp shows the name', () => {
    const { mentions } = parseWhatsAppMentions('Got it for Parth (@14624464351359)');
    expect(lidMentionJids(mentions, new Set(['14624464351359']))).toEqual(['14624464351359@lid']);
  });
  it('leaves phone tags alone', () => {
    expect(lidMentionJids(['917016211523@s.whatsapp.net'], new Set(['14624464351359']))).toEqual([
      '917016211523@s.whatsapp.net',
    ]);
  });
});
