/**
 * Groups: after someone addresses the assistant (tags it, names it, or replies
 * to it), their next messages in that group for FOLLOW_UP_MS count as
 * addressed too, so a conversation needs no tag on every message. Per person
 * and group; each addressed message slides the window. A message that tags
 * someone else ends it (they are talking to that person now). In memory only.
 */
export const FOLLOW_UP_MS = 5 * 60_000;
const MAX_ENTRIES = 500;

export class FollowUpWindow {
  private readonly open = new Map<string, number>();

  constructor(private readonly windowMs: number = FOLLOW_UP_MS) {}

  /**
   * One group message from `key` (chat + sender). Returns whether it counts as
   * addressed: it was addressed itself, or it follows one within the window.
   */
  apply(key: string, now: number, msg: { addressed: boolean; tagsSomeoneElse: boolean }): boolean {
    this.evict(now);
    if (msg.addressed) {
      this.open.delete(key); // keep insertion order = age
      this.open.set(key, now);
      return true;
    }
    const at = this.open.get(key);
    if (at === undefined) return false;
    if (msg.tagsSomeoneElse) {
      this.open.delete(key);
      return false;
    }
    if (now - at > this.windowMs) {
      this.open.delete(key);
      return false;
    }
    this.open.delete(key);
    this.open.set(key, now);
    return true;
  }

  private evict(now: number): void {
    for (const [k, at] of this.open) if (now - at > this.windowMs) this.open.delete(k);
    while (this.open.size > MAX_ENTRIES) this.open.delete(this.open.keys().next().value!);
  }
}
