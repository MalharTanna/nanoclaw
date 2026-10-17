import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DailySendBudget,
  NOTICE_RESERVE,
  bookJoinSlot,
  dailyCeiling,
  groupJoinsPerDay,
  istDay,
  joinTimeText,
  linkedSince,
  markLinked,
  nextJoinSlot,
} from './wa-limits.js';

const DAY = 24 * 60 * 60_000;
// 2026-10-20 10:00 IST
const NOW = Date.parse('2026-10-20T04:30:00.000Z');

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-limits-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('daily ceiling ramps up while the number is new', () => {
  it('150, 300, 500, then 800 (or the configured max)', () => {
    expect(dailyCeiling(NOW, NOW, 800)).toBe(150);
    expect(dailyCeiling(NOW - 8 * DAY, NOW, 800)).toBe(300);
    expect(dailyCeiling(NOW - 15 * DAY, NOW, 800)).toBe(500);
    expect(dailyCeiling(NOW - 40 * DAY, NOW, 800)).toBe(800);
    expect(dailyCeiling(NOW - 40 * DAY, NOW, 400)).toBe(400);
  });

  it('counts from the first connect of this number; a new number starts again', () => {
    markLinked('917984941891', NOW - 10 * DAY, dir);
    markLinked('917984941891', NOW, dir); // a reconnect keeps the date
    expect(linkedSince(NOW, dir)).toBe(NOW - 10 * DAY);
    markLinked('919999999999', NOW, dir);
    expect(linkedSince(NOW, dir)).toBe(NOW);
  });
});

describe('DailySendBudget', () => {
  it('sends up to the ceiling, then one notice per chat, then holds; a new India day resets it', () => {
    let now = NOW;
    const b = new DailySendBudget(path.join(dir, 'sent.json'), () => now, () => now);
    for (let i = 0; i < 150; i++) expect(b.take('a@s.whatsapp.net')).toBe('send');
    expect(b.take('a@s.whatsapp.net')).toBe('notice');
    expect(b.take('a@s.whatsapp.net')).toBe('hold');
    expect(b.take('b@g.us')).toBe('notice');
    // Survives a restart.
    expect(new DailySendBudget(path.join(dir, 'sent.json'), () => now, () => now).take('b@g.us')).toBe('hold');
    now += DAY;
    expect(b.take('a@s.whatsapp.net')).toBe('send');
  });

  it('notices are limited too', () => {
    const b = new DailySendBudget(path.join(dir, 'sent.json'), () => NOW, () => NOW);
    for (let i = 0; i < 150; i++) b.take('x');
    for (let i = 0; i < NOTICE_RESERVE; i++) expect(b.take(`chat-${i}`)).toBe('notice');
    expect(b.take('one-more')).toBe('hold');
  });
});

describe('group join cooling', () => {
  it('3 a day for the first two weeks, then 5', () => {
    expect(groupJoinsPerDay(NOW, NOW)).toBe(3);
    expect(groupJoinsPerDay(NOW - 15 * DAY, NOW)).toBe(5);
  });

  it('30 minutes apart, 8 AM - 9 PM India time, and the day after once full', () => {
    const since = NOW;
    const taken: number[] = [];
    const book = (t: number) => {
      const s = nextJoinSlot(taken, t, since);
      taken.push(s);
      return s;
    };
    expect(book(NOW)).toBe(NOW);
    expect(book(NOW)).toBe(NOW + 30 * 60_000);
    expect(book(NOW)).toBe(NOW + 60 * 60_000);
    const fourth = book(NOW); // day full: next day 8 AM IST
    expect(istDay(fourth)).toBe('2026-10-21');
    expect(new Date(fourth).toISOString()).toBe('2026-10-21T02:30:00.000Z');
    // At night it waits for the morning.
    const night = Date.parse('2026-10-22T17:00:00.000Z'); // 10:30 PM IST
    expect(new Date(nextJoinSlot([], night, since - 30 * DAY)).toISOString()).toBe('2026-10-23T02:30:00.000Z');
  });

  it('books slots on disk and refuses when the wait would pass 40 hours', () => {
    markLinked('917984941891', NOW, dir);
    const slots = Array.from({ length: 6 }, () => bookJoinSlot(NOW, dir));
    expect(slots.slice(0, 6).every((s) => s !== null)).toBe(true); // today 3 + tomorrow 3
    expect(bookJoinSlot(NOW, dir)).toBeNull(); // day after tomorrow 8 AM is > 40 h away
  });

  it('says when, in India time', () => {
    expect(joinTimeText(NOW + 30 * 60_000, NOW)).toBe('10:30 AM today');
    expect(joinTimeText(Date.parse('2026-10-21T02:30:00.000Z'), NOW)).toBe('8:00 AM tomorrow');
  });
});
