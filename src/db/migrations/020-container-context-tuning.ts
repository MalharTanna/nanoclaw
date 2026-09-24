import type { Migration } from './index.js';

/**
 * Per-agent-group context tuning on `container_configs`.
 *
 * `compact_window` — token count at which Claude auto-compacts the session
 * (CLAUDE_CODE_AUTO_COMPACT_WINDOW inside the container).
 * `rotate_age_days` — age after which the session transcript is archived and
 * a fresh session starts (CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS).
 *
 * NULL = inherit the install-wide .env value, else the agent-runner default —
 * so existing groups behave exactly as before. No backfill.
 */
export const migration020: Migration = {
  version: 20,
  name: 'container-context-tuning',
  up(db) {
    db.exec(`
      ALTER TABLE container_configs ADD COLUMN compact_window INTEGER;
      ALTER TABLE container_configs ADD COLUMN rotate_age_days REAL;
    `);
  },
};
