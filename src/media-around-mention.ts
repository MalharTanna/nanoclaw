/**
 * Groups answer only when the assistant is mentioned, and a voice note,
 * photo or file usually can't mention it. So, per person in a group:
 *
 *   - mention after the file: "Miro, what is this?" sent within 5 minutes of
 *     that person's own voice note / photo / PDF brings the file along;
 *   - mention before the file: "Miro" then, within 2 minutes, the file from
 *     the same person counts as addressed too.
 *
 * Only the same person's files, only briefly, and only in memory: a file
 * nobody asked Miro about is never kept or processed.
 */
export const BEFORE_MS = 5 * 60_000;
export const AFTER_MS = 2 * 60_000;
const MAX_ENTRIES = 200;

export class MediaAroundMention<A> {
  private readonly recent = new Map<string, { at: number; attachments: A[] }>();
  private readonly waiting = new Map<string, number>();

  /**
   * One group message from `key` (chat + sender). Returns the attachments to
   * use and whether the message counts as addressed.
   */
  apply(key: string, now: number, msg: { addressed: boolean; attachments: A[] }): { attachments: A[]; addressed: boolean } {
    this.evict(now);
    if (msg.addressed) {
      this.waiting.delete(key);
      if (msg.attachments.length > 0) return msg;
      const before = this.recent.get(key);
      if (before && now - before.at <= BEFORE_MS) {
        this.recent.delete(key);
        return { attachments: before.attachments, addressed: true };
      }
      this.waiting.set(key, now);
      return msg;
    }
    if (msg.attachments.length === 0) return msg;
    const asked = this.waiting.get(key);
    if (asked !== undefined && now - asked <= AFTER_MS) {
      this.waiting.delete(key);
      return { attachments: msg.attachments, addressed: true };
    }
    this.recent.delete(key); // keep insertion order = age, for eviction
    this.recent.set(key, { at: now, attachments: msg.attachments });
    return msg;
  }

  private evict(now: number): void {
    for (const [k, v] of this.recent) if (now - v.at > BEFORE_MS) this.recent.delete(k);
    for (const [k, at] of this.waiting) if (now - at > AFTER_MS) this.waiting.delete(k);
    while (this.recent.size > MAX_ENTRIES) this.recent.delete(this.recent.keys().next().value!);
    while (this.waiting.size > MAX_ENTRIES) this.waiting.delete(this.waiting.keys().next().value!);
  }
}
