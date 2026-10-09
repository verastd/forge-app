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
 *
 * The people panel lists the same people from `voice()`: their distance and
 * nearness, and nothing voice-related (zero, or null where the type allows),
 * since nothing here carries sound. It is checked five times a second while
 * the channel is open, and a change notifies `onVoice` listeners.
 *
 * Development builds only (next build compiles it out): `/apps?voice-fixture=full`
 * makes `voice()` the people panel's fullest state instead, so e2e can lay it
 * out on any screen without a LiveKit server (see `fullVoiceFixture`).
 */
import {
  acceptPacket,
  createPacketLimiter,
  decodePosition,
  encodePosition,
  forgetSender,
  nearness,
  sanitizeName,
  sendPolicy,
} from '@forge/lobby';

import { NO_VOICE, sortPeople } from './noneFeed';
import type { FeedIdentity, FeedStatus, PeerState, Person, PresenceFeed, SelfState, VoiceSnapshot } from './types';

/** The channel every practice tab on this origin shares. */
export const LOCAL_CHANNEL = 'forge.lobby';
const HELLO_INTERVAL_MS = 1000;
/** A peer silent for this long has gone (closed without a `bye`, or frozen). */
const PEER_TIMEOUT_MS = 3000;
const ID_PATTERN = /^practice-[0-9a-f]{6}$/;
/** How often the people panel's snapshot is checked for a change. */
const VOICE_INTERVAL_MS = 200;

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
  const listeners = new Set<() => void>();
  let voice: VoiceSnapshot = NO_VOICE;
  let voiceKey = JSON.stringify([status, NO_VOICE]);
  let voiceTimer: ReturnType<typeof setInterval> | undefined;
  /** The panel's fullest state, standing in for `voice()` (development builds only). */
  let fixture: VoiceSnapshot | null = null;

  /** One person per peer and per tab still joining; distances from where we last published. */
  const people = (): Person[] => {
    const list: Person[] = [];
    for (const peer of peers.values()) {
      const metres = latest === null ? null : Math.hypot(peer.x - latest.x, peer.y - latest.y, peer.z - latest.z);
      list.push(person(peer.id, peer.name, metres));
    }
    for (const [peerId, peerName] of joining) list.push(person(peerId, peerName, null));
    return sortPeople(list);
  };

  /** A new snapshot, and a notification, only when something in it changed. */
  const refreshVoice = (): void => {
    expire(performance.now());
    const next: VoiceSnapshot = fixture ?? { ...NO_VOICE, people: people() };
    const key = JSON.stringify([status, next]);
    if (key === voiceKey) return;
    voiceKey = key;
    voice = next;
    for (const listener of [...listeners]) listener();
  };

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
        refreshVoice();
        return Promise.resolve();
      }
      if (process.env.NODE_ENV !== 'production') {
        fixture = new URLSearchParams(window.location.search).get('voice-fixture') === 'full' ? fullVoiceFixture() : null;
      }
      id = `practice-${randomHex(3)}`;
      channel = new BroadcastChannel(LOCAL_CHANNEL);
      channel.addEventListener('message', onMessage);
      window.addEventListener('pagehide', onPageHide);
      helloTimer = setInterval(hello, HELLO_INTERVAL_MS);
      voiceTimer = setInterval(refreshVoice, VOICE_INTERVAL_MS);
      status = { kind: 'local', state: 'connected' };
      lastSent = null;
      hello();
      refreshVoice();
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

    voice: () => voice,

    onVoice(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setDeafened(on) {
      if (process.env.NODE_ENV !== 'production' && fixture !== null) {
        fixture = { ...fixture, deafened: on };
        refreshVoice();
      }
    },
    // The local feed plays no sound: the level only matters to a room with voices.
    setReverbLevel() {},
    setMuted(peerId, muted) {
      if (process.env.NODE_ENV !== 'production' && fixture !== null) {
        fixture = {
          ...fixture,
          people: fixture.people.map((p) => (p.id === peerId ? { ...p, mutedByYou: muted, direct: 0, reverb: 0 } : p)),
        };
        refreshVoice();
      }
    },
    resumeAudio() {
      if (process.env.NODE_ENV !== 'production' && fixture !== null) {
        fixture = { ...fixture, soundBlocked: false };
        refreshVoice();
      }
      return Promise.resolve();
    },
    retryRoomSound() {
      if (process.env.NODE_ENV !== 'production' && fixture !== null) {
        fixture = { ...fixture, roomSound: 'rendering' };
        refreshVoice();
      }
    },

    close() {
      if (channel === null) return;
      post({ type: 'bye', id });
      channel.removeEventListener('message', onMessage);
      channel.close();
      channel = null;
      window.removeEventListener('pagehide', onPageHide);
      clearInterval(helloTimer);
      helloTimer = undefined;
      clearInterval(voiceTimer);
      voiceTimer = undefined;
      seen.clear();
      peers.clear();
      joining.clear();
      limiter = createPacketLimiter();
      latest = null;
      lastSent = null;
      status = { kind: 'local', state: 'closed' };
      refreshVoice();
    },
  };
}

/** Someone as the people panel lists them on a feed without voice: where they are, and nothing else. */
function person(id: string, name: string, metres: number | null): Person {
  return {
    id,
    name,
    distance: metres === null ? null : Math.round(metres * 2) / 2,
    nearness: metres === null ? 0 : Math.round(nearness(metres) * 50) / 50,
    direct: 0,
    reverb: 0,
    cutoffHz: 0,
    occlusion: 0,
    reception: null,
    crowded: false,
    speaking: false,
    micOn: false,
    mutedByYou: false,
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

/**
 * The people panel at its fullest, for the layout e2e (development builds
 * only; `?voice-fixture=full`): voice on with sound held back, the cave sound
 * failed, the mic refused, and eight people. The farthest one in range is
 * speaking, so a phone must show them among its first four; one is too
 * crowded to hear, one has their mic off, one you muted, the longest name
 * GitHub allows, one still received at 38 m but past the falloff, and one
 * still joining. The feed's own buttons act on it:
 * "Turn on sound" and Retry go away as they would.
 */
function fullVoiceFixture(): VoiceSnapshot {
  const person = (id: string, name: string, distance: number | null, extra: Partial<Person> = {}): Person => ({
    id,
    name,
    distance,
    nearness: distance === null ? 0 : Math.round(nearness(distance) * 50) / 50,
    direct: 0,
    reverb: 0,
    cutoffHz: 18_000,
    occlusion: 0,
    reception: distance === null ? 'out-of-range' : 'in-range',
    crowded: false,
    speaking: false,
    micOn: true,
    mutedByYou: false,
    ...extra,
  });
  return {
    available: true,
    connection: 'connected',
    mic: 'off',
    micProblem: 'denied',
    deafened: false,
    soundBlocked: true,
    roomSound: 'failed',
    speaking: false,
    people: [
      person('gh:1001', 'mara', 2, { direct: 1, reverb: 0.3 }),
      person('gh:1002', 'a-login-as-long-as-github-allows-them-x', 6, { direct: 0.72, reverb: 0.28 }),
      person('gh:1003', 'devon-kit', 9.5, { mutedByYou: true }),
      person('gh:1004', 'octocat', 14, { micOn: false }),
      person('gh:1005', 'crowded-out', 21, { reception: 'out-of-range', crowded: true }),
      person('gh:1006', 'far-talker', 31, { direct: 0.04, reverb: 0.13, cutoffHz: 2_400, speaking: true }),
      person('gh:1008', 'past-the-echo', 38),
      person('gh:1007', 'just-arrived', null),
    ],
  };
}
