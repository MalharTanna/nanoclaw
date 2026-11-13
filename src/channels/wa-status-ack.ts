/**
 * WhatsApp has started delivering some contacts' status updates as a
 * top-level <status> stanza. Baileys 7.0.0-rc.9 has no handler for it, so it
 * never acks one; about 50 minutes later the server ends the stream
 * ("Stream Errored (ack)", reported as 500 badSession), redelivers the same
 * stanza after the reconnect, and the cycle repeats. Messages arriving around
 * each drop come late or not at all. It hits numbers whose contacts post
 * statuses: a business's own number, not the shared one.
 *
 * A plain ack (no error code: a NACK keeps it pending) clears it, as whatsmeow
 * does. Drop this once Baileys ships its own handler (Baileys issue #2858).
 */
import type { BinaryNode, WASocket } from '@whiskeysockets/baileys';

import { log } from '../log.js';

type AckingSocket = Pick<WASocket, 'sendMessageAck'> & {
  ws: { on(event: string, fn: (node: BinaryNode) => void): unknown };
};

export function ackStatusStanzas(sock: AckingSocket): void {
  sock.ws.on('CB:status', (node: BinaryNode) => {
    sock.sendMessageAck(node).catch((err: unknown) => log.warn('Failed to ack status stanza', { err }));
  });
}
