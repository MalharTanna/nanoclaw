/**
 * WhatsApp channel adapter (v2) — native Baileys v7 implementation.
 *
 * Implements ChannelAdapter directly (no Chat SDK bridge) using
 * @whiskeysockets/baileys 7.0.0-rc.9 (pinned — last release, unmaintained).
 * Ports proven v1 infrastructure: getMessage fallback, outgoing queue,
 * group metadata cache, LID mapping, reconnection with backoff.
 *
 * LID handling: Baileys v7 provides participantAlt / remoteJidAlt on every
 * inbound message via extractAddressingContext, plus a real
 * signalRepository.lidMapping.getPNForLID API. The adapter always resolves
 * to phone JID (@s.whatsapp.net) before emitting to the router.
 *
 * Auth credentials persist in store/auth/. On first run:
 * - If WHATSAPP_PHONE_NUMBER is set → pairing code (printed to log)
 * - Otherwise → QR code (printed to log)
 * Subsequent restarts reuse the saved session automatically.
 */
import fs from 'fs';
import path from 'path';
// Named import (not default) — pino's .d.ts under NodeNext resolution
// exports `{ pino as default, pino }`, but the namespace/function merge at
// `declare namespace pino` + `declare function pino` makes the default
// resolve to `typeof pino` (the namespace type), which isn't callable.
// The named export resolves to the callable function.
import { pino } from 'pino';

import {
  makeWASocket,
  proto,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { GroupMetadata, WAMessageKey, WAMessage, WASocket } from '@whiskeysockets/baileys';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { noteConnectionDrop } from '../automation-pause.js';
import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, TIMEZONE } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { idTag } from '../log-redact.js';
import { registerChannelAdapter } from './channel-registry.js';
import { waChannel } from '../wa-mode.js';
import { isOwnNumber } from '../install-mode.js';
import { matchOwnerCommand } from '../owner-commands.js';
import { MediaAroundMention } from '../media-around-mention.js';
import { ensureOwnerSelfChat } from '../owner-self-chat.js';
import { isChatWired } from '../chat-wired.js';
import { addressesAssistant, displayName } from '../assistant-names.js';
import { DAILY_LIMIT_NOTICE, DailySendBudget, markLinked } from '../wa-limits.js';
import { flushQueuedJoins } from '../join-codes.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundMessage, OutboundMessage } from './adapter.js';

const baileysLogger = pino({ level: 'silent' });

/**
 * Fetch the latest WhatsApp Web version. Baileys' built-in
 * fetchLatestWaWebVersion scrapes sw.js which is aggressively
 * rate-limited (429). When it fails, Baileys falls back to a
 * hardcoded version that goes stale within weeks — WhatsApp
 * rejects connections with an expired buildHash (405 at Noise
 * layer). This fetches from wppconnect's version tracker as a
 * more reliable source, with Baileys' own fetch as fallback.
 */
async function resolveWaWebVersion(): Promise<[number, number, number]> {
  // 1. Try wppconnect version tracker (HTML scrape — no JSON API)
  try {
    const res = await fetch('https://wppconnect.io/whatsapp-versions/', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/2\.3000\.(\d+)/);
      if (match) {
        const version: [number, number, number] = [2, 3000, Number(match[1])];
        log.info('Fetched WA Web version from wppconnect', { version });
        return version;
      }
    }
  } catch {
    // Fall through to Baileys' own fetch
  }

  // 2. Try Baileys' built-in fetch (scrapes sw.js — often 429'd)
  try {
    const { version } = await fetchLatestWaWebVersion({});
    if (version) {
      log.info('Fetched WA Web version from Baileys', { version });
      return version as [number, number, number];
    }
  } catch {
    // Fall through
  }

  throw new Error(
    'Could not fetch current WhatsApp Web version from any source. ' +
      'Baileys hardcodes a stale version that WhatsApp rejects (405). ' +
      'Check network connectivity to wppconnect.io and web.whatsapp.com.',
  );
}

const AUTH_DIR = path.join(process.cwd(), 'store', 'auth');
const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const GROUP_METADATA_CACHE_TTL_MS = 60_000; // 1 min for outbound sends
const SENT_MESSAGE_CACHE_MAX = 256;
/** Own number: how long Miro stays shown as online after its last reply. */
export const ONLINE_AFTER_REPLY_MS = 20_000;
const RECONNECT_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const PENDING_QUESTIONS_MAX = 64;

/** Normalize an option label to a slash command: "Approve" → "/approve" */
function optionToCommand(option: string): string {
  return '/' + option.toLowerCase().replace(/\s+/g, '-');
}

// --- Markdown → WhatsApp formatting ---

interface TextSegment {
  content: string;
  isProtected: boolean;
}

