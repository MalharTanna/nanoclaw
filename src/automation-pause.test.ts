import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { automationPausedUntil, noteConnectionDrop, PAUSE_MS } from './automation-pause.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const T = 1_800_000_000_000;
const min = 60_000;

describe('automation pause on an unstable connection', () => {
  it('pauses for an hour on the 4th drop within an hour, once', () => {
    expect(noteConnectionDrop(T, dir)).toBe(false);
    expect(noteConnectionDrop(T + 10 * min, dir)).toBe(false);
    expect(noteConnectionDrop(T + 20 * min, dir)).toBe(false);
    expect(automationPausedUntil(T + 20 * min, dir)).toBeNull();
    expect(noteConnectionDrop(T + 30 * min, dir)).toBe(true);
    expect(automationPausedUntil(T + 31 * min, dir)).toBe(T + 30 * min + PAUSE_MS);
    expect(noteConnectionDrop(T + 35 * min, dir)).toBe(false); // already paused
    expect(automationPausedUntil(T + 30 * min + PAUSE_MS + 1, dir)).toBeNull();
  });

  it('normal drops spread over the day never pause', () => {
    for (let i = 0; i < 10; i++) expect(noteConnectionDrop(T + i * 90 * min, dir)).toBe(false);
    expect(automationPausedUntil(T + 900 * min, dir)).toBeNull();
  });
});
