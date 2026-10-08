/**
 * The live build's presence feed: positions and proximity voice over
 * LiveKit, as a thin adapter on Fable's ProximityVoiceEngine
 * (../voice/engine.ts), which owns the room, the packets and the audio.
 *
 * `connect()` asks this origin for a room token (`POST /api/lobby/token`)
 * first, and only with one in hand loads the engine (and `livekit-client`
 * with it) by `import()`: a refusal (401 signed-out, 403 practice, 503
 * unavailable) never downloads it, and neither does a page that never joins
 * (the practice build, a signed-out visitor). The engine hands that first
 * token back to its own join, and asks the route again for every later one
 * ("Rejoin here" after another tab took the seat, "Try again" after a join
 * that failed in this browser, which reports `'failed'` rather than the
 * route's `'error'`).
 *
 * The engine runs on its own timer (VOICE.positionHz), so a hidden tab keeps
 * hearing, evaluating and sending its heartbeat. Here its snapshot becomes
 * the feed's: the scene's peers (with `talking` meaning speaking and audible)
 * and joining list, the shell's status, and the people panel's voice
 * snapshot, rounded and throttled as types.ts describes.
 */
import { REVERB_LEVEL, VOICE, clampReverbLevel, nearness, reverbWetFor } from '@forge/lobby';

import type * as Engine from '../voice/engine';
import type {
  EngineSnapshot,
  PeerSnapshot,
  ProximityConfig,
  ProximityVoiceEngine,
  SubscriptionState,
  TokenResponse,
} from '../voice/engine';
import { NO_VOICE, sortPeople } from './noneFeed';
import type { NoneReason } from './noneFeed';
import type {
  FeedStatus,
  MicState,
  PeerState,
  Person,
  PresenceFeed,
  Reception,
  RoomSound,
  SelfState,
  VoiceConnection,
  VoiceSnapshot,
} from './types';

/** Where the feed asks for a room token: apps/web/src/app/api/lobby/token/route.ts. */
export const TOKEN_PATH = '/api/lobby/token';
/** The one room. The token route names it too; the engine's join only labels its snapshot with it. */
const ROOM = 'lobby';
/** The panel's numbers change at most this often (types.ts). */
const VOICE_INTERVAL_MS = 200;

const RECEPTION: Record<SubscriptionState, Reception> = {
  'out-of-range': 'out-of-range',
  subscribing: 'tuning-in',
  'in-range': 'in-range',
  unsubscribing: 'dropping',
};

/** The engine's config: the cave's settings (VOICE), with positions that never go stale and the listener's own reverb level. */
function engineConfig(reverbLevel: number): Partial<ProximityConfig> {
  return {
    fullVolumeDistance: VOICE.fullVolumeDistance,
    falloffDistance: VOICE.falloffDistance,
    curve: VOICE.curve,
    naturalDbAtMax: VOICE.naturalDbAtMax,
    subscribeMargin: VOICE.subscribeMargin,
    positionHz: VOICE.positionHz,
    spatialPanning: VOICE.spatialPanning,
    reverb: VOICE.reverb,
    reverbWet: reverbWetFor(reverbLevel),
    distanceMuffling: VOICE.distanceMuffling,
    // A member who stands still, or whose tab is hidden, keeps their place
    // for as long as they're in the room: Fable's 3 s staleness would drop
    // them, and with them their voice.
    positionStaleMs: Number.POSITIVE_INFINITY,
  };
}

