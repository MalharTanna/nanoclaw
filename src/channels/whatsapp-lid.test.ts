import { describe, expect, it } from 'vitest';

import {
  lidMentionJids,
  mayMessageChat,
  isOwnReplyText,
  personalChatAllowed,
  missedPrefix,
  parseWhatsAppMentions,
  pickMissedMessages,
  rewriteLidMentions,
  SendPacer,
} from './whatsapp.js';

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

describe('pickMissedMessages', () => {
  const msg = (id: string, jid: string, tsSec: number, fromMe = false) =>
    ({ key: { id, remoteJid: jid, fromMe }, message: { conversation: 'hi' }, messageTimestamp: tsSec }) as never;
  const since = 1_000_000_000;
  const until = since + 36_000;

  it('keeps messages from others sent while offline, oldest first, once', () => {
    const seen = new Set<string>();
    const got = pickMissedMessages(
      [
        msg('late', 'g1@g.us', since + 500),
        msg('early', 'g1@g.us', since + 100),
        msg('before', 'g1@g.us', since - 10),
        msg('after', 'g1@g.us', until + 10),
        msg('mine', 'g1@g.us', since + 200, true),
        msg('status', 'status@broadcast', since + 300),
        msg('dm', '919000000000@s.whatsapp.net', since + 50),
      ],
      since * 1000,
      until * 1000,
      seen,
    );
    expect(got.map((m) => m.key.id)).toEqual(['dm', 'early', 'late']);
    expect(pickMissedMessages([msg('early', 'g1@g.us', since + 100)], since * 1000, until * 1000, seen)).toEqual([]);
  });

  it('keeps only the latest 20 per chat', () => {
    const many = Array.from({ length: 25 }, (_, i) => msg(`m${i}`, 'g1@g.us', since + i + 1));
    const got = pickMissedMessages(many, since * 1000, until * 1000, new Set());
    expect(got).toHaveLength(20);
    expect(got[0]?.key.id).toBe('m5');
  });

  it('notes when it was sent', () => {
    expect(missedPrefix(Date.parse('2026-10-13T19:45:00Z') / 1000, 'Asia/Kolkata')).toBe(
      '(sent at 1:15 AM while I was offline) ',
    );
  });
});

describe('SendPacer', () => {
  it('keeps a gap between sends and caps sends per minute', async () => {
    let now = 0;
    const waits: number[] = [];
    const pacer = new SendPacer(
      1_500,
      3,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    for (let i = 0; i < 4; i++) await pacer.next();
    // 0, +1.5 s, +1.5 s, then the 4th waits until a minute after the 1st.
    expect(waits).toEqual([1_500, 1_500, 57_000]);
  });
});

describe('mayMessageChat', () => {
  it('allows groups, and personal chats only once that person has messaged', () => {
    const known = new Set(['919876543210@s.whatsapp.net']);
    expect(mayMessageChat('120363413823499258@g.us', known)).toBe(true);
    expect(mayMessageChat('919876543210@s.whatsapp.net', known)).toBe(true);
    expect(mayMessageChat('918287614988@s.whatsapp.net', known)).toBe(false);
  });
});

describe("personalChatAllowed - personal chats paused on an owner's own number", () => {
  it('allows everything unless paused; when paused, only listed numbers', () => {
    expect(personalChatAllowed('919974035496@s.whatsapp.net', {}, false)).toBe(true);
    const env = { WHATSAPP_PERSONAL_CHATS: 'off', WHATSAPP_PERSONAL_ALLOW: '91 98765 43210, 919999999999' };
    expect(personalChatAllowed('919974035496@s.whatsapp.net', env, false)).toBe(false);
    expect(personalChatAllowed('919876543210@s.whatsapp.net', env)).toBe(true);
    expect(personalChatAllowed('919999999999:3@s.whatsapp.net', env)).toBe(true);
    expect(personalChatAllowed('123456789@lid', env)).toBe(false);
  });
});

describe("isOwnReplyText - the assistant's own replies echoing back", () => {
  it('knows "Miro: ..." and the bold "*Miro (Asha):* ..."', () => {
    expect(isOwnReplyText('*Miro (Asha):* Done', 'Miro (Asha)')).toBe(true);
    expect(isOwnReplyText('Miro (Asha): Done', 'Miro (Asha)')).toBe(true);
    expect(isOwnReplyText('Miro, remind me', 'Miro (Asha)')).toBe(false);
  });
});
