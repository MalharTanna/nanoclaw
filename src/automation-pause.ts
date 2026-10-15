/**
 * Unstable WhatsApp connection -> pause automated sends for a while.
 *
 * Frequent drops can come before WhatsApp logs a number out. When the
 * connection drops UNSTABLE_DROPS times within an hour, scheduled reminders
 * and tasks wait for PAUSE_MS (people's own messages still get answers).
 * State lives in data/automation-pause.json so the node-agent can report it
 * and it survives a restart. Shared-number installs only.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

export const UNSTABLE_DROPS = 4;
export const UNSTABLE_WINDOW_MS = 60 * 60_000;
export const PAUSE_MS = 60 * 60_000;

interface PauseState {
  drops: number[];
  pausedUntil: number | null;
}

export function automationPausePath(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'automation-pause.json');
}

function read(dataDir: string): PauseState {
  try {
    const s = JSON.parse(fs.readFileSync(automationPausePath(dataDir), 'utf8')) as Partial<PauseState>;
    return {
      drops: Array.isArray(s.drops) ? s.drops.filter((t) => typeof t === 'number') : [],
      pausedUntil: typeof s.pausedUntil === 'number' ? s.pausedUntil : null,
    };
  } catch {
    return { drops: [], pausedUntil: null };
  }
}

/** Record a connection drop. True when this drop starts a new pause. */
export function noteConnectionDrop(now: number = Date.now(), dataDir = DATA_DIR): boolean {
  const s = read(dataDir);
  s.drops = [...s.drops.filter((t) => now - t < UNSTABLE_WINDOW_MS), now];
  const alreadyPaused = s.pausedUntil !== null && s.pausedUntil > now;
  const starts = !alreadyPaused && s.drops.length >= UNSTABLE_DROPS;
  if (starts) s.pausedUntil = now + PAUSE_MS;
  try {
    fs.writeFileSync(automationPausePath(dataDir), JSON.stringify(s));
  } catch {
    /* best effort */
  }
  return starts;
}

/** When automated sends may resume, or null when they are not paused. */
export function automationPausedUntil(now: number = Date.now(), dataDir = DATA_DIR): number | null {
  const until = read(dataDir).pausedUntil;
  return until !== null && until > now ? until : null;
}