export function livekitFeed(): PresenceFeed {
  let engine: ProximityVoiceEngine | null = null;
  let detach: (() => void) | null = null;
  /** The engine's latest snapshot; null until it exists. */
  let latest: EngineSnapshot | null = null;
  let status: FeedStatus = { kind: 'livekit', state: 'connecting' };
  /** Bumped by every connect() and close(), so a join that was overtaken stands down. */
  let generation = 0;
  let joining: Promise<void> | null = null;
  /** Where we are, from the scene, kept for an engine that doesn't exist yet; one object, filled every frame. */
  const self: SelfState = { x: 0, y: 0, z: 0, yaw: 0 };
  let placed = false;
  /** The listener's own reverb level, kept for an engine that doesn't exist yet. */
  let reverbLevel: number = REVERB_LEVEL.default;
  let peers = new Map<string, PeerState>();
  /** Participants the room knows whose position hasn't arrived: identity → name. */
  let unplaced = new Map<string, string>();

  const listeners = new Set<() => void>();
  let voice: VoiceSnapshot = { ...NO_VOICE, connection: 'connecting' };
  let shapeKey = '';
  let numbersKey = '';
  let notifiedAt = Number.NEGATIVE_INFINITY;
  let pending: VoiceSnapshot | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  const inRoom = (): boolean => latest !== null && connectionOf(latest) !== null && connectionOf(latest) !== 'closed';
  const available = (): boolean => {
    const connection = latest === null ? null : connectionOf(latest);
    return connection === 'connected' || connection === 'reconnecting';
  };

  const notify = (next: VoiceSnapshot): void => {
    clearTimeout(pendingTimer);
    pendingTimer = undefined;
    pending = null;
    voice = next;
    notifiedAt = performance.now();
    for (const listener of [...listeners]) listener();
  };

  /**
   * Publishes a new voice snapshot: at once when anything but the numbers
   * changed (who's here, their states, the status), and otherwise at most
   * every VOICE_INTERVAL_MS, keeping the latest numbers for when it's time.
   */
  const update = (): void => {
    const next = latest === null ? { ...NO_VOICE, connection: connectionBefore(status) } : voiceFrom(latest);
    const shape = shapeOf(status, next);
    const numbers = numbersOf(next);
    if (shape !== shapeKey) {
      shapeKey = shape;
      numbersKey = numbers;
      notify(next);
      return;
    }
    if (numbers === numbersKey) return;
    numbersKey = numbers;
    pending = next;
    const wait = notifiedAt + VOICE_INTERVAL_MS - performance.now();
    if (wait <= 0) {
      notify(next);
    } else {
      pendingTimer ??= setTimeout(() => {
        pendingTimer = undefined;
        if (pending !== null) notify(pending);
      }, wait);
    }
  };

  const setStatus = (next: FeedStatus): void => {
    status = next;
    update();
  };

  const onEngine = (snap: EngineSnapshot): void => {
    latest = snap;
    // A new status object only when it says something new: the shell reads it as part of a store.
    const next = statusOf(snap);
    if (!sameStatus(next, status)) status = next;
    const nextPeers = new Map<string, PeerState>();
    const nextUnplaced = new Map<string, string>();
    for (const peer of snap.peers) {
      if (peer.position === null) {
        nextUnplaced.set(peer.identity, peer.name);
      } else {
        const { x, y, z, yaw } = peer.position;
        nextPeers.set(peer.identity, { id: peer.identity, name: peer.name, talking: audiblySpeaking(snap, peer), x, y, z, yaw });
      }
    }
    peers = nextPeers;
    unplaced = nextUnplaced;
    update();
  };

  const join = async (joinGeneration: number): Promise<void> => {
    if (engine === null) {
      setStatus({ kind: 'livekit', state: 'connecting' });
      const grant = await fetchGrant();
      if (joinGeneration !== generation) return;
      if (typeof grant === 'string') {
        setStatus({ kind: 'none', reason: grant });
        return;
      }
      let kit: typeof Engine;
      try {
        kit = await import('../voice/engine');
      } catch {
        // The route gave us a token; it's this browser that couldn't load the engine.
        if (joinGeneration === generation) setStatus({ kind: 'none', reason: 'failed' });
        return;
      }
      if (joinGeneration !== generation) return;
      let first: TokenResponse | null = grant;
      engine = new kit.ProximityVoiceEngine(engineConfig(reverbLevel), () => {
        const prefetched = first;
        first = null;
        return prefetched !== null ? Promise.resolve(prefetched) : fetchGrant();
      });
      if (placed) engine.setLocalPosition(self);
      detach = engine.subscribe(onEngine);
    }
    const current = engine;
    try {
      await current.join(ROOM);
    } catch {
      // join() never throws: a join that broke anyway failed here, in this browser.
      if (joinGeneration === generation && engine === current) setStatus({ kind: 'none', reason: 'failed' });
    }
  };

  // Every frame: copied into `self`, which the engine copies again, so the
  // frame loop allocates nothing here.
  const place = (state: SelfState): void => {
    if (!Number.isFinite(state.x) || !Number.isFinite(state.y) || !Number.isFinite(state.z) || !Number.isFinite(state.yaw)) {
      return;
    }
    self.x = state.x;
    self.y = state.y;
    self.z = state.z;
    self.yaw = state.yaw;
    placed = true;
    engine?.setLocalPosition(self);
  };

  return {
    kind: 'livekit',

    connect() {
      // A join still on its way in is the one to wait for. One whose room has
      // already settled (another tab took the seat, say, while LiveKit's own
      // connect() waits out its timeout) is over: "Rejoin here" starts afresh,
      // and the engine stands the old one down.
      if (joining !== null && (engine === null || inRoom())) return joining;
      if (engine !== null && inRoom()) return Promise.resolve();
      generation += 1;
      const pendingJoin = join(generation).finally(() => {
        if (joining === pendingJoin) joining = null;
      });
      joining = pendingJoin;
      return pendingJoin;
    },

    status: () => status,

    // Records where we are, which is also where we listen from; the engine's
    // tick sends it under the lobby's send policy.
    publish: place,

    peers: () => peers,

    joining: () => unplaced,

    async setMic(on) {
      const current = engine;
      if (current === null || !available()) return false;
      await current.setMicMuted(!on);
      return latest !== null && available() && micOf(latest) === 'on';
    },

    micOn: () => latest !== null && available() && micOf(latest) === 'on',

    micLevel: () => (engine !== null && available() ? engine.micLevel() : 0),

    voiceAvailable: available,

    // The scene calls it with the state it has just published: recorded there already.
    setListener: () => undefined,

    voice: () => voice,

    onVoice(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setDeafened(on) {
      engine?.setDeafened(on);
    },

    setReverbLevel(level) {
      reverbLevel = clampReverbLevel(level);
      engine?.updateConfig({ reverbWet: reverbWetFor(reverbLevel) });
    },

    setMuted(id, muted) {
      engine?.setPeerLocalMuted(id, muted);
    },

    resumeAudio: () => (engine === null ? Promise.resolve() : engine.resumeAudio()),

    retryRoomSound() {
      engine?.reloadReverb();
    },

    close() {
      generation += 1;
      joining = null;
      const current = engine;
      engine = null;
      detach?.();
      detach = null;
      latest = null;
      if (current !== null) void current.leave().catch(() => undefined);
      peers = new Map();
      unplaced = new Map();
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
      pending = null;
      if (status.kind === 'livekit') status = { kind: 'livekit', state: 'closed' };
      update();
    },
  };
}

function sameStatus(a: FeedStatus, b: FeedStatus): boolean {
  if (a.kind === 'none' || b.kind === 'none') return a.kind === b.kind && 'reason' in a && 'reason' in b && a.reason === b.reason;
  return a.kind === b.kind && a.state === b.state;
}

/** The shell's word for the engine's state: 'none' with the reason whenever there's no room to be in. */
function statusOf(snap: EngineSnapshot): FeedStatus {
  switch (snap.status) {
    case 'connected':
      return { kind: 'livekit', state: 'connected' };
    case 'disconnected':
      return snap.refusal === null ? { kind: 'livekit', state: 'closed' } : { kind: 'none', reason: snap.refusal };
    case 'error':
      return { kind: 'none', reason: snap.refusal ?? 'error' };
    default:
      // idle (before the first join), fetching-token, connecting and reconnecting.
      return { kind: 'livekit', state: 'connecting' };
  }
}

/** The connection as the panel names it, or null when there's no room (the status says why). */
function connectionOf(snap: EngineSnapshot): VoiceConnection | null {
  switch (snap.status) {
    case 'connected':
      return 'connected';
    case 'reconnecting':
      return 'reconnecting';
    case 'disconnected':
      return snap.refusal === null ? 'closed' : null;
    case 'error':
      return null;
    default:
      return 'connecting';
  }
}

/** Before the engine exists: still asking for a token, or refused one. */
function connectionBefore(status: FeedStatus): VoiceConnection | null {
  if (status.kind === 'none') return null;
  return status.state === 'closed' ? 'closed' : 'connecting';
}

function micOf(snap: EngineSnapshot): MicState {
  if (snap.micPending) return snap.micMuted ? 'stopping' : 'starting';
  return snap.micMuted ? 'off' : 'on';
}

const ROOM_SOUND: Record<EngineSnapshot['reverbStatus'], RoomSound> = {
  off: 'off',
  generating: 'rendering',
  loading: 'rendering',
  ready: 'live',
  failed: 'failed',
};

/** Speaking, and audible to us: in range, dry or send above 0, not muted by us, and us not deafened. */
function audiblySpeaking(snap: EngineSnapshot, peer: PeerSnapshot): boolean {
  return (
    peer.speaking &&
    peer.subscription === 'in-range' &&
    (peer.gain > 0 || peer.reverbSend > 0) &&
    !peer.localMuted &&
    !snap.deafened
  );
}

const to = (value: number, step: number): number => Math.round(value / step) * step;
/** To the nearest 0.02, as a value that prints cleanly. */
const hundredths = (value: number): number => Math.round(value * 50) / 50;

function voiceFrom(snap: EngineSnapshot): VoiceSnapshot {
  const connection = connectionOf(snap);
  const inRoom = connection === 'connected' || connection === 'reconnecting';
  const mic = inRoom ? micOf(snap) : 'off';
  const people: Person[] = snap.peers.map((peer) => {
    // What you hear of them now: the engine's gains apply to a voice that's
    // arriving, so someone out of range, or with their mic off, is 0.
    const hearing = peer.subscription === 'in-range' && !peer.noMic && !peer.micMuted;
    return {
      id: peer.identity,
      name: peer.name,
      distance: peer.distance === null ? null : to(peer.distance, 0.5),
      nearness: peer.distance === null ? 0 : hundredths(nearness(peer.distance)),
      direct: hearing ? hundredths(peer.gain) : 0,
      reverb: hearing ? hundredths(peer.reverbSend) : 0,
      cutoffHz: to(peer.cutoffHz, 100),
      occlusion: hundredths(peer.occlusion),
      reception: RECEPTION[peer.subscription],
      crowded: peer.capped,
      speaking: audiblySpeaking(snap, peer),
      micOn: !peer.noMic && !peer.micMuted,
      mutedByYou: peer.localMuted,
    };
  });
  return {
    available: inRoom,
    connection,
    mic,
    micProblem: snap.micProblem,
    deafened: snap.deafened,
    soundBlocked: inRoom && snap.playbackBlocked,
    roomSound: ROOM_SOUND[snap.reverbStatus],
    speaking: snap.localSpeaking && mic === 'on',
    people: sortPeople(people),
  };
}

/** Everything but the numbers that move as people walk (and their order, which follows them). */
function shapeOf(status: FeedStatus, voice: VoiceSnapshot): string {
  const { people, ...rest } = voice;
  const who = people
    .map((p) => [p.id, p.name, p.distance === null, p.reception, p.crowded, p.speaking, p.micOn, p.mutedByYou])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
  return JSON.stringify([status, rest, who]);
}

/** The numbers that move as people walk: at most five times a second. */
function numbersOf(voice: VoiceSnapshot): string {
  return JSON.stringify(voice.people.map((p) => [p.id, p.distance, p.nearness, p.direct, p.reverb, p.cutoffHz, p.occlusion]));
}

/** The room URL and token, or why there are none (the contract's `'none'` reasons). */
async function fetchGrant(): Promise<TokenResponse | Exclude<NoneReason, 'elsewhere' | 'failed'>> {
  let response: Response;
  try {
    response = await fetch(TOKEN_PATH, { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return 'error';
  }
  if (response.status === 401) return 'signed-out';
  if (response.status === 403) return 'practice';
  if (response.status === 503) return 'unavailable';
  if (response.status !== 200) return 'error';
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return 'error';
  }
  if (typeof body !== 'object' || body === null) return 'error';
  const { url, token } = body as Record<string, unknown>;
  if (typeof url !== 'string' || typeof token !== 'string' || url === '' || token === '') return 'error';
  return { url, token };
}
