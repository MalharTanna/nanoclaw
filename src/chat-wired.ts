/**
 * Is this chat wired to an assistant on this install? Own numbers use it to
 * leave other chats alone entirely: no photo, voice note or file from a group
 * Miro is not on is ever downloaded. Cached briefly (a group turned on shows
 * up within WIRED_TTL_MS).
 */
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from './db/messaging-groups.js';

export const WIRED_TTL_MS = 15_000;
const cache = new Map<string, { at: number; wired: boolean }>();

export function isChatWired(platformId: string, now: number = Date.now()): boolean {
  const hit = cache.get(platformId);
  if (hit && now - hit.at < WIRED_TTL_MS) return hit.wired;
  const mg = getMessagingGroupByPlatform('whatsapp', platformId);
  const wired = !!mg && getMessagingGroupAgents(mg.id).length > 0;
  cache.set(platformId, { at: now, wired });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return wired;
}

/** For tests. */
export function clearWiredCache(): void {
  cache.clear();
}
