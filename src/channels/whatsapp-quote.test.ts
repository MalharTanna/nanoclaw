import { describe, expect, it } from 'vitest';

import { extractQuotedReply, hideChatListMatches, hideChatSetting } from './whatsapp.js';

const reply = (quotedMessage: object, participant = '919900000001@s.whatsapp.net') => ({
  extendedTextMessage: {
    text: '@Miro what does this mean?',
    contextInfo: { stanzaId: 'Q1', participant, quotedMessage },
  },
});

describe('extractQuotedReply', () => {
  it('returns nothing for a normal message', () => {
    expect(extractQuotedReply({ conversation: 'hi' }, 'Miro')).toBeUndefined();
  });

  it('gives the quoted text and its author', () => {
    expect(extractQuotedReply(reply({ conversation: 'Hearing moved to 12 Oct' }), 'Miro')).toMatchObject({
      id: 'Q1',
      sender: '919900000001',
      text: 'Hearing moved to 12 Oct',
      fromBot: false,
    });
  });

  it("recognises a reply to the assistant's own message by its name prefix, and strips it", () => {
    const q = extractQuotedReply(reply({ conversation: 'Miro: *Miro:* The court is at Sr. 42' }), 'Miro');
    expect(q).toMatchObject({ sender: 'Miro', text: 'The court is at Sr. 42', fromBot: true });
  });

  it('recognises the bot by JID on its own number', () => {
    const q = extractQuotedReply(
      reply({ conversation: 'Done' }, '919800000000@s.whatsapp.net'),
      'Miro',
      '919800000000@s.whatsapp.net',
    );
    expect(q?.fromBot).toBe(true);
  });

  it('describes quoted media and hands documents, photos and voice notes over for download', () => {
    const doc = extractQuotedReply(
      reply({ documentMessage: { fileName: 'order.pdf', mimetype: 'application/pdf' } }),
      'Miro',
    );
    expect(doc?.text).toBe('[document: order.pdf]');
    expect(doc?.mediaMessage).toBeDefined();
    const photo = extractQuotedReply(reply({ imageMessage: { caption: 'site photo' } }), 'Miro');
    expect(photo?.text).toBe('[photo] site photo');
    const video = extractQuotedReply(reply({ videoMessage: {} }), 'Miro');
    expect(video?.mediaMessage).toBeUndefined();
  });
});

describe("clearing the bot number's chats after each reply", () => {
  it('WHATSAPP_HIDE_CHAT_JIDS takes a list of chats or "all"', () => {
    const g = '120363000000000001@g.us';
    expect(hideChatListMatches('', g)).toBe(false);
    expect(hideChatListMatches(`${g}, 919800000000@s.whatsapp.net`, g)).toBe(true);
    expect(hideChatListMatches('919800000000@s.whatsapp.net', g)).toBe(false);
    expect(hideChatListMatches(' ALL ', g)).toBe(true);
    expect(hideChatListMatches('none', g)).toBe(false);
  });

  it('never clears a personal chat, even with "all" (that logged the number out)', () => {
    expect(hideChatListMatches('all', '919687272526@s.whatsapp.net')).toBe(false);
    expect(hideChatListMatches('all', '14624464351359@lid')).toBe(false);
    expect(hideChatListMatches('919687272526@s.whatsapp.net', '919687272526@s.whatsapp.net')).toBe(false);
  });

  it('is off by default, even on a shared bot number (clear the phone by hand)', () => {
    expect(hideChatSetting(undefined, 'true')).toBe('');
    expect(hideChatSetting('', 'true')).toBe('');
    expect(hideChatSetting('none', 'true')).toBe('none');
    expect(hideChatSetting(undefined, undefined)).toBe('');
    expect(hideChatSetting('120363000000000001@g.us', undefined)).toBe('120363000000000001@g.us');
  });

  it('quoted replies need nothing from the cleared chat: text, author and media come inside the reply itself', () => {
    // After a clear the bot phone has no copy of the quoted message; everything
    // used here arrives in the user's reply (contextInfo.quotedMessage).
    const botReply = extractQuotedReply(reply({ conversation: '*Miro:* Court 19 is at Sr. No. 42' }), 'Miro');
    expect(botReply).toMatchObject({ fromBot: true, text: 'Court 19 is at Sr. No. 42' });
    const doc = extractQuotedReply(
      reply({
        documentMessage: { fileName: 'order.pdf', mimetype: 'application/pdf', mediaKey: 'k', directPath: '/d' },
      }),
      'Miro',
    );
    expect(doc?.text).toContain('[document: order.pdf]');
    expect(doc?.mediaMessage).toBeTruthy();
  });
});
