import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import { ackStatusStanzas } from './wa-status-ack.js';

describe('status stanzas are acked', () => {
  it('acks every <status> stanza with a plain ack (no error code)', async () => {
    const ws = new EventEmitter();
    const sendMessageAck = vi.fn().mockResolvedValue(undefined);
    ackStatusStanzas({ ws, sendMessageAck } as never);
    const node = { tag: 'status', attrs: { id: 'ABC', from: '919000000000@s.whatsapp.net', type: 'media' } };
    ws.emit('CB:status', node);
    expect(sendMessageAck).toHaveBeenCalledTimes(1);
    expect(sendMessageAck).toHaveBeenCalledWith(node);
  });

  it('a failed ack is logged, never thrown', async () => {
    const ws = new EventEmitter();
    ackStatusStanzas({ ws, sendMessageAck: vi.fn().mockRejectedValue(new Error('closed')) } as never);
    expect(() => ws.emit('CB:status', { tag: 'status', attrs: { id: 'X' } })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