/** Split text into code-block-protected and unprotected regions. */
function splitProtectedRegions(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const codeBlockRegex = /```[\s\S]*?```|`[^`\n]+`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ content: text.slice(lastIndex, match.index), isProtected: false });
    }
    segments.push({ content: match[0], isProtected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), isProtected: false });
  }

  return segments;
}

/** Apply WhatsApp-native formatting to an unprotected text segment. */
function transformForWhatsApp(text: string): string {
  // Order matters: italic before bold to avoid **bold** → *bold* → _bold_
  // 1. Italic: *text* (not **) → _text_
  text = text.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '_$1_');
  // 2. Bold: **text** → *text*
  text = text.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');
  // 3. Headings: ## Title → *Title*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // 4. Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // 5. Horizontal rules: --- / *** / ___ → stripped
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');
  return text;
}

// WhatsApp tags `@<phone-digits>` (5–15 digit local part — covers short test
// numbers up to ITU E.164 max). A leading `+` is accepted but stripped so
// the literal in text matches the digits in the JID — WhatsApp clients
// scan the rendered text for `@<digits>` and cross-reference it with the
// contextInfo.mentionedJid list to draw the bold/clickable tag.
const MENTION_RE = /(^|[^\w@+])@\+?(\d{5,15})(?!\d)/g;

/** Extract `@<digits>` mentions from text and normalize them. */
export function parseWhatsAppMentions(text: string): { text: string; mentions: string[] } {
  const mentions = new Set<string>();
  const out = text.replace(MENTION_RE, (_full, lead: string, digits: string) => {
    mentions.add(`${digits}@s.whatsapp.net`);
    return `${lead}@${digits}`;
  });
  return { text: out, mentions: [...mentions] };
}

/**
 * Replace `@<lid>` tags with `@<phone>`. WhatsApp now writes a mentioned
 * member's hidden LID number into the message text; tagging with it renders
 * as an unknown foreign number ("@+57 9005..."), while the phone number
 * renders as the member's name. `lidToPhone` maps LID user part -> phone
 * digits. Exported for unit testing.
 */
export function rewriteLidMentions(text: string, lidToPhone: Record<string, string>): string {
  if (!text.includes('@')) return text;
  return text.replace(MENTION_RE, (full, lead: string, digits: string) => {
    const phone = lidToPhone[digits];
    return phone ? `${lead}@${phone}` : full;
  });
}

/**
 * Tag members whose LID could not be turned into a phone number by their LID
 * JID. Tagging the bare digits as a phone JID renders as an unknown foreign
 * number ("@+1 4624..."); the LID JID renders as the member's name.
 * Exported for unit testing.
 */
export function lidMentionJids(mentions: string[], unresolvedLids: Set<string>): string[] {
  return mentions.map((jid) => {
    const user = jid.split('@')[0];
    return unresolvedLids.has(user) ? `${user}@lid` : jid;
  });
}

/**
 * Paces every outgoing WhatsApp send: at least `minGapMs` between sends and
 * at most `perMinute` in any minute, in order. Bursts (many reminders due at
 * the same minute) go out spread over time instead of all at once.
 * Exported for unit testing.
 */
export class SendPacer {
  private last = Number.NEGATIVE_INFINITY;
  private recent: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly minGapMs = 1_000,
    private readonly perMinute = 12,
    private readonly clock: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  /** Resolves when the next send may go out. */
  next(): Promise<void> {
    const turn = this.chain.then(() => this.slot());
    this.chain = turn.catch(() => {});
    return turn;
  }
  private async slot(): Promise<void> {
    let now = this.clock();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    let wait = Math.max(0, this.last + this.minGapMs - now);
    if (this.recent.length >= this.perMinute) wait = Math.max(wait, this.recent[0]! + 60_000 - now);
    if (wait > 0) {
      await this.sleep(wait);
      now = this.clock();
    }
    this.last = now;
    this.recent.push(now);
  }
}

/**
 * Shared bot number: never start a conversation. Groups (which added the
 * bot) are fine; a personal chat only once that person has messaged us.
 * Exported for unit testing.
 */
/**
 * WHATSAPP_PERSONAL_CHATS=off (the default on a business's own number,
 * NANOCLAW_OWN_NUMBER=true; =on turns them all on): answer groups only, and personal chats only
 * from the numbers in WHATSAPP_PERSONAL_ALLOW (comma-separated digits, e.g.
 * test phones). For running on a number that is also the owner's own
 * WhatsApp, so people writing to them personally never get the assistant.
 */
/**
 * A reply the assistant sent on a number shared with a person: it starts with
 * the bold label "*Miro:*" or "*Miro (Asha):*". The owner typing "Miro: ..."
 * (no bold) is a request, not an echo.
 */
export function isOwnReplyText(content: string, name: string = displayName()): boolean {
  return content.startsWith(`*${name}:*`) || content.startsWith(`*${ASSISTANT_NAME}:*`);
}

export const GROUP_LIST_FILE = 'wa-groups.json';

type GroupMetaLike = {
  subject?: string | null;
  size?: number | null;
  participants?: unknown[] | null;
  isCommunity?: boolean | null;
  isCommunityAnnounce?: boolean | null;
  linkedParent?: string | null;
};

/**
 * The groups this number is in, for the business to turn Miro on or off from
 * its dashboard: id, name, member count and whether it is a community. Names
 * are the group's own subject; no member details are kept. Sorted by name.
 */
export function groupList(
  groups: Record<string, GroupMetaLike>,
): { jid: string; name: string; size: number; community: boolean }[] {
  return Object.entries(groups)
    .filter(([jid]) => jid.endsWith('@g.us'))
    .map(([jid, m]) => ({
      jid,
      name: (m.subject ?? '').slice(0, 120),
      size: m.size ?? m.participants?.length ?? 0,
      community: Boolean(m.isCommunity || m.isCommunityAnnounce || m.linkedParent),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500);
}

function writeGroupList(file: string, groups: Record<string, GroupMetaLike>): void {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), groups: groupList(groups) }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    log.warn('Could not save the group list', { err });
  }
}

export function personalChatAllowed(
  jid: string,
  env: Record<string, string | undefined> = readEnvFile(['WHATSAPP_PERSONAL_CHATS', 'WHATSAPP_PERSONAL_ALLOW']),
  ownNumber: boolean = isOwnNumber(),
): boolean {
  // On a business's own number personal chats are off unless turned on.
  const setting = process.env.WHATSAPP_PERSONAL_CHATS || env.WHATSAPP_PERSONAL_CHATS;
  if (setting === 'on' || (setting !== 'off' && !ownNumber)) return true;
  const digits = jid.split('@')[0]!.split(':')[0]!;
  const allow = (process.env.WHATSAPP_PERSONAL_ALLOW || env.WHATSAPP_PERSONAL_ALLOW || '')
    .split(',')
    .map((d) => d.replace(/\D/g, ''))
    .filter(Boolean);
  return jid.endsWith('@s.whatsapp.net') && allow.includes(digits);
}

export function mayMessageChat(jid: string, knownPersonalChats: Set<string>): boolean {
  if (jid.endsWith('@g.us')) return true;
  return knownPersonalChats.has(jid);
}

/** Offline gaps shorter than this are normal reconnects; longer than the max are too stale to answer. */
export const MISSED_MIN_GAP_MS = 2 * 60_000;
export const MISSED_MAX_GAP_MS = 48 * 60 * 60_000;
const MISSED_PER_CHAT = 20;

/**
 * Messages from a history sync that arrived while this install was offline:
 * from other people, sent after `sinceMs` and up to `untilMs` (when we came
 * back), not already handled. Oldest first, at most 20 per chat (the latest).
 * Exported for unit testing.
 */
export function pickMissedMessages(
  messages: WAMessage[],
  sinceMs: number,
  untilMs: number,
  seen: Set<string>,
): WAMessage[] {
  const byChat = new Map<string, WAMessage[]>();
  for (const m of messages) {
    const jid = m.key?.remoteJid;
    const id = m.key?.id;
    if (!m.message || !jid || !id || m.key.fromMe || jid === 'status@broadcast' || seen.has(id)) continue;
    const ts = Number(m.messageTimestamp) * 1000;
    if (!(ts > sinceMs && ts <= untilMs)) continue;
    const list = byChat.get(jid) ?? [];
    list.push(m);
    byChat.set(jid, list);
  }
  const out: WAMessage[] = [];
  for (const list of byChat.values()) {
    list.sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
    out.push(...list.slice(-MISSED_PER_CHAT));
  }
  for (const m of out) seen.add(m.key.id!);
  return out.sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
}

/** "(sent at 1:15 AM while I was offline) " in the install's time zone. */
export function missedPrefix(tsSeconds: number, timeZone: string): string {
  const t = new Date(tsSeconds * 1000).toLocaleTimeString('en-IN', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `(sent at ${t.toUpperCase()} while I was offline) `;
}

/**
 * Convert Claude's markdown to WhatsApp-native formatting and extract any
 * `@<phone>` mentions. Code-block regions are passed through untouched so
 * phone-like sequences inside code aren't tagged.
 */
function formatWhatsApp(text: string): { text: string; mentions: string[] } {
  const segments = splitProtectedRegions(text);
  const mentions = new Set<string>();
  const out = segments
    .map(({ content, isProtected }) => {
      if (isProtected) return content;
      const transformed = transformForWhatsApp(content);
      const { text: withMentions, mentions: found } = parseWhatsAppMentions(transformed);
      for (const m of found) mentions.add(m);
      return withMentions;
    })
    .join('');
  return { text: out, mentions: [...mentions] };
}

/**
 * Subset of a normalized Baileys message content carrying the message
 * types that can host a `contextInfo.mentionedJid` array. Kept as a
 * structural type so the helper (and its tests) don't pull in the full
 * `proto.IMessage` shape just to construct fixtures.
 */
type MentionContextSource = {
  extendedTextMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
  imageMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
  videoMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
  documentMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
};

/**
 * Detect an explicit @-mention of the bot in a WhatsApp group message.
 * WhatsApp carries mentions in `contextInfo.mentionedJid` on the text +
 * caption-bearing message types. Matches against both the bot's phone
 * JID and LID — most modern clients emit the LID even when the human
 * typed a phone-number mention.
 *
 * Exported for unit testing. The inbound construction site calls this
 * to set `InboundMessage.isMention` for group messages (#2560). DMs are
 * unconditionally mentions and don't go through this helper.
 */
export function isBotMentionedInGroup(
  normalized: MentionContextSource,
  botPhoneJid: string | undefined,
  botLidUser: string | undefined,
): boolean {
  if (!botPhoneJid && !botLidUser) return false;
  const mentionedJids: string[] = [
    ...(normalized.extendedTextMessage?.contextInfo?.mentionedJid ?? []),
    ...(normalized.imageMessage?.contextInfo?.mentionedJid ?? []),
    ...(normalized.videoMessage?.contextInfo?.mentionedJid ?? []),
    ...(normalized.documentMessage?.contextInfo?.mentionedJid ?? []),
  ];
  const botLidJid = botLidUser ? `${botLidUser}@lid` : undefined;
  return mentionedJids.some((jid) => {
    if (!jid) return false;
    const bare = jid.split(':')[0];
    return bare === botPhoneJid || bare === botLidJid;
  });
}

/** The message a quote-reply points at, as WhatsApp carries it in `contextInfo`. */
export interface QuotedReply {
  id: string;
  /** Display name for the quoted author: the assistant, or the author's number. */
  sender: string;
  text: string;
  /** The quoted message was one of the assistant's own replies. */
  fromBot: boolean;
  /** Author JID of the quoted message (needed to download its media). */
  participant?: string;
  /** The quoted message itself, when it carries media worth attaching. */
  mediaMessage?: Record<string, unknown>;
}

const QUOTE_HOSTS = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'audioMessage'] as const;
const QUOTE_TEXT_MAX = 2000;

/**
 * Read the quoted message of a WhatsApp quote-reply ("reply" on a message),
 * so the assistant sees what is being replied to. Returns undefined for a
 * normal message. Exported for unit testing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/**
 * WHATSAPP_HIDE_CHAT_JIDS: a comma-separated list of chat JIDs, or `all`. The
 * Miroflow number uses `all`: its WhatsApp chats are cleared after each reply
 * (history stays in the session DBs, for memory and exports).
 */
export function hideChatListMatches(list: string, jid: string): boolean {
  // Groups only. Clearing a personal chat (seen with first-contact chats that
  // WhatsApp addresses by hidden ID) got the bot number logged out (401)
  // seconds later, twice; personal chats keep their history on the bot phone.
  if (!jid.toLowerCase().endsWith('@g.us')) return false;
  const entries = list
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (entries.includes('none')) return false;
  return entries.includes('all') || entries.includes(jid.toLowerCase());
}

/**
 * The effective WHATSAPP_HIDE_CHAT_JIDS: as set, else nothing. Clearing is
 * off by default everywhere: automated clears on the Miroflow number preceded
 * both of its logouts and its ban, so the bot phone is cleared by hand.
 */
export function hideChatSetting(configured: string | undefined, _sharedNumber: string | undefined): string {
  if (configured !== undefined && configured.trim() !== '') return configured;
  return '';
}

export function extractQuotedReply(
  normalized: any,
  assistantName: string,
  botPhoneJid?: string,
  botLidUser?: string,
): QuotedReply | undefined {
  let ctx:
    | { stanzaId?: string | null; participant?: string | null; quotedMessage?: Record<string, any> | null }
    | undefined;
  for (const host of QUOTE_HOSTS) {
    const c = normalized?.[host]?.contextInfo;
    if (c?.quotedMessage) {
      ctx = c;
      break;
    }
  }
  const q = ctx?.quotedMessage;
  if (!ctx || !q) return undefined;

  const doc = q.documentMessage ?? q.documentWithCaptionMessage?.message?.documentMessage;
  let text: string =
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    doc?.caption ||
    '';
  const media = q.imageMessage
    ? '[photo]'
    : q.videoMessage
      ? '[video]'
      : q.audioMessage
        ? '[voice note]'
        : doc
          ? `[document: ${String(doc.fileName ?? 'file')}]`
          : '';
  if (media) text = text ? `${media} ${text}` : media;

  // The adapter prefixes replies on a shared number ("Miro: ..."); a group
  // prefix may follow ("*Miro:* ..."). Either marks the bot as the author.
  const prefixes = [`${assistantName}: `, `*${assistantName}:* `, `**${assistantName}:** `];
  let fromBot = false;
  for (const prefix of prefixes) {
    while (text.startsWith(prefix)) {
      fromBot = true;
      text = text.slice(prefix.length);
    }
  }
  const participant = ctx.participant ?? undefined;
  const bare = participant?.split(':')[0];
  if (bare && (bare === botPhoneJid || (botLidUser && bare === `${botLidUser}@lid`))) fromBot = true;

  return {
    id: String(ctx.stanzaId ?? ''),
    sender: fromBot ? assistantName : (participant?.split('@')[0] ?? 'someone'),
    text: text.length > QUOTE_TEXT_MAX ? text.slice(0, QUOTE_TEXT_MAX) + '…' : text,
    fromBot,
    participant,
    mediaMessage: media && media !== '[video]' ? q : undefined,
  };
}

/**
 * Compute `InboundMessage.isMention` for a WhatsApp message:
 *   - DMs are always mentions (router auto-engages on the bot's behalf).
 *   - Group messages are mentions only when the bot is explicitly tagged.
 *
 * Returns `true | undefined` rather than `true | false` because the
 * `InboundMessage` field is `isMention?: boolean` and downstream code
 * treats `undefined` differently than an explicit `false` (#2560).
 */
export function computeIsMention(isGroup: boolean, botMentionedInGroup: boolean): true | undefined {
  if (!isGroup) return true;
  return botMentionedInGroup ? true : undefined;
}

/**
 * MIME type for a file sent as a WhatsApp document. A generic
 * application/octet-stream makes phones show the file as ".bin" and refuse
 * to open it, so common office/PDF types are named explicitly.
 */
const DOCUMENT_MIMETYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.svg': 'image/svg+xml',
};

export function documentMimetype(ext: string): string {
  return DOCUMENT_MIMETYPES[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Map file extension to Baileys media message type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMediaMessage(data: Buffer, filename: string, ext: string, caption?: string): any {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv'];
  const audioExts = ['.mp3', '.ogg', '.m4a', '.wav', '.aac', '.opus'];

  if (imageExts.includes(ext)) {
    return { image: data, caption, mimetype: `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}` };
  }
  if (videoExts.includes(ext)) {
    return { video: data, caption, mimetype: `video/${ext.slice(1)}` };
  }
  if (audioExts.includes(ext)) {
    return { audio: data, mimetype: `audio/${ext.slice(1) === 'mp3' ? 'mpeg' : ext.slice(1)}` };
  }
  // Default: send as document
  return { document: data, fileName: filename, caption, mimetype: documentMimetype(ext) };
}

registerChannelAdapter('whatsapp', {
  factory: () => {
    const env = readEnvFile(['WHATSAPP_PHONE_NUMBER', 'WHATSAPP_ENABLED']);
    const phoneNumber = env.WHATSAPP_PHONE_NUMBER;
    const authDir = AUTH_DIR;

    // Miroflow on the official Business API: the linked device stays off.
    if (waChannel() === 'api') return null;

    // Skip if no existing auth, no phone number for pairing, and not explicitly enabled (QR mode)
    const hasAuth = fs.existsSync(path.join(authDir, 'creds.json'));
    if (!hasAuth && !phoneNumber && !env.WHATSAPP_ENABLED) return null;

    fs.mkdirSync(authDir, { recursive: true });

    // State
    let sock: WASocket;
    let connected = false;
    let shuttingDown = false;
    let setupConfig: ChannelSetup;

    // Reconnect control. Without these, `connection.update` → close → immediate
    // connectSocket() forms an unbounded tight loop: connectSocket() resolves as
    // soon as the socket object exists, so a socket that dies a millisecond later
    // reconnects with zero delay. Each cycle also leaked another live socket and
    // its `connection.update` listener, so every subsequent close fired N stacked
    // handlers — amplifying to ~27k reconnects/minute, exhausting the heap, and
    // shredding the Signal session store mid-write (undecryptable outgoing
    // messages for every peer whose ratchet drifted).
    let reconnecting = false;
    let reconnectAttempt = 0;
    let reconnectTimer: NodeJS.Timeout | undefined;
    // Only the newest socket may drive reconnects; listeners on superseded
    // sockets check their generation and bail.
    let socketGeneration = 0;

    // LID → phone JID mapping (WhatsApp's new ID system)
    const lidToPhoneMap: Record<string, string> = {};
    // LIDs seen in incoming tags that WhatsApp would not map to a phone number.
    const unresolvedLids = new Set<string>();
    let botLidUser: string | undefined;
    let botPhoneJid: string | undefined;

    // Outgoing queue for messages sent while disconnected
    const outgoingQueue: Array<{ jid: string; text: string; mentions?: string[] }> = [];
    let flushing = false;

    // Sent message cache for retry/re-encrypt requests
    const sentMessageCache = new Map<string, any>();

    // Shared bot number safety: paced sends, and no message to a person who
    // has never messaged this number (kept on disk across restarts).
    const sharedNumber = readEnvFile(['NANOCLAW_SHARED_NUMBER']).NANOCLAW_SHARED_NUMBER === 'true';
    // Miroflow on a shared number or a business's own number: same sending limits.
    const safetyLimits = sharedNumber || isOwnNumber();
    const pacer = new SendPacer();
    const knownChatsFile = path.join(process.cwd(), 'store', 'known-personal-chats.json');
    const knownPersonalChats = new Set<string>(
      (() => {
        try {
          const list = JSON.parse(fs.readFileSync(knownChatsFile, 'utf8')) as unknown;
          return Array.isArray(list) ? list.filter((j): j is string => typeof j === 'string') : [];
        } catch {
          return [];
        }
      })(),
    );
    const notePersonalChat = (...jids: string[]) => {
      const fresh = jids.filter((j) => j && !j.endsWith('@g.us') && !knownPersonalChats.has(j));
      if (fresh.length === 0) return;
      for (const j of fresh) knownPersonalChats.add(j);
      try {
        fs.writeFileSync(knownChatsFile, JSON.stringify([...knownPersonalChats]), { mode: 0o600 });
      } catch {
        /* best effort */
      }
    };
    const budget = new DailySendBudget();
    const mediaAround = new MediaAroundMention<Awaited<ReturnType<typeof downloadInboundMedia>>[number]>();
    let joinTimer: NodeJS.Timeout | null = null;
    // Own number: online only while replying, like a person using WhatsApp
    // Web, then offline again (see markOnlineOnConnect).
    let shownOnline = false;
    let offlineTimer: NodeJS.Timeout | null = null;
    function onlineWhileReplying(): void {
      if (!isOwnNumber()) return;
      if (!shownOnline) {
        shownOnline = true;
        sock.sendPresenceUpdate('available').catch((err) => log.debug('Failed to show online', { err }));
      }
      if (offlineTimer) clearTimeout(offlineTimer);
      offlineTimer = setTimeout(() => {
        offlineTimer = null;
        shownOnline = false;
        sock.sendPresenceUpdate('unavailable').catch((err) => log.debug('Failed to show offline', { err }));
      }, ONLINE_AFTER_REPLY_MS);
      offlineTimer.unref?.();
    }

    /** Every send goes through here: cold-chat guard, the number's daily limit, then the pacer. */
    async function safeSend(jid: string, content: Parameters<WASocket['sendMessage']>[1]) {
      if (safetyLimits && jid !== botPhoneJid && !mayMessageChat(jid, knownPersonalChats)) {
        log.warn('Not sending: this person has never messaged the bot number', { jid: idTag(jid) });
        return undefined;
      }
      if (safetyLimits) {
        const verdict = budget.take(jid);
        if (verdict === 'hold') {
          log.warn('Not sending: daily message limit for this number reached', {
            jid: idTag(jid),
            limit: budget.ceiling(),
          });
          return undefined;
        }
        if (verdict === 'notice') {
          log.warn('Daily message limit reached: telling this chat once', { jid: idTag(jid), limit: budget.ceiling() });
          content = { text: DAILY_LIMIT_NOTICE };
        }
      }
      await pacer.next();
      onlineWhileReplying();
      return sock.sendMessage(jid, content);
    }

    // Missed-message catch-up. The last time we were online is kept on disk
    // (outside store/auth, which a logout wipes). When a fresh link comes up
    // after a real gap, WhatsApp's history sync carries the messages sent in
    // between; those are handled like new ones, noted as sent while offline.
    const lastOnlineFile = path.join(process.cwd(), 'store', 'wa-last-online.json');
    let lastOnlineWrite = 0;
    const noteOnline = (force = false) => {
      const now = Date.now();
      if (!force && now - lastOnlineWrite < 30_000) return;
      lastOnlineWrite = now;
      try {
        fs.writeFileSync(lastOnlineFile, JSON.stringify({ at: now, number: ownNumber() }));
      } catch {
        /* best effort */
      }
    };
    /** This install's number (digits). The catch-up only covers a gap on the same number. */
    const ownNumber = (): string | null =>
      sock?.user?.id?.split(':')[0]?.split('@')[0] ?? phoneNumber?.replace(/\D/g, '') ?? null;
    const readLastOnline = (): number | null => {
      try {
        const { at, number } = JSON.parse(fs.readFileSync(lastOnlineFile, 'utf8')) as {
          at?: unknown;
          number?: unknown;
        };
        // Linking a different number: its own chats' history is not ours to answer.
        const want = phoneNumber?.replace(/\D/g, '');
        if (typeof number !== 'string' || !want || number !== want) return null;
        return typeof at === 'number' ? at : null;
      } catch {
        return null;
      }
    };
    let catchup: { since: number; until: number; openUntil: number } | null = null;
    // Only a fresh link (no account on disk, e.g. after a logout) gets a
    // history sync of the gap; an ordinary reconnect gets missed messages live.
    let freshLink = false;
    const seenMissed = new Set<string>();
    setInterval(() => {
      if (connected) noteOnline();
    }, 60_000).unref();

    // Disk-backed copy of sent messages. An in-memory-only cache means any
    // message sent before a restart can't be re-encrypted when a recipient
    // sends a decryption-retry receipt → permanent "Waiting for this message".
    // Persisting them lets getMessage satisfy retries across restarts.
    const sentMsgDir = path.join(process.cwd(), 'store', 'wa-sent');
    try {
      fs.mkdirSync(sentMsgDir, { recursive: true });
    } catch {
      /* best effort */
    }
    const sentMsgPath = (id: string) => path.join(sentMsgDir, encodeURIComponent(id));
    let sentWriteCount = 0;
    // Copies of sent messages are kept at most SENT_MSG_MAX_AGE_MS (the Privacy
    // Notice promises up to 14 days) and at most SENT_MSG_DISK_MAX files.
    const SENT_MSG_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
    const SENT_MSG_DISK_MAX = 5000;
    function pruneSentStore(): void {
      try {
        const cutoff = Date.now() - SENT_MSG_MAX_AGE_MS;
        const files = fs
          .readdirSync(sentMsgDir)
          .map((f) => ({ f, t: fs.statSync(path.join(sentMsgDir, f)).mtimeMs }))
          .sort((a, b) => a.t - b.t);
        files.forEach(({ f, t }, i) => {
          if (t < cutoff || i < files.length - SENT_MSG_DISK_MAX) fs.unlinkSync(path.join(sentMsgDir, f));
        });
      } catch {
        /* ignore prune failures */
      }
    }
    pruneSentStore();
    const sentPruneTimer = setInterval(pruneSentStore, 6 * 60 * 60_000);
    sentPruneTimer.unref?.();

    function cacheSentMessage(id: string | null | undefined, message: unknown): void {
      if (!id || !message) return;
      sentMessageCache.set(id, message);
      if (sentMessageCache.size > SENT_MESSAGE_CACHE_MAX) {
        const oldest = sentMessageCache.keys().next().value!;
        sentMessageCache.delete(oldest);
      }
      try {
        const bytes = proto.Message.encode(message as proto.IMessage).finish();
        fs.writeFileSync(sentMsgPath(id), Buffer.from(bytes).toString('base64'));
      } catch {
        /* best effort — re-send recovery is opportunistic */
      }
      // Bound the on-disk store periodically (age and count).
      if (++sentWriteCount % 256 === 0) pruneSentStore();
    }
    function loadSentMessage(id: string): proto.IMessage | undefined {
      try {
        const p = sentMsgPath(id);
        if (!fs.existsSync(p)) return undefined;
        return proto.Message.decode(Buffer.from(fs.readFileSync(p, 'utf-8'), 'base64'));
      } catch {
        return undefined;
      }
    }

    // Group metadata cache with TTL
    const groupMetadataCache = new Map<string, { metadata: GroupMetadata; expiresAt: number }>();

    // Pending questions: chatJid → { questionId, options }
    // User replies with /approve, /reject, etc. to answer
    const pendingQuestions = new Map<
      string,
      {
        questionId: string;
        options: NormalizedOption[];
      }
    >();

    // Group sync tracking
    let lastGroupSync = 0;
    let groupSyncTimerStarted = false;

    // First-connect promise
    let resolveFirstOpen: (() => void) | undefined;
    let rejectFirstOpen: ((err: Error) => void) | undefined;

    // Pairing code file for the setup skill to poll
    const pairingCodeFile = path.join(process.cwd(), 'store', 'pairing-code.txt');
    // Relink by QR instead of a code (chosen in the Miroflow admin): the
    // node-agent writes "qr" here before restarting; each rotating QR is then
    // saved to pairing-qr.txt for it to send up. Both go once linked.
    const pairMethodFile = path.join(process.cwd(), 'store', 'pair-method.txt');
    const pairingQrFile = path.join(process.cwd(), 'store', 'pairing-qr.txt');
    const qrPairing = (() => {
      try {
        return fs.readFileSync(pairMethodFile, 'utf8').trim() === 'qr';
      } catch {
        return false;
      }
    })();

    // --- Helpers ---

    function setLidPhoneMapping(lidUser: string, phoneJid: string): void {
      if (lidToPhoneMap[lidUser] === phoneJid) return;
      lidToPhoneMap[lidUser] = phoneJid;
      // Cached group metadata depends on participant IDs — invalidate
      groupMetadataCache.clear();
    }

    /**
     * LID user part -> phone digits for every `@<digits>` tag in outgoing text,
     * from the in-memory map or WhatsApp's own LID store (survives restarts).
     */
    async function lidPhoneDigits(text: string, chatJid?: string): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      let members: GroupMetadata['participants'] | undefined;
      for (const m of text.matchAll(MENTION_RE)) {
        const digits = m[2];
        if (out[digits]) continue;
        const known = lidToPhoneMap[digits];
        if (known) {
          out[digits] = known.split('@')[0];
          continue;
        }
        try {
          const pn = await sock.signalRepository.lidMapping.getPNForLID(`${digits}@lid`);
          if (pn) {
            const phone = pn.split('@')[0].split(':')[0];
            setLidPhoneMapping(digits, `${phone}@s.whatsapp.net`);
            out[digits] = phone;
          }
        } catch {
          /* not in the signal store - try the group's member list below */
        }
        if (out[digits] || !chatJid?.endsWith('@g.us')) continue;
        // The group's member list comes from WhatsApp itself, so this also
        // works for members who never messaged and after a restart.
        try {
          members ??= (await getNormalizedGroupMetadata(chatJid))?.participants ?? [];
        } catch (err) {
          log.debug('Group members unavailable for tag lookup', { jid: idTag(chatJid), err });
          members = [];
        }
        // Only a hidden-ID (@lid) match counts: a tag that is already a
        // member's phone number needs no change.
        const userOf = (j?: string) => j?.split('@')[0].split(':')[0];
        const member = members.find((p) => [p.id, p.lid].some((j) => j?.endsWith('@lid') && userOf(j) === digits));
        if (!member) continue;
        const phone =
          userOf(member.phoneNumber) ?? (member.id.endsWith('@s.whatsapp.net') ? userOf(member.id) : undefined);
        if (phone) {
          setLidPhoneMapping(digits, `${phone}@s.whatsapp.net`);
          out[digits] = phone;
        } else {
          unresolvedLids.add(digits);
        }
      }
      return out;
    }

    async function translateJid(jid: string, altJid?: string): Promise<string> {
      if (!jid.endsWith('@lid')) return jid;
      const lidUser = jid.split('@')[0].split(':')[0];

      // 1. Check local cache
      const cached = lidToPhoneMap[lidUser];
      if (cached) return cached;

      // 2. Use the alt JID from extractAddressingContext (v7 provides this
      //    on every inbound message as remoteJidAlt / participantAlt)
      if (altJid && !altJid.endsWith('@lid')) {
        const phoneJid = altJid.includes('@') ? altJid : `${altJid}@s.whatsapp.net`;
        setLidPhoneMapping(lidUser, phoneJid);
        log.info('Translated LID via alt JID', { lidJid: idTag(jid), phoneJid: idTag(phoneJid) });
        return phoneJid;
      }

      // 3. Query Baileys v7 LID mapping store
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
        if (pn) {
          const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
          setLidPhoneMapping(lidUser, phoneJid);
          log.info('Translated LID via signal repository', { lidJid: idTag(jid), phoneJid: idTag(phoneJid) });
          return phoneJid;
        }
      } catch (err) {
        log.debug('Failed to resolve LID via signalRepository', { jid, err });
      }

      return jid;
    }

    async function getNormalizedGroupMetadata(jid: string): Promise<GroupMetadata | undefined> {
      if (!jid.endsWith('@g.us')) return undefined;

      const cached = groupMetadataCache.get(jid);
      if (cached && cached.expiresAt > Date.now()) return cached.metadata;

      // IMPORTANT: return participants with their NATIVE ids (LIDs as WhatsApp
      // provides them) — do NOT translate LID→phone here. This metadata is fed
      // to Baileys via `cachedGroupMetadata`, which uses the participant list to
      // distribute the group sender key. In WhatsApp's LID addressing, the
      // crypto/session layer is keyed by LID; handing it phone JIDs sends the
      // sender key to identities with no matching session, so newly-added
      // participants never receive it and see "Waiting for this message".
      // Sender-name resolution for inbound messages translates LIDs separately.
      const metadata = await sock.groupMetadata(jid);
      groupMetadataCache.set(jid, {
        metadata,
        expiresAt: Date.now() + GROUP_METADATA_CACHE_TTL_MS,
      });
      return metadata;
    }

    // One-shot proactive Signal re-key, gated by WHATSAPP_FORCE_REKEY.
    //
    // After wiping `session-*`/`sender-key-*` to repair an E2EE desync, Baileys
    // rebuilds each session lazily — on the first send to that peer. That leaves
    // the first message to every contact as the one that re-establishes, which
    // is precisely the message a user notices failing. `assertSessions(jids,
    // true)` fetches fresh prekey bundles and rebuilds the sessions up front,
    // WITHOUT transmitting anything user-visible: no chat message, no
    // notification. Peers are collected from the socket's own participating-group
    // list, plus any extra JIDs (typically DM peers) in WHATSAPP_REKEY_JIDS.
    //
    // Chunked deliberately: each JID is a prekey-bundle fetch, and asserting
    // several hundred at once risks a 428/rate-limit that would drop the socket
    // and undo the repair.
    async function forceRekeySessions(): Promise<void> {
      const extra = (readEnvFile(['WHATSAPP_REKEY_JIDS']).WHATSAPP_REKEY_JIDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const jids = new Set<string>(extra);
      try {
        const groups = await sock.groupFetchAllParticipating();
        for (const metadata of Object.values(groups)) {
          for (const p of metadata.participants || []) {
            if (p.id) jids.add(p.id);
          }
        }
      } catch (err) {
        log.error('Re-key: failed to fetch participating groups', { err });
      }

      const targets = [...jids];
      if (!targets.length) {
        log.warn('Re-key requested but no target JIDs resolved');
        return;
      }

      log.info('Force re-key starting', { targets: targets.length });
      const CHUNK = 20;
      let ok = 0;
      let failed = 0;
      for (let i = 0; i < targets.length; i += CHUNK) {
        const batch = targets.slice(i, i + CHUNK);
        try {
          await sock.assertSessions(batch, true);
          ok += batch.length;
        } catch (err) {
          failed += batch.length;
          log.warn('Re-key batch failed', { from: i, size: batch.length, err });
        }
        // Breathe between batches so a burst of prekey fetches can't trip
        // rate limiting and kill the socket we just stabilized.
        await new Promise((r) => setTimeout(r, 750));
      }
      log.info('Force re-key complete', { ok, failed, total: targets.length });
    }

    // Own number: the group list kept for the dashboard. Fetched only at the
    // regular group sync; joins and renames in between come from WhatsApp's
    // own group notifications (no extra fetches).
    const groupListFile = path.join(process.cwd(), 'store', GROUP_LIST_FILE);
    let knownGroups: Record<string, GroupMetaLike> | null = null;

    async function syncGroupMetadata(force = false): Promise<void> {
      if (!force && lastGroupSync && Date.now() - lastGroupSync < GROUP_SYNC_INTERVAL_MS) {
        return;
      }
      try {
        log.info('Syncing group metadata from WhatsApp...');
        const groups = await sock.groupFetchAllParticipating();
        let count = 0;
        for (const [jid, metadata] of Object.entries(groups)) {
          if (metadata.subject) {
            setupConfig.onMetadata(jid, metadata.subject, true);
            count++;
          }
        }
        // A business's own number: the list it turns groups on and off from in its dashboard.
        if (isOwnNumber()) {
          knownGroups = { ...groups };
          writeGroupList(groupListFile, knownGroups);
        }
        lastGroupSync = Date.now();
        log.info('Group metadata synced', { count });
      } catch (err) {
        log.error('Failed to sync group metadata', { err });
      }
    }

    // Chats listed in WHATSAPP_HIDE_CHAT_JIDS (comma-separated JIDs, or `all`
    // for every chat the bot replies in) are cleared from this account's devices — including the primary phone —
    // right after each bot reply, via an app-state clearChat sync. Only the
    // WhatsApp copy goes; session DBs and agent memory are untouched, and
    // other participants' phones are unaffected. `clear` (not `delete`)
    // because a group chat can't be deleted while still a member. Read per
    // call so .env edits apply without a restart.
    function hideChatEnabled(jid: string): boolean {
      const env = readEnvFile(['WHATSAPP_HIDE_CHAT_JIDS', 'NANOCLAW_SHARED_NUMBER']);
      return hideChatListMatches(hideChatSetting(env.WHATSAPP_HIDE_CHAT_JIDS, env.NANOCLAW_SHARED_NUMBER), jid);
    }

    // Chats with incoming messages not yet cleared (no reply since): a group
    // where nobody tags the bot, or a number it never answers. Swept once the
    // chat has been quiet for IDLE_CLEAR_MS, so the bot phone keeps no history
    // there either. Keyed by the jid WhatsApp stores the chat under.
    const IDLE_CLEAR_MS = 5 * 60_000;
    const unclearedChats = new Map<
      string,
      { matchJid: string; key: WAMessageKey; messageTimestamp: number | Long; at: number }
    >();
    function noteIncomingForClear(storeJid: string, matchJid: string, msg: WAMessage): void {
      if (!msg.key?.id || !msg.messageTimestamp) return;
      unclearedChats.set(storeJid, { matchJid, key: msg.key, messageTimestamp: msg.messageTimestamp, at: Date.now() });
    }
    async function sweepIdleChats(): Promise<void> {
      const now = Date.now();
      for (const [jid, c] of unclearedChats) {
        if (now - c.at < IDLE_CLEAR_MS) continue;
        unclearedChats.delete(jid);
        if (!hideChatEnabled(c.matchJid)) continue;
        try {
          await sock.chatModify(
            { clear: true, lastMessages: [{ key: c.key, messageTimestamp: c.messageTimestamp }] },
            jid,
          );
          log.info('Cleared idle WhatsApp chat', { jid: idTag(c.matchJid) });
        } catch (err) {
          log.warn('Failed to clear idle WhatsApp chat', { jid: idTag(c.matchJid), err });
        }
      }
    }
    const idleClearTimer = setInterval(() => void sweepIdleChats(), 60_000);
    idleClearTimer.unref?.();

    async function clearChatAfterReply(jid: string, sent: WAMessage | undefined): Promise<void> {
      if (!sent?.key?.id || !sent.messageTimestamp || !hideChatEnabled(jid)) return;
      // The reply clears everything up to it, including earlier incoming messages.
      for (const [k, c] of unclearedChats) if (c.matchJid === jid || k === jid) unclearedChats.delete(k);
      try {
        await sock.chatModify(
          { clear: true, lastMessages: [{ key: sent.key, messageTimestamp: sent.messageTimestamp }] },
          jid,
        );
        log.info('Cleared WhatsApp chat after reply', { jid: idTag(jid) });
      } catch (err) {
        log.warn('Failed to clear WhatsApp chat after reply', { jid: idTag(jid), err });
      }
    }

    async function flushOutgoingQueue(): Promise<void> {
      if (flushing || outgoingQueue.length === 0) return;
      flushing = true;
      try {
        log.info('Flushing outgoing message queue', { count: outgoingQueue.length });
        while (outgoingQueue.length > 0) {
          const item = outgoingQueue.shift()!;
          const payload: { text: string; mentions?: string[] } = { text: item.text };
          if (item.mentions && item.mentions.length > 0) payload.mentions = item.mentions;
          const sent = await safeSend(item.jid, payload);
          if (sent?.key?.id && sent.message) {
            cacheSentMessage(sent.key.id, sent.message);
          }
          await clearChatAfterReply(item.jid, sent);
        }
      } finally {
        flushing = false;
      }
    }

    /**
     * Download media from an inbound message and return it as base64. The host's
     * writeSessionMessage → extractAttachmentFiles then relocates each file into
     * the per-session `inbox/` directory, which is mounted into the container at
     * `/workspace/inbox/<messageId>/<name>`. Returning base64 (rather than
     * writing to a shared host dir) keeps attachments isolated per session and
     * works for multi-agent fan-out, where each target gets its own inbox copy.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function downloadInboundMedia(
      msg: WAMessage,
      normalized: any,
    ): Promise<Array<{ type: string; name: string; mimeType?: string; data: string; size: number }>> {
      const mediaTypes: Array<{ key: string; type: string; ext: string }> = [
        { key: 'imageMessage', type: 'image', ext: '.jpg' },
        { key: 'videoMessage', type: 'video', ext: '.mp4' },
        { key: 'audioMessage', type: 'audio', ext: '.ogg' },
        { key: 'documentMessage', type: 'document', ext: '' },
      ];
      const results: Array<{ type: string; name: string; mimeType?: string; data: string; size: number }> = [];
      for (const { key, type, ext } of mediaTypes) {
        if (!normalized[key]) continue;
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          // documentMessage.fileName is attacker-controlled and rides through
          // WhatsApp's E2E channel — Meta can't sanitize it server-side.
          // extractAttachmentFiles re-validates via isSafeAttachmentName; we
          // sanitize here too so the fallback keeps a useful extension.
          const rawFilename = normalized[key].fileName;
          const fallback = `${type}-${Date.now()}${ext}`;
          const filename = isSafeAttachmentName(rawFilename) ? rawFilename : fallback;
          if (rawFilename && filename !== rawFilename) {
            log.warn('Refused unsafe attachment filename — would escape inbox', { replacement: filename });
          }
          results.push({
            type,
            name: filename,
            mimeType: normalized[key].mimetype,
            data: buffer.toString('base64'),
            size: buffer.length,
          });
          log.info('Media downloaded', { type, size: buffer.length });
        } catch (err) {
          log.warn('Failed to download media', { type, err });
        }
      }
      return results;
    }

    async function sendRawMessage(jid: string, text: string, mentions?: string[]): Promise<string | undefined> {
      if (!connected) {
        outgoingQueue.push({ jid, text, mentions });
        log.info('WA disconnected, message queued', { jid: idTag(jid), queueSize: outgoingQueue.length });
        return;
      }
      try {
        const payload: { text: string; mentions?: string[] } = { text };
        if (mentions && mentions.length > 0) payload.mentions = mentions;
        const sent = await safeSend(jid, payload);
        if (sent?.key?.id && sent.message) {
          cacheSentMessage(sent.key.id, sent.message);
        }
        await clearChatAfterReply(jid, sent);
        return sent?.key?.id ?? undefined;
      } catch (err) {
        outgoingQueue.push({ jid, text, mentions });
        log.warn('Failed to send, message queued', { jid: idTag(jid), err, queueSize: outgoingQueue.length });
        return undefined;
      }
    }

    // --- Socket creation ---

    // Drop a superseded socket: detach its listeners so it can't drive
    // reconnects, then close the underlying transport. `end()` synchronously
    // emits a final connection.update — the generation guard in the handler
    // discards it.
    function teardownSocket(target: WASocket | undefined): void {
      if (!target) return;
      try {
        target.ev.removeAllListeners('connection.update');
        target.ev.removeAllListeners('creds.update');
        target.ev.removeAllListeners('messages.upsert');
      } catch (err) {
        log.warn('Failed to detach socket listeners', { err });
      }
      try {
        target.end(undefined);
      } catch (err) {
        log.warn('Failed to end superseded socket', { err });
      }
    }

    // Single-flight, exponentially backed-off reconnect. Every close path goes
    // through here — never call connectSocket() directly from a listener.
    function scheduleReconnect(): void {
      if (shuttingDown || reconnecting) return;
      reconnecting = true;

      const delay = Math.min(RECONNECT_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS);
      reconnectAttempt += 1;
      log.info('Scheduling WhatsApp reconnect', { delayMs: delay, attempt: reconnectAttempt });

      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (shuttingDown) {
          reconnecting = false;
          return;
        }
        connectSocket()
          .catch((err) => {
            log.error('Reconnect failed', { err, attempt: reconnectAttempt });
          })
          .finally(() => {
            reconnecting = false;
            // Not reset on success here — only a confirmed `connection === 'open'`
            // clears the attempt counter, so a socket that opens and instantly
            // dies keeps backing off instead of restarting the ladder at 5s.
          });
      }, delay);
    }

    async function connectSocket(): Promise<void> {
      // Retire the previous socket before creating its replacement.
      const previous = sock;
      socketGeneration += 1;
      const generation = socketGeneration;
      teardownSocket(previous);

      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      const version = await resolveWaWebVersion();

      sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: Browsers.macOS('Chrome'),
        // Own number: the number is also the owner's own WhatsApp. A linked
        // device that shows as online makes WhatsApp treat the owner as
        // reading there: the phone stops notifying and personal chats look
        // read. Stay offline; replies and "typing..." still work.
        markOnlineOnConnect: !isOwnNumber(),
        cachedGroupMetadata: async (jid: string) => getNormalizedGroupMetadata(jid),
        getMessage: async (key: WAMessageKey) => {
          // Check in-memory cache first (recently sent messages)
          const cached = sentMessageCache.get(key.id || '');
          if (cached) return cached;
          // Fall back to the disk store so retries survive restarts.
          const persisted = key.id ? loadSentMessage(key.id) : undefined;
          if (persisted) return persisted;
          // Last resort: empty message to avoid an indefinite retry loop.
          return proto.Message.create({});
        },
      });

      // Request pairing code only when there's no paired account yet.
      //
      // We can't use `state.creds.registered` here: Baileys 7.x doesn't
      // reliably flip that flag back to `true` after the post-pair stream
      // restart (statusCode 515). An already-paired socket would then see
      // `registered=false` and request a *new* pairing code 3s after the
      // restart, which the WhatsApp server rejects with 401 and the adapter
      // wipes the auth directory — re-pair from scratch every restart.
      //
      // `state.creds.me` is set as part of the QR / pairing-code handshake
      // and is the authoritative "this socket has an account" signal.
      if (!state.creds.me) freshLink = true;
      // Set the catch-up window now: WhatsApp can send the history sync before
      // the connection reports "open". Live messages in the window are deduped.
      if (freshLink && !catchup) {
        const lastOnline = readLastOnline();
        const gap = lastOnline ? Date.now() - lastOnline : 0;
        if (lastOnline && gap > MISSED_MIN_GAP_MS && gap < MISSED_MAX_GAP_MS) {
          catchup = { since: lastOnline, until: Date.now() + 10 * 60_000, openUntil: Date.now() + 20 * 60_000 };
          log.info('Fresh link after a gap - will answer messages missed meanwhile', {
            offlineMinutes: Math.round(gap / 60_000),
          });
        }
      }
      if (phoneNumber && !state.creds.me && !qrPairing) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            log.info(`WhatsApp pairing code: ${code}`);
            log.info('Enter in WhatsApp > Linked Devices > Link with phone number');
            fs.writeFileSync(pairingCodeFile, code, 'utf-8');
          } catch (err) {
            log.error('Failed to request pairing code', { err });
          }
        }, 3000);
      }

      sock.ev.on('connection.update', (update) => {
        // Ignore events from a socket that has already been superseded.
        if (generation !== socketGeneration) return;

        const { connection, lastDisconnect, qr } = update;

        if (qr && qrPairing) {
          try {
            fs.writeFileSync(pairingQrFile, qr, 'utf-8');
            log.info('WhatsApp pairing QR ready - scan it from the Miroflow admin');
          } catch (err) {
            log.error('Failed to save pairing QR', { err });
          }
        } else if (qr && !phoneNumber) {
          // QR code auth — print to terminal
          (async () => {
            try {
              const QRCode = await import('qrcode');
              const qrText = await QRCode.toString(qr, { type: 'terminal' });
              log.info('WhatsApp QR code — scan with WhatsApp > Linked Devices:\n' + qrText);
            } catch {
              log.info('WhatsApp QR code (raw)', { qr });
            }
          })();
        }

        if (connection === 'close') {
          connected = false;
          const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          // Don't auto-reconnect during shutdown — a parallel connectSocket()
          // initializes useMultiFileAuthState which can truncate creds.json
          // mid-write when the process exits, leaving a 0-byte creds file
          // and forcing a fresh QR pairing on next start.
          const shouldReconnect = !shuttingDown && reason !== DisconnectReason.loggedOut;

          log.info('WhatsApp connection closed', { reason, shouldReconnect, shuttingDown });

          // Shared number only: frequent drops pause scheduled reminders. A
          // business's own number never pauses them. A QR or pairing code that
          // expires while linking (no account yet) is never a drop.
          if (shouldReconnect && sharedNumber && state.creds.me && noteConnectionDrop()) {
            log.warn('WhatsApp unstable: pausing automated reminders for 1 hour');
          }
          if (shouldReconnect) {
            scheduleReconnect();
          } else if (reason === DisconnectReason.loggedOut) {
            // Server-side logout (account unlinked, 401, etc.). Clear auth so
            // the next start prompts for a fresh pair — stale creds would
            // 401 again and risk WhatsApp's "can't link new devices now"
            // cooldown.
            log.info('WhatsApp logged out');
            try {
              fs.rmSync(authDir, { recursive: true, force: true });
              fs.mkdirSync(authDir, { recursive: true });
              log.info('WhatsApp auth cleared — set WHATSAPP_ENABLED=true and restart to re-link');
            } catch (err) {
              log.error('Failed to clear WhatsApp auth after logout', { err });
            }
            if (rejectFirstOpen) {
              rejectFirstOpen(new Error('WhatsApp logged out'));
              rejectFirstOpen = undefined;
              resolveFirstOpen = undefined;
            }
          } else {
            // Clean shutdown (shuttingDown=true) or a non-loggedOut disconnect
            // that won't auto-reconnect. KEEP AUTH — the next process boot
            // must be able to restore the session. Wiping here turned every
            // `systemctl restart` into a forced re-pair, which is catastrophic
            // when the bot phone is not in reach.
            log.info('WhatsApp adapter stopped (auth preserved)');
            if (rejectFirstOpen) {
              rejectFirstOpen(new Error('WhatsApp adapter shutdown'));
              rejectFirstOpen = undefined;
              resolveFirstOpen = undefined;
            }
          }
        } else if (connection === 'open') {
          connected = true;
          // Only a real open clears the ladder — see scheduleReconnect().
          reconnectAttempt = 0;
          log.info('Connected to WhatsApp');

          noteOnline(true);
          if (safetyLimits) {
            // The number's age sets its daily limits (src/wa-limits.ts).
            const own = sock.user?.id?.split(':')[0]?.split('@')[0];
            if (own) markLinked(own);
          }
          if (sharedNumber) {
            if (!joinTimer) {
              joinTimer = setInterval(
                () => void flushQueuedJoins().catch((err) => log.warn('Queued joins failed', { err })),
                60_000,
              );
              joinTimer.unref?.();
            }
          }

          // Clean up pairing code file after successful connection
          try {
            for (const f of [pairingCodeFile, pairingQrFile, pairMethodFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
          } catch {
            /* ignore */
          }

          // Announce availability for presence updates (not on a business's
          // own number: see markOnlineOnConnect above).
          shownOnline = false;
          sock.sendPresenceUpdate(isOwnNumber() ? 'unavailable' : 'available').catch((err) => {
            log.warn('Failed to send presence update', { err });
          });

          // Build LID → phone mapping from auth state
          if (sock.user) {
            const phoneUser = sock.user.id.split(':')[0];
            const lidUser = sock.user.lid?.split(':')[0];
            botPhoneJid = `${phoneUser}@s.whatsapp.net`;
            if (lidUser && phoneUser) {
              setLidPhoneMapping(lidUser, botPhoneJid);
              botLidUser = lidUser;
            }
            if (isOwnNumber()) {
              try {
                ensureOwnerSelfChat(botPhoneJid);
              } catch (err) {
                log.warn('Owner self-chat wiring failed', { err });
              }
            }
          }

          // Flush queued messages
          flushOutgoingQueue().catch((err) => log.error('Failed to flush outgoing queue', { err }));

          // Opt-in one-shot re-key after an E2EE repair. Unset the env var and
          // restart once it has reported "Force re-key complete".
          if (readEnvFile(['WHATSAPP_FORCE_REKEY']).WHATSAPP_FORCE_REKEY === 'true') {
            forceRekeySessions().catch((err) => log.error('Force re-key failed', { err }));
          }

          // Group sync
          syncGroupMetadata().catch((err) => log.error('Initial group sync failed', { err }));
          if (!groupSyncTimerStarted) {
            groupSyncTimerStarted = true;
            setInterval(() => {
              syncGroupMetadata().catch((err) => log.error('Periodic group sync failed', { err }));
            }, GROUP_SYNC_INTERVAL_MS);
          }

          // Signal first open
          if (resolveFirstOpen) {
            resolveFirstOpen();
            resolveFirstOpen = undefined;
            rejectFirstOpen = undefined;
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // LID ↔ phone mapping updates (v7 replaces chats.phoneNumberShare)
      sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
        const lidUser = lid?.split('@')[0].split(':')[0];
        if (lidUser && pn) {
          const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
          setLidPhoneMapping(lidUser, phoneJid);
        }
      });

      // Inbound messages (live, or missed while offline - see catch-up above)
      const processIncoming = async (messages: WAMessage[], missedWhileOffline = false): Promise<void> => {
        if (!missedWhileOffline) noteOnline();
        for (const msg of messages) {
          if (!missedWhileOffline && catchup && msg.key?.id) seenMissed.add(msg.key.id);
          try {
            if (!msg.message) continue;
            const normalized = normalizeMessageContent(msg.message);
            if (!normalized) continue;
            const rawJid = msg.key.remoteJid;
            if (!rawJid || rawJid === 'status@broadcast') continue;

            // Translate LID → phone JID using v7's alt JID from extractAddressingContext
            const chatJid = await translateJid(rawJid, msg.key.remoteJidAlt);
            // Personal chats can be paused (a number that is also someone's own WhatsApp):
            // those messages are left alone entirely - not read, not answered.
            // The owner's own "Message yourself" chat always reaches the assistant on its own number.
            const selfChat = isOwnNumber() && chatJid === botPhoneJid;
            if (!chatJid.endsWith('@g.us') && !selfChat && !personalChatAllowed(chatJid)) continue;
            if (!msg.key.fromMe) noteIncomingForClear(rawJid, chatJid, msg);
            if (!msg.key.fromMe && !chatJid.endsWith('@g.us')) notePersonalChat(rawJid, chatJid);

            const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
            const isGroup = chatJid.endsWith('@g.us');

            // Notify metadata for group discovery
            setupConfig.onMetadata(chatJid, undefined, isGroup);

            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // Normalize bot LID mention → assistant name for trigger matching
            if (botLidUser && content.includes(`@${botLidUser}`)) {
              content = content.replace(`@${botLidUser}`, `@${ASSISTANT_NAME}`);
            }

            // Other members' LID tags → their phone numbers, so the agent sees
            // (and later tags) a number WhatsApp can show as the member's name.
            const lidMentions = [
              ...(normalized.extendedTextMessage?.contextInfo?.mentionedJid ?? []),
              ...(normalized.imageMessage?.contextInfo?.mentionedJid ?? []),
              ...(normalized.videoMessage?.contextInfo?.mentionedJid ?? []),
              ...(normalized.documentMessage?.contextInfo?.mentionedJid ?? []),
            ].filter((j): j is string => typeof j === 'string' && j.endsWith('@lid'));
            if (lidMentions.length > 0 && content.includes('@')) {
              const map: Record<string, string> = {};
              for (const lidJid of lidMentions) {
                const phoneJid = await translateJid(lidJid);
                const lidUser = lidJid.split('@')[0].split(':')[0];
                if (!phoneJid.endsWith('@lid')) map[lidUser] = phoneJid.split('@')[0];
              }
              // Members WhatsApp won't map yet: look them up in the group's
              // member list, so the agent sees (and tags) a phone number.
              Object.assign(map, await lidPhoneDigits(content, chatJid), map);
              for (const lidJid of lidMentions) {
                const lidUser = lidJid.split('@')[0].split(':')[0];
                if (!map[lidUser]) unresolvedLids.add(lidUser);
              }
              content = rewriteLidMentions(content, map);
            }

            // Download media attachments (images, video, audio, documents).
            // Own number: only in chats Miro is on - a group it is not on keeps
            // its photos, voice notes and files to itself.
            const mayDownload = !isOwnNumber() || isChatWired(chatJid);
            const attachments = mayDownload ? await downloadInboundMedia(msg, normalized) : [];

            // Quote-replies: show the assistant what is being replied to, and
            // bring a quoted photo/document/voice note along ("summarise this").
            const quoted = extractQuotedReply(normalized, displayName(), botPhoneJid, botLidUser);
            if (mayDownload && quoted?.mediaMessage && attachments.length === 0) {
              const quotedMsg = {
                key: { remoteJid: rawJid, id: quoted.id, participant: quoted.participant, fromMe: false },
                message: quoted.mediaMessage,
              } as unknown as WAMessage;
              attachments.push(
                ...(await downloadInboundMedia(quotedMsg, normalizeMessageContent(quoted.mediaMessage))),
              );
            }

            // Skip empty protocol messages (no text and no attachments)
            if (!content && attachments.length === 0) continue;

            // Resolve sender: in groups, participant may be LID — use participantAlt
            const rawSender = msg.key.participant || msg.key.remoteJid || '';
            const sender = rawSender.endsWith('@lid')
              ? await translateJid(rawSender, msg.key.participantAlt)
              : rawSender;
            const senderName = msg.pushName || sender.split('@')[0];
            const fromMe = msg.key.fromMe || false;
            // Filter bot's own messages to prevent echo loops.
            // This WhatsApp runs on the user's own number, so every message the
            // user types is fromMe=true — including in groups. We must forward
            // those so the user can trigger the agent from the self-chat OR from
            // a group that's wired to an agent. The only fromMe messages we drop
            // are the bot's own sends echoing back: matched by cached send id,
            // or by the "Name: " prefix the adapter prepends to its replies.
            // Unwired/third-party chats are dropped downstream by the router
            // (no agent wired + non-mention → silent drop), so the agent is
            // never woken in conversations the user hasn't explicitly wired.
            if (fromMe) {
              // Shared bot number: a message typed on the bot phone itself is the
              // operator, never a request; answering it would write into a
              // customer's chat unprompted.
              if (sharedNumber) continue;
              if (sentMessageCache.has(msg.key.id || '')) continue;
              if (!ASSISTANT_HAS_OWN_NUMBER && isOwnReplyText(content)) continue;
            }

            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER ? false : isOwnReplyText(content);

            // Check if this reply answers a pending question via slash command
            const pending = pendingQuestions.get(chatJid);
            if (pending && content.startsWith('/')) {
              const cmd = content.trim().toLowerCase();
              const matched = pending.options.find((o) => optionToCommand(o.label) === cmd);
              if (matched) {
                const voterName = msg.pushName || sender.split('@')[0];
                setupConfig.onAction(pending.questionId, matched.value, sender);
                pendingQuestions.delete(chatJid);
                await sendRawMessage(chatJid, `${matched.selectedLabel} by ${voterName}`);
                log.info('Question answered', { questionId: pending.questionId, value: matched.value });
                continue; // Don't forward this reply to the agent
              }
            }

            // Detect explicit @-mentions of the bot in groups. Detail in
            // isBotMentionedInGroup(); short version is contextInfo.mentionedJid
            // on text + caption-bearing messages, matched against the bot's
            // phone JID and LID (#2560).
            // Replying to one of the assistant's own messages addresses it too.
            const botMentionedInGroup =
              isGroup && (isBotMentionedInGroup(normalized, botPhoneJid, botLidUser) || quoted?.fromBot === true);

            if (missedWhileOffline) content = missedPrefix(Number(msg.messageTimestamp), TIMEZONE) + content;

            // Groups: a voice note / photo / file just before or after mentioning
            // the assistant goes with the mention (src/media-around-mention.ts).
            let addressedInGroup = botMentionedInGroup;
            if (isGroup && !missedWhileOffline && !quoted?.mediaMessage) {
              const named = botMentionedInGroup || addressesAssistant(content);
              const r = mediaAround.apply(`${chatJid}|${sender}`, Date.now(), { addressed: named, attachments });
              if (r.attachments !== attachments) attachments.splice(0, attachments.length, ...r.attachments);
              if (r.addressed && !named) addressedInGroup = true;
            }

            // A join code in a group: tell the join-code check how big the
            // group is, so large and community groups can be refused.
            let groupInfo: { name?: string; size: number; community: boolean } | undefined;
            if (
              isGroup &&
              (/^\s*join\s+[a-z0-9]{6}\s*$/i.test(content) || (msg.key.fromMe && matchOwnerCommand(content)))
            ) {
              try {
                const meta = await getNormalizedGroupMetadata(rawJid);
                if (meta) {
                  groupInfo = {
                    ...(meta.subject ? { name: String(meta.subject).slice(0, 120) } : {}),
                    size: meta.size ?? meta.participants?.length ?? 0,
                    community: Boolean(meta.isCommunity || meta.isCommunityAnnounce || meta.linkedParent),
                  };
                }
              } catch (err) {
                log.debug('Group size unavailable for join check', { jid: idTag(rawJid), err });
              }
            }

            const inbound: InboundMessage = {
              id: msg.key.id || `wa-${Date.now()}`,
              kind: 'chat',
              // DMs are addressed to the bot by definition. Mark them as
              // platform-confirmed mentions so the router auto-creates an
              // approval-required messaging_group when the chat is unknown,
              // instead of silently dropping. In groups, only an explicit
              // @-mention counts.
              isMention: computeIsMention(isGroup, addressedInGroup),
              isGroup,
              content: {
                text: content,
                sender,
                senderName,
                ...(msg.key.participant && { participant: msg.key.participant }),
                ...(attachments.length > 0 && { attachments }),
                ...(quoted && { replyTo: { id: quoted.id, sender: quoted.sender, text: quoted.text } }),
                fromMe,
                isBotMessage,
                isGroup,
                chatJid,
                ...(groupInfo && { groupInfo }),
              },
              timestamp,
            };

            // WhatsApp doesn't use threads — threadId is null
            setupConfig.onInbound(chatJid, null, inbound);
          } catch (err) {
            log.error('Error processing incoming WhatsApp message', {
              err,
              remoteJid: idTag(msg.key?.remoteJid),
            });
          }
        }
      };
      sock.ev.on('messages.upsert', async ({ messages }) => processIncoming(messages));
      if (isOwnNumber()) {
        const merge = (updates: Array<{ id?: string | null } & GroupMetaLike>) => {
          if (!knownGroups) return;
          for (const u of updates) if (u.id) knownGroups[u.id] = { ...knownGroups[u.id], ...u };
          writeGroupList(groupListFile, knownGroups);
        };
        sock.ev.on('groups.upsert', (groups) => merge(groups));
        sock.ev.on('groups.update', (updates) => merge(updates));
      }

      // History sync after a fresh link: answer what was missed while offline.
      sock.ev.on('messaging-history.set', async ({ messages }) => {
        if (!catchup || Date.now() > catchup.openUntil) return;
        const missed = pickMissedMessages(messages, catchup.since, catchup.until, seenMissed);
        if (missed.length === 0) return;
        log.info('Handling messages missed while offline', { count: missed.length });
        await processIncoming(missed, true);
      });
    }

    // --- ChannelAdapter implementation ---

    const adapter: ChannelAdapter = {
      name: 'whatsapp',
      channelType: 'whatsapp',
      supportsThreads: false,

      async setup(hostConfig: ChannelSetup) {
        setupConfig = hostConfig;

        // Connect and wait for first open
        await new Promise<void>((resolve, reject) => {
          resolveFirstOpen = resolve;
          rejectFirstOpen = reject;
          connectSocket().catch(reject);
        });

        log.info('WhatsApp adapter initialized');
      },

      async deliver(
        platformId: string,
        _threadId: string | null,
        message: OutboundMessage,
      ): Promise<string | undefined> {
        const content = message.content as Record<string, unknown>;

        // Ask question → text with slash command replies
        if (content.type === 'ask_question' && content.questionId && content.options) {
          const questionId = content.questionId as string;
          const title = content.title as string;
          const question = content.question as string;
          if (!title) {
            log.error('ask_question missing required title — skipping delivery', { questionId });
            return;
          }
          const options: NormalizedOption[] = normalizeOptions(content.options as never);

          const optionLines = options.map((o) => `  ${optionToCommand(o.label)}`).join('\n');
          const text = `*${title}*\n\n${question}\n\nReply with:\n${optionLines}`;
          const msgId = await sendRawMessage(platformId, text);
          if (msgId) {
            pendingQuestions.set(platformId, { questionId, options });
            if (pendingQuestions.size > PENDING_QUESTIONS_MAX) {
              const oldest = pendingQuestions.keys().next().value!;
              pendingQuestions.delete(oldest);
            }
          }
          return msgId;
        }

        // Reaction → emoji on a message
        if (content.operation === 'reaction' && content.messageId && content.emoji) {
          try {
            await safeSend(platformId, {
              react: {
                text: content.emoji as string,
                key: {
                  remoteJid: platformId,
                  id: content.messageId as string,
                  fromMe: false,
                  // In a group the reacted-to message is identified by its author too.
                  ...(typeof content.participant === 'string' && platformId.endsWith('@g.us')
                    ? { participant: content.participant }
                    : {}),
                },
              },
            });
          } catch (err) {
            log.debug('Failed to send reaction', { platformId, err });
          }
          return;
        }

        // Normal message (with optional file attachments)
        const text = (content.markdown as string) || (content.text as string);
        const hasFiles = message.files && message.files.length > 0;

        if (!text && !hasFiles) return;

        // Send file attachments (first file gets the caption, rest are captionless)
        if (hasFiles) {
          let captionUsed = false;
          let captionMsgId: string | undefined;
          for (const file of message.files!) {
            try {
              const ext = path.extname(file.filename).toLowerCase();
              let caption: string | undefined;
              let captionMentions: string[] | undefined;
              if (!captionUsed && text) {
                const formatted = formatWhatsApp(rewriteLidMentions(text, await lidPhoneDigits(text, platformId)));
                caption = formatted.text;
                captionMentions =
                  formatted.mentions.length > 0 ? lidMentionJids(formatted.mentions, unresolvedLids) : undefined;
              }
              const mediaMsg = buildMediaMessage(file.data, file.filename, ext, caption);
              if (captionMentions) mediaMsg.mentions = captionMentions;
              const sent = await safeSend(platformId, mediaMsg);
              if (sent?.key?.id && sent.message) {
                cacheSentMessage(sent.key.id, sent.message);
              }
              await clearChatAfterReply(platformId, sent);
              if (caption) {
                captionUsed = true;
                captionMsgId = sent?.key?.id ?? undefined;
              }
            } catch (err) {
              log.error('Failed to send file', { platformId: idTag(platformId), err });
              // Host notices (ncl notify send) must fail loudly rather than
              // degrade to a text-only message without the attachment.
              if (content.failOnFileError === true) throw err;
            }
          }
          if (captionUsed) return captionMsgId; // Text was sent as caption
        }

        if (text) {
          const { text: formatted, mentions } = formatWhatsApp(
            rewriteLidMentions(text, await lidPhoneDigits(text, platformId)),
          );
          // The assistant's name in bold, so its replies stand out from the owner's own messages.
          const prefixed = ASSISTANT_HAS_OWN_NUMBER ? formatted : `*${displayName()}:* ${formatted}`;
          return sendRawMessage(platformId, prefixed, lidMentionJids(mentions, unresolvedLids));
        }
      },

      async setTyping(platformId: string) {
        try {
          onlineWhileReplying();
          await sock.sendPresenceUpdate('composing', platformId);
        } catch (err) {
          log.debug('Failed to update typing status', { jid: platformId, err });
        }
      },

      async teardown() {
        shuttingDown = true;
        connected = false;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        reconnecting = false;
        sock?.end(undefined);
        log.info('WhatsApp adapter shut down');
      },

      isConnected() {
        return connected;
      },

      async syncConversations(): Promise<ConversationInfo[]> {
        try {
          const groups = await sock.groupFetchAllParticipating();
          return Object.entries(groups)
            .filter(([, m]) => m.subject)
            .map(([jid, m]) => ({
              platformId: jid,
              name: m.subject,
              isGroup: true,
            }));
        } catch (err) {
          log.error('Failed to sync WhatsApp conversations', { err });
          return [];
        }
      },
    };

    return adapter;
  },
});
