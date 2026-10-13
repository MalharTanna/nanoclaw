/**
 * Court case lookups (eCourtsIndia partner API) and a per-business list of
 * client matters, for the assistant to answer "what is the status of
 * Sharma's matter?" without anyone typing a CNR.
 *
 *   ncl matters add --client "Sharma" --cnr GJAH010012342025 [--title ".."] [--note ".."]
 *   ncl matters find --q sharma         (client, title, note or CNR)
 *   ncl matters list | remove --cnr ..
 *   ncl court case --cnr GJAH010012342025 [--refresh]
 *   ncl court search --party "Ramesh Patel" [--advocate ..] [--court GJHC01]
 *   ncl court next --cnr A,B,C          (upcoming cause-list listings)
 *
 * The API key (ECOURTS_API_KEY in the install .env) stays on the host: the
 * container agent calls these through ncl and never sees it. Lookups are
 * capped per business per month (ECOURTS_MONTHLY_LIMIT, default 300).
 *
 * Matters are kept per agent group (one business) on the host, under
 * data/court/<agent group>/matters.json, never in the container mount.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

const DEFAULT_BASE = 'https://webapi.ecourtsindia.com';
const CNR_RE = /^[A-Z]{4}\d{12}$/;

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>;
/** Tests inject a fake. */
export function setCourtFetch(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function groupOf(args: Record<string, unknown>, ctx: CallerContext): string {
  const g = ctx.caller === 'agent' ? ctx.agentGroupId : str(args.group);
  if (!g || !/^[A-Za-z0-9_-]{1,80}$/.test(g)) throw new Error('--group is required');
  return g;
}

function cnrOf(v: unknown): string {
  const c = (str(v) ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!CNR_RE.test(c)) throw new Error('A CNR is 16 characters: 4 letters then 12 digits, e.g. GJAH010012342025');
  return c;
}

function dir(group: string): string {
  const d = path.join(DATA_DIR, 'court', group);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

// ─────────────────────────────── Matters ───────────────────────────────

export interface Matter {
  client: string;
  cnr: string;
  title?: string;
  note?: string;
  addedAt: string;
}

function readMatters(group: string): Matter[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir(group), 'matters.json'), 'utf8'));
    return Array.isArray(raw) ? (raw as Matter[]) : [];
  } catch {
    return [];
  }
}

