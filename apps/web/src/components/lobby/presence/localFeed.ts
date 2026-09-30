/**
 * The practice build's presence feed: tabs in one browser see each other
 * over a BroadcastChannel, with no server and no voice.
 *
 * Each tab joins as `practice-<6 hex>` under the signed-in name. It sends its
 * encoded position under the lobby send policy (at most 10 Hz while moving,
 * 1 Hz while still), plus a 1 Hz `hello` so the others know it is there, and
 * a `bye` when it closes or the page is hidden. A peer that sends nothing for
 * three seconds is dropped. A tab heard from before its first position (a
 * `hello` without one) is listed as joining.
 *
 * Messages come from other tabs, so they are parsed as untrusted input: the
 * shape is checked, names are sanitised, positions must decode, and each
 * sender is rate limited.
 */
import {
  acceptPacket,
  createPacketLimiter,
  decodePosition,
  encodePosition,
  forgetSender,
  sanitizeName,
  sendPolicy,
} from '@forge/lobby';

import type { FeedIdentity, FeedStatus, PeerState, PresenceFeed, SelfState } from './types';

/** The channel every practice tab on this origin shares. */
export const LOCAL_CHANNEL = 'forge.lobby';
const HELLO_INTERVAL_MS = 1000;
/** A peer silent for this long has gone (closed without a `bye`, or frozen). */
const PEER_TIMEOUT_MS = 3000;
const ID_PATTERN = /^practice-[0-9a-f]{6}$/;

type Message =
  | { type: 'hello'; id: string; name: string; pos?: Uint8Array }
  | { type: 'pos'; id: string; name: string; pos: Uint8Array }
  | { type: 'bye'; id: string };

interface Seen {
  at: number;
  name: string;
  position: SelfState | null;
}

export function localFeed(me: FeedIdentity): PresenceFeed {
  const name = sanitizeName(me.name);
  const peers = new Map<string, PeerState>();
  /** Tabs heard from with no position yet: id → name. */
  const joining = new Map<string, string>();
  const seen = new Map<string, Seen>();
  let limiter = createPacketLimiter();
  let status: FeedStatus = { kind: 'local', state: 'connecting' };
  let id = '';
  let channel: BroadcastChannel | null = null;
  let helloTimer: ReturnType<typeof setInterval> | undefined;
  let latest: SelfState | null = null;
  let lastSent: SelfState | null = null;
  let lastSentAt = 0;

  const post = (message: Message): void => {
    try {
      channel?.postMessage(message);
    } catch {
      // A closed channel throws; there is nobody left to tell.
    }
  };

  const drop = (peerId: string): void => {
    seen.delete(peerId);
    peers.delete(peerId);
    joining.delete(peerId);
    forgetSender(limiter, peerId);
  };

  const expire = (now: number): void => {
    for (const [peerId, entry] of seen) {
      if (now - entry.at > PEER_TIMEOUT_MS) drop(peerId);
    }
  };

  const hello = (): void => {
    post(latest === null ? { type: 'hello', id, name } : { type: 'hello', id, name, pos: encodePosition(latest) });
    expire(performance.now());
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    const message = parseMessage(event.data);
    if (message === null || message.id === id) return;
    if (message.type === 'bye') {
      drop(message.id);
      return;
    }
    const now = performance.now();
    if (!acceptPacket(limiter, message.id, now)) return;
    let position: SelfState | null = null;
    if (message.pos !== undefined) {
      position = decodePosition(message.pos);
      // A position that does not decode spoils the whole message.
      if (position === null) return;
    }
    const known = seen.get(message.id);
    // Somebody new: send our position on the next frame rather than at the next heartbeat.
    if (known === undefined) lastSent = null;
    const entry: Seen = { at: now, name: message.name, position: position ?? known?.position ?? null };
    seen.set(message.id, entry);
    if (entry.position !== null) {
      joining.delete(message.id);
      peers.set(message.id, { id: message.id, name: entry.name, talking: false, ...entry.position });
    } else {
      joining.set(message.id, entry.name);
    }
  };

  const onPageHide = (): void => {
    post({ type: 'bye', id });
  };

  return {
    kind: 'local',

    connect() {
      if (channel !== null) return Promise.resolve();
      if (typeof BroadcastChannel === 'undefined') {
        status = { kind: 'local', state: 'closed' };
        return Promise.resolve();
      }
      id = `practice-${randomHex(3)}`;
      channel = new BroadcastChannel(LOCAL_CHANNEL);
      channel.addEventListener('message', onMessage);
      window.addEventListener('pagehide', onPageHide);
      helloTimer = setInterval(hello, HELLO_INTERVAL_MS);
      status = { kind: 'local', state: 'connected' };
      lastSent = null;
      hello();
      return Promise.resolve();
    },

    status: () => status,

    publish(state) {
      if (channel === null) return;
      latest = { x: state.x, y: state.y, z: state.z, yaw: state.yaw };
      const now = performance.now();
      if (!sendPolicy(lastSent, lastSentAt, now, latest)) return;
      lastSent = latest;
      lastSentAt = now;
      post({ type: 'pos', id, name, pos: encodePosition(latest) });
    },

    peers() {
      expire(performance.now());
      return peers;
    },

    joining: () => joining,

    setMic: () => Promise.resolve(false),
    micOn: () => false,
    micLevel: () => 0,
    voiceAvailable: () => false,
    setListener: () => undefined,

    close() {
      if (channel === null) return;
      post({ type: 'bye', id });
      channel.removeEventListener('message', onMessage);
      channel.close();
      channel = null;
      window.removeEventListener('pagehide', onPageHide);
      clearInterval(helloTimer);
      helloTimer = undefined;
      seen.clear();
      peers.clear();
      joining.clear();
      limiter = createPacketLimiter();
      latest = null;
      lastSent = null;
      status = { kind: 'local', state: 'closed' };
    },
  };
}

/** A message from another tab, or null for anything this build does not send. */
function parseMessage(data: unknown): Message | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, id, name, pos } = data as Record<string, unknown>;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  if (type === 'bye') return { type, id };
  if (type !== 'hello' && type !== 'pos') return null;
  if (pos !== undefined && !(pos instanceof Uint8Array)) return null;
  if (type === 'pos') {
    return pos === undefined ? null : { type, id, name: sanitizeName(name), pos };
  }
  return pos === undefined ? { type, id, name: sanitizeName(name) } : { type, id, name: sanitizeName(name), pos };
}

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}
