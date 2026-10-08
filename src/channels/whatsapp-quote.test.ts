import { describe, expect, it } from 'vitest';

import { extractQuotedReply } from './whatsapp.js';

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