function writeMatters(group: string, matters: Matter[]): void {
  const file = path.join(dir(group), 'matters.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(matters, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function findMatters(matters: Matter[], q: string): Matter[] {
  const needle = fold(q);
  if (!needle) return [];
  const words = needle.split(' ');
  return matters.filter((m) => {
    const hay = fold(`${m.client} ${m.title ?? ''} ${m.note ?? ''} ${m.cnr}`);
    return words.every((w) => hay.includes(w));
  });
}

const MAX_MATTERS = 2_000;

registerResource({
  name: 'matters',
  plural: 'matters',
  table: '',
  description: "This business's list of client matters (client name to CNR), so you can look a case up by client name.",
  idColumn: 'cnr',
  columns: [],
  operations: {},
  customOperations: {
    add: {
      access: 'open',
      description: 'Save a client matter (or update it if the CNR is already saved).',
      args: [
        { name: 'client', type: 'string', required: true, description: 'Client name as the team calls them, e.g. "Sharma" or "Patel Industries".' },
        { name: 'cnr', type: 'string', required: true, description: '16-character CNR, e.g. GJAH010012342025.' },
        { name: 'title', type: 'string', description: 'Short case title, e.g. "Sharma vs State of Gujarat".' },
        { name: 'note', type: 'string', description: 'Anything that helps find it later (court, stage, file no.).' },
      ],
      handler: async (args, ctx) => {
        const group = groupOf(args, ctx);
        const cnr = cnrOf(args.cnr);
        const client = str(args.client)!.slice(0, 120);
        const matters = readMatters(group).filter((m) => m.cnr !== cnr);
        if (matters.length >= MAX_MATTERS) throw new Error(`At most ${MAX_MATTERS} matters per business.`);
        const m: Matter = { client, cnr, title: str(args.title)?.slice(0, 200), note: str(args.note)?.slice(0, 300), addedAt: new Date().toISOString() };
        matters.push(m);
        writeMatters(group, matters);
        return { saved: m, total: matters.length };
      },
    },
    find: {
      access: 'open',
      description: 'Find saved matters by client name, title, note or CNR (all words must match).',
      args: [{ name: 'q', type: 'string', required: true, description: 'What to look for, e.g. "sharma".' }],
      handler: async (args, ctx) => findMatters(readMatters(groupOf(args, ctx)), str(args.q) ?? ''),
    },
    list: {
      access: 'open',
      description: 'List all saved matters of this business.',
      args: [],
      handler: async (args, ctx) => readMatters(groupOf(args, ctx)),
    },
    remove: {
      access: 'open',
      description: 'Remove a saved matter by CNR.',
      args: [{ name: 'cnr', type: 'string', required: true, description: 'CNR of the matter to remove.' }],
      handler: async (args, ctx) => {
        const group = groupOf(args, ctx);
        const cnr = cnrOf(args.cnr);
        const before = readMatters(group);
        const after = before.filter((m) => m.cnr !== cnr);
        writeMatters(group, after);
        return { removed: before.length - after.length };
      },
    },
  },
});

// ─────────────────────────────── Court API ───────────────────────────────

function config(): { key: string; base: string; limit: number } {
  const env = readEnvFile(['ECOURTS_API_KEY', 'ECOURTS_BASE_URL', 'ECOURTS_MONTHLY_LIMIT']);
  const key = process.env.ECOURTS_API_KEY || env.ECOURTS_API_KEY;
  if (!key) throw new Error('Court lookups are not set up on this install yet (no eCourts API key).');
  const limit = Number(process.env.ECOURTS_MONTHLY_LIMIT || env.ECOURTS_MONTHLY_LIMIT || 300);
  return { key, base: (process.env.ECOURTS_BASE_URL || env.ECOURTS_BASE_URL || DEFAULT_BASE).replace(/\/$/, ''), limit: Number.isFinite(limit) ? limit : 300 };
}

/** Count one paid lookup for this business this month; refuse past the cap. */
function charge(group: string, limit: number, n = 1): void {
  const month = new Date().toISOString().slice(0, 7);
  const file = path.join(dir(group), `usage-${month}.json`);
  let used = 0;
  try {
    used = Number(JSON.parse(fs.readFileSync(file, 'utf8')).used) || 0;
  } catch {
    /* first lookup this month */
  }
  if (used + n > limit) throw new Error(`This business has used its ${limit} court lookups for this month.`);
  fs.writeFileSync(file, JSON.stringify({ used: used + n }), { mode: 0o600 });
}

async function call(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<unknown> {
  const { key, base } = config();
  const res = await fetchImpl(`${base}${pathAndQuery}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: unknown; error?: { message?: string; code?: string } | string; message?: string };
  if (!res.ok) {
    const msg = typeof json.error === 'string' ? json.error : (json.error?.message ?? json.message ?? `HTTP ${res.status}`);
    if (res.status === 404) throw new Error('No case found for that CNR on eCourts.');
    throw new Error(`eCourts lookup failed: ${msg}`);
  }
  return json.data;
}

type Rec = Record<string, unknown>;
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The parts of a case a person asks about, small enough for a WhatsApp answer. */
export function summariseCase(data: unknown): Rec {
  const d = (data as Rec) ?? {};
  const c = (d.courtCaseData as Rec) ?? {};
  const hearings = arr(c.historyOfCaseHearings);
  const orders = [...arr(c.judgmentOrders), ...arr(c.interimOrders)]
    .map((o) => ({ date: o.orderDate, type: o.orderType ?? o.description, file: o.orderUrl }))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const lookup = ((d.descriptions as Rec)?.enumLookup as Rec) ?? {};
  const caseType = String(c.caseType ?? '');
  return {
    cnr: c.cnr,
    title: `${strs(c.petitioners).join(', ') || '?'} vs ${strs(c.respondents).join(', ') || '?'}`,
    caseType: ((lookup.caseType as Rec)?.[caseType] as string) ?? c.caseTypeRaw ?? caseType,
    caseNumber: c.registrationNumber ?? c.filingNumber,
    court: c.courtName,
    courtNo: c.courtNo,
    status: c.caseStatus,
    disposal: c.disposalTypeRaw ?? null,
    decisionDate: c.decisionDate ?? null,
    nextHearingDate: c.nextHearingDate ?? null,
    purpose: c.purpose ?? null,
    lastHearingDate: c.lastHearingDate ?? null,
    judges: strs(c.judges),
    petitioners: strs(c.petitioners),
    respondents: strs(c.respondents),
    petitionerAdvocates: strs(c.petitionerAdvocates),
    respondentAdvocates: strs(c.respondentAdvocates),
    recentHearings: hearings.slice(-5).map((h) => ({ date: h.businessOnDate, next: h.hearingDate ?? null, purpose: h.purposeOfListing, judge: h.judge || undefined })),
    latestOrders: orders.slice(0, 5),
    orderCount: c.orderCount ?? orders.length,
    dataUpdatedAt: (d.entityInfo as Rec)?.dateModified ?? null,
    source: 'eCourts (via eCourtsIndia)',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

registerResource({
  name: 'court',
  plural: 'court',
  table: '',
  description: 'Indian court case lookups (eCourts, all courts): case status by CNR, search by party/advocate, next listing.',
  idColumn: 'cnr',
  columns: [],
  operations: {},
  customOperations: {
    case: {
      access: 'open',
      description:
        'Status of a case by CNR: court, parties, advocates, status, next hearing date and purpose, last hearings, latest orders. Add --refresh to fetch fresh data from eCourts first (slower, costs one more lookup) when the person needs today\'s position.',
      args: [
        { name: 'cnr', type: 'string', required: true, description: '16-character CNR.' },
        { name: 'refresh', type: 'boolean', description: 'Fetch fresh data from eCourts first.' },
      ],
      handler: async (args, ctx) => {
        const group = groupOf(args, ctx);
        const cnr = cnrOf(args.cnr);
        const { limit } = config();
        const refresh = args.refresh === true || args.refresh === 'true';
        charge(group, limit, refresh ? 2 : 1);
        if (refresh) {
          await call('POST', `/api/partner/case/${cnr}/refresh`).catch(() => undefined);
          await sleep(8_000);
        }
        return summariseCase(await call('GET', `/api/partner/case/${cnr}`));
      },
    },
    search: {
      access: 'open',
      description: 'Find cases by party (litigant) name and/or advocate, optionally in one court (code like GJHC01). Use it to find a CNR, then save it with `ncl matters add`.',
      args: [
        { name: 'party', type: 'string', description: 'Petitioner or respondent name.' },
        { name: 'advocate', type: 'string', description: 'Advocate name.' },
        { name: 'court', type: 'string', description: 'Court code, e.g. GJHC01 (Gujarat High Court).' },
        { name: 'pending', type: 'boolean', description: 'Only pending cases.' },
      ],
      handler: async (args, ctx) => {
        const group = groupOf(args, ctx);
        const party = str(args.party);
        const advocate = str(args.advocate);
        if (!party && !advocate) throw new Error('Give --party or --advocate.');
        const { limit } = config();
        charge(group, limit);
        const q = new URLSearchParams({ pageSize: '10', nameMatchMode: 'fuzzy' });
        if (party) q.append('litigants', party);
        if (advocate) q.append('advocates', advocate);
        const court = str(args.court);
        if (court) q.append('courtCodes', court.toUpperCase());
        if (args.pending === true || args.pending === 'true') q.append('caseStatuses', 'PENDING');
        const data = (await call('GET', `/api/partner/search?${q.toString()}`)) as Rec;
        return {
          total: data?.totalHits ?? 0,
          results: arr(data?.results).map((r) => ({
            cnr: r.cnr,
            title: `${strs(r.petitioners).join(', ')} vs ${strs(r.respondents).join(', ')}`,
            court: r.courtCode,
            status: r.caseStatus,
            caseNumber: r.registrationNumber,
            nextHearingDate: r.nextHearingDate ?? null,
          })),
        };
      },
    },
    next: {
      access: 'open',
      description: 'Upcoming cause-list listing (date, court room, serial no.) for one or more CNRs (comma-separated, max 20).',
      args: [{ name: 'cnr', type: 'string', required: true, description: 'CNR, or several separated by commas.' }],
      handler: async (args, ctx) => {
        const group = groupOf(args, ctx);
        const cnrs = [...new Set(String(args.cnr ?? '').split(',').map((c) => cnrOf(c)))].slice(0, 20);
        const { limit } = config();
        charge(group, limit, cnrs.length);
        const data = await call('POST', '/api/partner/causelist/cnr/batch', { cnrs });
        return arr(data).map((r) => {
          const n = (r.nextListing as Rec) ?? null;
          return {
            cnr: r.cnr,
            listed: r.hasCauselist === true,
            next: n ? { date: n.date, court: n.courtName, courtNo: n.courtNo, serialNo: n.listingNo, purpose: n.listingFor, judge: strs(n.judge) } : null,
          };
        });
      },
    },
  },
});
