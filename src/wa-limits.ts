/**
 * Shared-number safety limits for the linked-device WhatsApp (Miroflow).
 *
 * WhatsApp flags numbers that send far more than a person would, or that are
 * added to many groups in a short time, especially new numbers. So, per number:
 *
 * - **Daily send ceiling**, rising while the number is new (counted from the
 *   first time it connected): 150 a day in week 1, 300 in week 2, 500 in week
 *   3, then 800 (WHATSAPP_DAILY_MAX lowers or raises the last). Past it,
 *   nothing more goes out that day, except one short notice per chat.
 * - **Group joins cooled**: at most 3 new groups a day for the first two
 *   weeks, then 5, at least 30 minutes apart, between 8 AM and 9 PM India
 *   time, and at most 2 a day for any one business. A join code beyond that
 *   is queued and the group is told when.
 *
 * Days are India-time calendar days. State lives in store/ (kept across
 * restarts and relinks of the same number; a different number starts again).
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';

const DAY_MS = 24 * 60 * 60_000;
const IST_OFFSET_MS = 330 * 60_000;
export const JOIN_GAP_MS = 30 * 60_000;
const JOIN_OPEN_HOUR = 8;
const JOIN_CLOSE_HOUR = 21;
/** Notices sent past the ceiling ("limit reached, back tomorrow"), at most this many a day. */
export const NOTICE_RESERVE = 40;

