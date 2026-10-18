/**
 * `ncl notify send` - operator (host) only. Sends a Miroflow billing notice
 * (invoice / renewal reminder), optionally with one PDF, to a customer's
 * WhatsApp number from this install's own WhatsApp account.
 *
 * Driven by the Miroflow node-agent (`notify.send` command). Never reachable
 * from a container: the command is hostOnly (the guard denies every agent
 * caller, whatever its cli_scope) and the handler re-checks the caller. On
 * shared installs the tenant lock additionally limits agents to `tasks`.
 *
 * Delivery goes through the live WhatsApp channel adapter's own `deliver`,
 * the same path agent replies take:
 *   - with a PDF, the text is the document caption (sent as-is, no name prefix);
 *   - text only: on installs WITHOUT ASSISTANT_HAS_OWN_NUMBER=true the adapter
 *     prefixes "<ASSISTANT_NAME>: " like any bot reply. Miroflow installs run on
 *     a dedicated bot number, so the text normally goes out unchanged.
 * Sent ids are cached by the adapter, so the echo never wakes an agent.
 *
 * The file must be a .pdf inside this install's data/ directory (after
 * resolving symlinks) - no arbitrary file reads through this command.
 */
import fs from 'fs';
import path from 'path';
import { isOwnNumber } from '../../install-mode.js';

import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { DATA_DIR } from '../../config.js';
import { idTag } from '../../log-redact.js';
import { log } from '../../log.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

/** A person's WhatsApp chat id. Groups (@g.us) and LIDs are refused. */
const USER_JID = /^[0-9]{5,20}@s\.whatsapp\.net$/;
const GROUP_JID = /^[0-9-]{10,40}@g\.us$/;
const FILE_NAME = /^[A-Za-z0-9 ._()-]{1,120}$/;
const MAX_TEXT = 4_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Resolve `file` and refuse anything that is not a regular .pdf under the data dir. */
export function resolveNoticeFile(file: string, dataDir = DATA_DIR): string {
  if (!path.isAbsolute(file)) throw new Error('--file must be an absolute path');
  if (path.extname(file).toLowerCase() !== '.pdf') throw new Error('--file must be a .pdf');
  let real: string;
  let root: string;
  try {
    root = fs.realpathSync(dataDir);
    real = fs.realpathSync(file);
  } catch (err) {
    throw new Error('--file not found', { cause: err });
  }
  if (!real.startsWith(root + path.sep)) throw new Error('--file must be inside the install data directory');
  if (path.extname(real).toLowerCase() !== '.pdf') throw new Error('--file must be a .pdf');
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('--file is not a regular file');
  if (st.size === 0 || st.size > MAX_FILE_BYTES) throw new Error('--file size is out of range');
  return real;
}

export async function notifySend(args: Record<string, unknown>, ctx: CallerContext) {
  if (ctx.caller !== 'host') throw new Error('notify send is operator-only');

  const to = str(args.to);
  // A group only on a business's own number, for the notice when it turns Miro on there.
  const groupOk = isOwnNumber() && !!to && GROUP_JID.test(to);
  if (!to || (!USER_JID.test(to) && !groupOk)) throw new Error('--to must be a user JID (<digits>@s.whatsapp.net)');

  // --text-b64 lets callers pass any text safely (a value starting with "--"
  // would otherwise be read as a flag by the ncl client).
  const textB64 = str(args.text_b64);
  const textArg = str(args.text);
  if (!!textB64 === !!textArg) throw new Error('give exactly one of --text or --text-b64');
  const text = textB64 ? Buffer.from(textB64, 'base64').toString('utf8') : textArg!;
  if (!text.trim() || text.length > MAX_TEXT) throw new Error(`text must be 1-${MAX_TEXT} characters`);

  const fileArg = str(args.file);
  const nameArg = str(args.name);
  if (nameArg && !fileArg) throw new Error('--name needs --file');
  let file: { filename: string; data: Buffer } | undefined;
  if (fileArg) {
    const real = resolveNoticeFile(fileArg);
    const filename = nameArg ?? path.basename(real);
    if (!FILE_NAME.test(filename) || !filename.toLowerCase().endsWith('.pdf')) {
      throw new Error('--name must be a plain file name ending in .pdf');
    }
    const data = fs.readFileSync(real);
    if (data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('--file is not a PDF');
    file = { filename, data };
  }

  const adapter = getChannelAdapterExact('whatsapp');
  if (!adapter) throw new Error('WhatsApp is not running on this install');
  // Refuse rather than let the adapter queue it: a queued send has no id, and
  // the caller would retry and double-send once WhatsApp reconnects.
  if (!adapter.isConnected()) throw new Error('WhatsApp is not connected');

  const messageId = await adapter.deliver(to, null, {
    kind: 'chat',
    content: file ? { text, failOnFileError: true } : { text },
    files: file ? [file] : undefined,
  });
  log.info('Notice sent', { to: idTag(to), withFile: !!file, delivered: !!messageId });
  return { delivered: !!messageId, messageId: messageId ?? null };
}

registerResource({
  name: 'notify',
  plural: 'notify',
  table: '',
  description: "Operator-only notices (billing) sent from this install's WhatsApp number. Not available to agents.",
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    send: {
      access: 'open',
      hostOnly: true,
      description:
        "Send a notice to a person's WhatsApp (user JID), optionally with one PDF from the install data dir. OPERATOR-ONLY.\n" +
        'Use --to <digits>@s.whatsapp.net (--text <text> | --text-b64 <base64>) [--file <abs path>.pdf] [--name <shown file name>.pdf].',
      args: [
        { name: 'to', type: 'string', required: true, description: 'Recipient user JID (<digits>@s.whatsapp.net).' },
        { name: 'text', type: 'string', description: 'Message text (or the PDF caption).' },
        { name: 'text_b64', type: 'string', description: 'Message text, base64 (UTF-8). Use instead of --text.' },
        { name: 'file', type: 'string', description: 'Absolute path of a .pdf inside the install data/ directory.' },
        {
          name: 'name',
          type: 'string',
          description: "File name shown to the recipient (.pdf). Defaults to the file's own name.",
        },
      ],
      examples: ['ncl notify send --to 919876543210@s.whatsapp.net --text "Your Miroflow plan renews on 1 Nov."'],
      handler: notifySend,
    },
  },
});
