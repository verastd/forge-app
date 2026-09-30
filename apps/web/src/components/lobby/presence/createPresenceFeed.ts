import { livekitFeed } from './livekitFeed';
import { localFeed } from './localFeed';
import { noneFeed } from './noneFeed';
import type { FeedIdentity, PresenceFeed } from './types';

/**
 * The lobby's presence feed, per the lobby contract:
 * - nobody signed in: `'none'`, reason `'signed-out'`;
 * - the practice build: `'local'`, tabs in this browser over a
 *   BroadcastChannel, no voice;
 * - a live build: `'livekit'`, which settles on `'none'` with the reason if
 *   the token route refuses (401 signed-out, 403 practice, 503 unavailable,
 *   anything else error).
 *
 * Creating a feed has no side effects (it is safe during a server render);
 * nothing opens, listens or downloads until `connect()`.
 */
export function createPresenceFeed(opts: { demo: boolean; me: FeedIdentity | null }): PresenceFeed {
  if (opts.me === null) return noneFeed('signed-out');
  return opts.demo ? localFeed(opts.me) : livekitFeed();
}