function storeDir(): string {
  return path.join(process.cwd(), 'store');
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/** India-time calendar day, YYYY-MM-DD. */
export function istDay(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Hour of the day in India time (0-23). */
function istHour(ms: number): number {
  return new Date(ms + IST_OFFSET_MS).getUTCHours();
}

/** The UTC instant of HH:00 India time on the India day containing `ms`. */
function istAt(ms: number, hour: number): number {
  const d = istDay(ms);
  return Date.parse(`${d}T00:00:00.000Z`) - IST_OFFSET_MS + hour * 60 * 60_000;
}

// ── Number age ──

export function firstLinkedFile(dir = storeDir()): string {
  return path.join(dir, 'wa-first-linked.json');
}

/** Note that this number is connected; the first time for a number starts its ramp-up. */
export function markLinked(number: string, now: number = Date.now(), dir = storeDir()): void {
  const cur = readJson<{ number?: string; since?: number }>(firstLinkedFile(dir), {});
  if (cur.number === number && typeof cur.since === 'number') return;
  writeJson(firstLinkedFile(dir), { number, since: now });
}

/** When this number first connected, or `now` if never recorded (treated as brand new). */
export function linkedSince(now: number = Date.now(), dir = storeDir()): number {
  const since = readJson<{ since?: unknown }>(firstLinkedFile(dir), {}).since;
  return typeof since === 'number' && since <= now ? since : now;
}

export function dailyCeiling(since: number, now: number, max = configuredMax()): number {
  const week = Math.floor((now - since) / (7 * DAY_MS));
  const ramp = week <= 0 ? 150 : week === 1 ? 300 : week === 2 ? 500 : 800;
  return Math.min(ramp, max);
}

function configuredMax(): number {
  const v = Number(process.env.WHATSAPP_DAILY_MAX || readEnvFile(['WHATSAPP_DAILY_MAX']).WHATSAPP_DAILY_MAX);
  return Number.isInteger(v) && v > 0 ? v : 800;
}

export function groupJoinsPerDay(since: number, now: number): number {
  return now - since < 14 * DAY_MS ? 3 : 5;
}

// ── Daily send budget ──

export type SendVerdict = 'send' | 'notice' | 'hold';

export class DailySendBudget {
  private state: { day: string; sent: number; notices: number; noticed: string[] };

  constructor(
    private readonly file = path.join(storeDir(), 'wa-sent-today.json'),
    private readonly now: () => number = Date.now,
    private readonly since: () => number = () => linkedSince(Date.now()),
  ) {
    this.state = readJson(this.file, { day: '', sent: 0, notices: 0, noticed: [] as string[] });
  }

  private roll(): void {
    const day = istDay(this.now());
    if (this.state.day !== day) this.state = { day, sent: 0, notices: 0, noticed: [] };
  }

  ceiling(): number {
    return dailyCeiling(this.since(), this.now());
  }

  sentToday(): number {
    this.roll();
    return this.state.sent;
  }

  /**
   * May one more message go to `jid` today? 'send' within the ceiling;
   * past it, 'notice' once per chat (so people know why Miro went quiet),
   * then 'hold'.
   */
  take(jid: string): SendVerdict {
    this.roll();
    let verdict: SendVerdict;
    if (this.state.sent < this.ceiling()) {
      this.state.sent++;
      verdict = 'send';
    } else if (!this.state.noticed.includes(jid) && this.state.notices < NOTICE_RESERVE) {
      this.state.notices++;
      this.state.noticed.push(jid);
      verdict = 'notice';
    } else {
      verdict = 'hold';
    }
    writeJson(this.file, this.state);
    return verdict;
  }
}

export const DAILY_LIMIT_NOTICE =
  "I've reached today's message limit for this WhatsApp number, which keeps it safe from spam blocks. I'll reply again from 8 AM tomorrow.";

// ── Group join cooling ──

export function joinLedgerFile(dir = storeDir()): string {
  return path.join(dir, 'wa-group-joins.json');
}

/** New groups one business may add a day, inside the number's own limit (so one can't use everyone's). */
export const GROUP_JOINS_PER_BUSINESS_DAY = 2;

/** A join slot given out: when, and for which business. */
export interface JoinSlot {
  t: number;
  tenant?: string;
}

/**
 * The earliest time a new group may be joined: the 30-minute gap, the
 * number's daily limit, the business's own 2 a day, and 8 AM - 9 PM India
 * time. `taken` is the slots already given out.
 */
export function nextJoinSlot(taken: JoinSlot[], now: number, since: number, tenant?: string): number {
  let t = now;
  for (let guard = 0; guard < 400; guard++) {
    const clash = taken.filter((x) => Math.abs(x.t - t) < JOIN_GAP_MS);
    if (clash.length) {
      t = Math.max(...clash.map((x) => x.t)) + JOIN_GAP_MS;
      continue;
    }
    if (istHour(t) < JOIN_OPEN_HOUR) {
      t = istAt(t, JOIN_OPEN_HOUR);
      continue;
    }
    if (istHour(t) >= JOIN_CLOSE_HOUR) {
      t = istAt(t + DAY_MS, JOIN_OPEN_HOUR);
      continue;
    }
    const day = taken.filter((x) => istDay(x.t) === istDay(t));
    const full = day.length >= groupJoinsPerDay(since, t);
    const ownFull = tenant !== undefined && day.filter((x) => x.tenant === tenant).length >= GROUP_JOINS_PER_BUSINESS_DAY;
    if (full || ownFull) {
      t = istAt(t + DAY_MS, JOIN_OPEN_HOUR);
      continue;
    }
    return t;
  }
  return t;
}

/** Businesses free of the per-business daily limit (comma-separated ids); the number-wide limits still apply. */
function joinLimitExempt(tenant: string): boolean {
  const list = process.env.JOIN_LIMIT_EXEMPT_TENANTS || readEnvFile(['JOIN_LIMIT_EXEMPT_TENANTS']).JOIN_LIMIT_EXEMPT_TENANTS || '';
  return list.split(',').map((x) => x.trim()).includes(tenant);
}

/** A queued join must still be within the node-agent's 48-hour grace for late join codes. */
export const MAX_JOIN_WAIT_MS = 40 * 60 * 60_000;

/**
 * Book the next join slot for a business's new group and return it (`now` or
 * later), or null when the wait would be too long (the group is asked to try
 * tomorrow).
 */
export function bookJoinSlot(now: number = Date.now(), dir = storeDir(), tenant?: string): number | null {
  const file = joinLedgerFile(dir);
  // Keep three days of history: enough for the gap and the daily counts.
  // (Older files held bare times.)
  const taken = readJson<unknown[]>(file, [])
    .map((x): JoinSlot | null => (typeof x === 'number' ? { t: x } : x && typeof (x as JoinSlot).t === 'number' ? (x as JoinSlot) : null))
    .filter((x): x is JoinSlot => x !== null && x.t > now - 3 * DAY_MS);
  const slot = nextJoinSlot(taken, now, linkedSince(now, dir), tenant && !joinLimitExempt(tenant) ? tenant : undefined);
  if (slot - now > MAX_JOIN_WAIT_MS) return null;
  writeJson(file, [...taken, { t: slot, ...(tenant ? { tenant } : {}) }]);
  return slot;
}

/** "4:30 PM today" / "10:00 AM tomorrow" / "8:00 AM on 19 Oct", India time. */
export function joinTimeText(slot: number, now: number): string {
  const time = new Date(slot).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
  const d = istDay(slot);
  if (d === istDay(now)) return `${time} today`;
  if (d === istDay(now + DAY_MS)) return `${time} tomorrow`;
  const date = new Date(slot).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
  return `${time} on ${date}`;
}
