import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dir: `${process.env.TMPDIR ?? '/tmp'}/nanoclaw-test-court-${process.pid}` }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: h.dir };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { findMatters, setCourtFetch, summariseCase } from './court.js';

const a: CallerContext = { caller: 'agent', agentGroupId: 'ag-1', sessionId: 's-1', messagingGroupId: 'mg-1' };
const b: CallerContext = { caller: 'agent', agentGroupId: 'ag-2', sessionId: 's-2', messagingGroupId: 'mg-2' };
const CNR = 'GJHC010012342025';

const CASE = {
  courtCaseData: {
    cnr: CNR,
    caseType: 'SCA',
    caseTypeRaw: 'Special Civil Application',
    registrationNumber: '1234/2025',
    courtName: 'High Court of Gujarat',
    courtNo: 12,
    caseStatus: 'PENDING',
    nextHearingDate: '2026-10-20',
    purpose: 'Admission',
    lastHearingDate: '2026-10-06',
    petitioners: ['RAMESH SHARMA'],
    respondents: ['STATE OF GUJARAT'],
    petitionerAdvocates: ['DHRUVIN BHUPTANI'],
    historyOfCaseHearings: [{ businessOnDate: '2026-10-06', hearingDate: '2026-10-20', purposeOfListing: 'Admission', judge: 'HON J. X' }],
    interimOrders: [{ orderDate: '2026-10-06', description: 'COPY OF ORDER', orderUrl: 'order-1.pdf' }],
    judgmentOrders: [],
  },
  entityInfo: { dateModified: '2026-10-12T09:00:00Z' },
  descriptions: { enumLookup: { caseType: { SCA: 'Special Civil Application' } } },
};

let calls: { url: string; method?: string; auth?: string }[] = [];
function api(responder: (url: string) => unknown = () => CASE) {
  setCourtFetch(async (url, init) => {
    calls.push({ url, method: init?.method, auth: init?.headers?.Authorization });
    return { ok: true, status: 200, json: async () => ({ data: responder(url) }) };
  });
}

beforeEach(() => {
  if (fs.existsSync(h.dir)) fs.rmSync(h.dir, { recursive: true });
  fs.mkdirSync(h.dir, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({ id: 'ag-1', name: 'ag-1', folder: 'ag-1', agent_provider: null, created_at: new Date().toISOString() });
  createAgentGroup({ id: 'ag-2', name: 'ag-2', folder: 'ag-2', agent_provider: null, created_at: new Date().toISOString() });
  process.env.ECOURTS_API_KEY = 'eci_live_test';
  process.env.ECOURTS_MONTHLY_LIMIT = '3';
  calls = [];
  api();
});
afterEach(() => {
  setCourtFetch(null);
  delete process.env.ECOURTS_API_KEY;
  delete process.env.ECOURTS_MONTHLY_LIMIT;
  closeDb();
  if (fs.existsSync(h.dir)) fs.rmSync(h.dir, { recursive: true });
});

const run = (command: string, args: Record<string, unknown>, ctx: CallerContext = a) => dispatch({ id: 'r', command, args }, ctx);

describe('client matters', () => {
  it('save, find by client name, and each business sees only its own', async () => {
    expect((await run('matters-add', { client: 'Sharma', cnr: 'gjhc0100-1234-2025', title: 'Sharma vs State' })).ok).toBe(true);
    await run('matters-add', { client: 'Patel Industries', cnr: 'GJAH010000012024' });
    const found = await run('matters-find', { q: 'sharma' });
    expect(found.ok && (found.data as { cnr: string }[]).map((m) => m.cnr)).toEqual([CNR]);
    const other = await run('matters-list', {}, b);
    expect(other.ok && other.data).toEqual([]);
    expect((await run('matters-add', { client: 'X', cnr: 'BAD' })).ok).toBe(false);
    await run('matters-remove', { cnr: CNR });
    const left = await run('matters-list', {});
    expect(left.ok && (left.data as unknown[]).length).toBe(1);
  });

  it('find matches all words in any order, across client, title and note', () => {
    const ms = [{ client: 'Ramesh Sharma', cnr: CNR, title: 'Land matter', addedAt: '' }];
    expect(findMatters(ms, 'sharma land')).toHaveLength(1);
    expect(findMatters(ms, 'patel')).toHaveLength(0);
  });
});

describe('court lookups', () => {
  it('case status by CNR: key sent only from the host, compact answer', async () => {
    const r = await run('court-case', { cnr: CNR });
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ url: `https://webapi.ecourtsindia.com/api/partner/case/${CNR}`, auth: 'Bearer eci_live_test' });
    expect(r.ok && r.data).toMatchObject({
      title: 'RAMESH SHARMA vs STATE OF GUJARAT',
      caseType: 'Special Civil Application',
      status: 'PENDING',
      nextHearingDate: '2026-10-20',
      purpose: 'Admission',
      latestOrders: [{ date: '2026-10-06', file: 'order-1.pdf' }],
    });
    expect(JSON.stringify(r)).not.toContain('eci_live_test');
  });

  it('search by party and next listing', async () => {
    api((url) => (url.includes('/search') ? { totalHits: 1, results: [{ cnr: CNR, petitioners: ['A'], respondents: ['B'], caseStatus: 'PENDING' }] } : [{ cnr: CNR, hasCauselist: true, nextListing: { date: '2026-10-20', courtName: 'Court 12', courtNo: '12', listingNo: 7, judge: ['X'] } }]));
    const s = await run('court-search', { party: 'Ramesh Sharma', court: 'gjhc01' });
    expect(calls[0].url).toContain('litigants=Ramesh+Sharma');
    expect(calls[0].url).toContain('courtCodes=GJHC01');
    expect(s.ok && s.data).toMatchObject({ total: 1, results: [{ cnr: CNR, title: 'A vs B' }] });
    const n = await run('court-next', { cnr: CNR });
    expect(n.ok && n.data).toEqual([{ cnr: CNR, listed: true, next: { date: '2026-10-20', court: 'Court 12', courtNo: '12', serialNo: 7, purpose: undefined, judge: ['X'] } }]);
  });

  it('caps lookups per business per month, and says so plainly without a key', async () => {
    for (let i = 0; i < 3; i++) expect((await run('court-case', { cnr: CNR })).ok).toBe(true);
    const over = await run('court-case', { cnr: CNR });
    expect(over.ok).toBe(false);
    expect(JSON.stringify(over)).toContain('court lookups for this month');
    expect((await run('court-case', { cnr: CNR }, b)).ok).toBe(true); // another business has its own count
    delete process.env.ECOURTS_API_KEY;
    const noKey = await run('court-case', { cnr: CNR }, b);
    expect(JSON.stringify(noKey)).toContain('not set up');
  });

  it('summariseCase copes with missing fields', () => {
    expect(summariseCase({})).toMatchObject({ title: '? vs ?', latestOrders: [] });
  });
});
