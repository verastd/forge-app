/**
 * ProximityVoiceEngine
 *
 * Browser-side replica of the Fortnite Delulu / UEFN proximity chat model on
 * top of LiveKit, plus environmental acoustics:
 *
 *   1. One LiveKit room per match. Every player publishes a single Opus mic
 *      track (DTX on). autoSubscribe is OFF so nobody receives 79 streams.
 *   2. Positions are broadcast on a lossy data channel at positionHz. Swap the
 *      broadcast for your authoritative game-state feed by calling
 *      setPeerPosition() yourself and setting positionHz to 0.
 *   3. Every tick the engine computes distance to each peer, subscribes or
 *      unsubscribes with hysteresis, and drives a per-peer Web Audio chain:
 *
 *        source -> [HRTF panner] -> lowpass -> dry gain  -> master -> out
 *                                           -> wet send  -> reverb bus (shared convolver) -> return -> master
 *
 *      Dry gain follows the Unreal attenuation curve. Wet send fades slower,
 *      so far voices become mostly reverb. Lowpass tracks distance and
 *      occlusion.
 *   4. Speaking state, playback state, reverb load state and every pending
 *      transition are exposed in a snapshot so the UI can render real
 *      loading/pending states.
 *
 * Only ever import this from client code. The constructor touches no browser
 * APIs so it is safe to construct during SSR render; join() is where the
 * browser work starts.
 *
 * FORGE: a close port of Fable's voice drop 2 (lib/voice/engine.ts), so later
 * drops apply as diffs. Every change against it is marked "FORGE:" below and
 * logged, one line each, in the unit's PORT-NOTES. In short: FORGE's token
 * route and its refusals, no mic until the member asks for one (and off stops
 * the capture), FORGE's validated position packet and send policy, the
 * sender's own range check, a sound unlock on the first gesture, positions in
 * the listener's own frame, and a debug view in development builds only. The
 * review fixes (2026-10-04): one source node per received track for the whole
 * visit, sessions told apart by sid, removals from the permission list sent at
 * once, a dwell and a plausibility check against churn, a cap on the voices
 * received at once, one Room per engine, NaN guards, and speaking taken from
 * what is actually heard rather than from the SFU.
 * The lobby's presence feed (presence/livekitFeed.ts) is the only importer,
 * and only through `import()`, so `livekit-client` (imported statically here)
 * is downloaded only by a member's lobby that has been given a room token.
 */

import {
  ConnectionState,
  DisconnectReason,
  type LocalAudioTrack,
  LogLevel,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  type TrackPublication,
  setLogLevel,
} from 'livekit-client';

// FORGE: Fable's acoustics.ts and attenuation.ts live in @forge/lobby, pure
// and unit-tested, beside the lobby's own packet and the cave's settings.
import {
  lowpassCutoff,
  occlusionDryGain,
  occlusionWetGain,
  REVERB_PRESETS,
  type ReverbPreset,
  type ReverbStatus,
  reverbSendGain,
  synthesizeImpulseResponse,
} from '@forge/lobby';
import {
  type AttenuationCurve,
  clamp01,
  computeGain,
  distance,
  distanceAlpha,
  listenerSpace,
  shouldSubscribe,
  type Vec3,
} from '@forge/lobby';
import {
  acceptPacket,
  createPacketLimiter,
  decodePosition,
  encodePosition,
  forgetSender,
  hearSpeaking,
  liveVoices,
  pannerMoved,
  permitted,
  plausibleStep,
  retryDelay,
  sanitizeName,
  type SelfState,
  sendPolicy,
  type Speaking,
  VOICE,
  type VoiceCandidate,
  voiceConfigProblem,
} from '@forge/lobby';

import type { NoneReason } from '../presence/noneFeed';
import type { MicProblem } from '../presence/types';

export const POSITION_TOPIC = 'pos';

// FORGE: no 'requesting-mic' or 'mic-denied'. Members join to listen, so the
// mic has its own state (micMuted, micPending, micProblem), not the room's.
export type EngineStatus =
  | 'idle'
  | 'fetching-token'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export type SubscriptionState = 'out-of-range' | 'subscribing' | 'in-range' | 'unsubscribing';

export interface ProximityConfig {
  fullVolumeDistance: number;
  falloffDistance: number;
  curve: AttenuationCurve;
  /** Hysteresis band beyond falloffDistance, in world units. */
  subscribeMargin: number;
  /** Position broadcast + evaluation rate. 0 disables the broadcast (positions must be fed externally). */
  positionHz: number;
  /** HRTF panning via PannerNode. Off gives Epic's behavior (attenuation only). */
  spatialPanning: boolean;
  /** Drop a peer's position if we have not heard from them in this many ms. */
  positionStaleMs: number;
  /**
   * Gain floor in dB at falloffDistance for the 'natural' curve. Unreal's
   * default is -60, which is steep in linear gain terms. -30 is gentler.
   */
  naturalDbAtMax?: number;
  /** Shared reverb bus. 'none' bypasses the convolver entirely. */
  reverb: ReverbPreset;
  /** Wet level at full-volume distance, 0..1. Rises relative to dry with distance. */
  reverbWet: number;
  /** Roll off highs with distance (air absorption). Occlusion muffles regardless. */
  distanceMuffling: boolean;
}

export const DEFAULT_PROXIMITY_CONFIG: ProximityConfig = {
  fullVolumeDistance: 5,
  falloffDistance: 35,
  curve: 'natural',
  subscribeMargin: 5,
  positionHz: 10,
  spatialPanning: false,
  positionStaleMs: 3000,
  reverb: 'none',
  reverbWet: 0.3,
  distanceMuffling: true,
};

export interface PeerSnapshot {
  identity: string;
  name: string;
  // FORGE: positions carry the lobby's heading (SelfState), as its packet does.
  position: SelfState | null;
  distance: number | null;
  /** Dry (direct path) gain, 0..1. */
  gain: number;
  /** Wet (reverb send) gain, 0..1. */
  reverbSend: number;
  /** Lowpass cutoff currently applied, Hz. */
  cutoffHz: number;
  /** 0 = clear line of sight, 1 = fully blocked. Set via setPeerOcclusion. */
  occlusion: number;
  subscription: SubscriptionState;
  speaking: boolean;
  audioLevel: number;
  /** You muted them locally. */
  localMuted: boolean;
  /** They muted their own mic. */
  micMuted: boolean;
  /** They have not published a mic track yet. */
  noMic: boolean;
  lastSeenAt: number;
  /** FORGE: within reach, but past the cap on voices received at once. */
  capped: boolean;
}

export interface EngineSnapshot {
  status: EngineStatus;
  error: string | null;
  /** FORGE: why there is no room (the token route's answer, a join that failed here, or another tab took the seat), for the panel. */
  refusal: NoneReason | null;
  roomName: string | null;
  localIdentity: string | null;
  localSpeaking: boolean;
  micMuted: boolean;
  /** A mute/unmute is in flight. */
  micPending: boolean;
  /** FORGE: why the mic didn't start, the last time it was asked to. */
  micProblem: MicProblem;
  deafened: boolean;
  /** AudioContext is suspended; the browser wants a user gesture. */
  playbackBlocked: boolean;
  reverbStatus: ReverbStatus;
  reverbError: string | null;
  localPosition: SelfState;
  peers: PeerSnapshot[];
  config: ProximityConfig;
}

// FORGE: POST /api/lobby/token answers { url, token }; the identity is the
// room's (localParticipant.identity) once connected.
export interface TokenResponse {
  token: string;
  url: string;
}

/**
 * FORGE: resolves to the room's address and token, or to why there is none
 * (401 'signed-out', 403 'practice', 503 'unavailable', anything else
 * 'error'), so the panel can say why rather than only that it failed.
 */
export type TokenFetcher = (room: string) => Promise<TokenResponse | Exclude<NoneReason, 'elsewhere' | 'failed'>>;

interface PeerAudio {
  element: HTMLAudioElement;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  panner: PannerNode | null;
  filter: BiquadFilterNode;
  dry: GainNode;
  send: GainNode;
  // FORGE: the chain's own parts.
  /** The publication this chain plays: only its own TrackUnsubscribed tears it down. */
  trackSid: string;
  /** The cached source this chain starts from (one per received track, for the whole visit). */
  entry: SourceEntry;
  /** What you hear of them, after the dry gain and the reverb send: speaking is read from it. */
  heard: AnalyserNode;
  /** Where the panner was last aimed, in listener space; null until it is. */
  aimed: Vec3 | null;
}

interface PeerInternal {
  participant: RemoteParticipant;
  position: SelfState | null;
  lastSeenAt: number;
  subscription: SubscriptionState;
  gain: number;
  reverbSend: number;
  cutoffHz: number;
  occlusion: number;
  localMuted: boolean;
  audio: PeerAudio | null;
  // FORGE: state the port adds per peer.
  /** The session this record speaks for: a new sid is somebody joining again. */
  sid: string;
  /** When their position was last taken (performance.now()), for plausibleStep. */
  heardAt: number;
  /** When we last asked to subscribe or unsubscribe (performance.now()), for the dwell. */
  changedAt: number;
  /** Refused subscriptions in a row, the publication they were for, and when to ask again. */
  failures: number;
  failedSid: string | null;
  retryAt: number;
  /** Speaking, from what we hear of them (`heard`), and that level. */
  speaking: Speaking;
  level: number;
  /** Within reach but past the cap: someone nearer, or speaking, has the voice. */
  capped: boolean;
}

/**
 * FORGE: a received track's way into the graph, made once and kept: the
 * hidden `<audio>` Chrome needs, its stream, and the MediaStreamAudioSourceNode.
 * Chrome keeps every such node alive for as long as its context runs, so one
 * per subscription would leak a node each time someone crossed 40/45 m;
 * livekit-client hands back the same receiver track on a re-subscribe, so
 * this keys them by it.
 */
interface SourceEntry {
  element: HTMLAudioElement;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  /** The peer whose chain it feeds now, or null while idle. */
  owner: PeerInternal | null;
}

type Listener = (snapshot: EngineSnapshot) => void;

const CUTOFF_OPEN_HZ = 18000;

/** FORGE: the mic's capture, as Fable's createLocalAudioTrack asked for it. */
const MIC_CAPTURE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as const;
/** FORGE: how often, at most, the SFU hears a list that adds someone to who may receive our mic. */
const PERMISSION_INTERVAL_MS = 500;
/**
 * FORGE: the gestures that may start sound. Touch browsers don't count a
 * `pointerdown` as user activation, so it isn't one of them; `pointerup`,
 * `touchend` and `click` cover a tap, and `keydown` the keyboard.
 */
const UNLOCK_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'] as const;
/** FORGE: the mic meter, as the first lobby's: mean distance from silence (128) in a byte waveform, full scale at 20. */
const METER_FULL_SCALE = 20;
/** FORGE: samples the meter and each chain's `heard` analyser keep: about 46 and 93 ms at 44.1 kHz, long enough to catch a word. */
const METER_SAMPLES = 2048;
const HEARD_SAMPLES = 4096;
/**
 * FORGE: cached sources nobody is listening through before the context is
 * rebuilt (at a quiet moment), which lets Chrome free them all.
 */
const IDLE_SOURCE_LIMIT = 32;
/** FORGE: a coarse pointer (a phone or a tablet) gets the smaller cap on voices. */
const COARSE_QUERY = '(pointer: coarse)';
/** FORGE: the development build's debug view, on `window`. */
const DEBUG_GLOBAL = '__forgeVoice';

const QUIET: Speaking = Object.freeze({ speaking: false, quietSince: null }) as Speaking;

interface Meter {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Uint8Array;
  trackId: string;
}

export class ProximityVoiceEngine {
  private config: ProximityConfig;
  private readonly fetchToken: TokenFetcher;

  private room: Room | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverbBus: ConvolverNode | null = null;
  private reverbReturn: GainNode | null = null;
  private localTrack: LocalAudioTrack | null = null;

  private readonly peers = new Map<string, PeerInternal>();
  private readonly listeners = new Set<Listener>();

  private status: EngineStatus = 'idle';
  private error: string | null = null;
  private roomName: string | null = null;
  private localIdentity: string | null = null;
  private localPosition: SelfState = { x: 0, y: 0, z: 0, yaw: 0 };
  // FORGE: members join to listen, so the mic starts off.
  private micMuted = true;
  private micPending = false;
  private deafened = false;
  private playbackBlocked = false;
  private reverbStatus: ReverbStatus = 'off';
  private reverbError: string | null = null;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private joinSeq = 0;
  private reverbSeq = 0;

  // FORGE: state the port adds.
  private refusal: NoneReason | null = null;
  private micProblem: MicProblem = null;
  /** The room whose connect() resolved: one that drops before that never joined. */
  private joined: Room | null = null;
  /** Whether the scene has said where we are yet. */
  private localKnown = false;
  private lastSent: SelfState | null = null;
  private lastSentAt = 0;
  private limiter = createPacketLimiter();
  /** Who you muted, by identity, so a muted peer stays muted when they rejoin. */
  private readonly mutedIdentities = new Set<string>();
  /** Who the SFU was last told may receive our mic, and when it last heard of an addition. */
  private permittedList: string[] = [];
  private permittedAt = Number.NEGATIVE_INFINITY;
  private meter: Meter | null = null;
  private unlockListening = false;
  private masterTap: AnalyserNode | null = null;
  private reverbTap: AnalyserNode | null = null;
  private debugView: object | null = null;
  /** The latest setMicMuted call: only it may settle micPending. */
  private micCall = 0;
  /** This engine's Room, kept between joins: livekit-client 2.22.3 lets a Room connect() again once disconnected. */
  private spare: Room | null = null;
  /** A room whose connect() hasn't settled: a rejoin can't reuse it (connect() would hand back that same promise). */
  private connecting: Room | null = null;
  private roomsMade = 0;
  private sources = new WeakMap<MediaStreamTrack, SourceEntry>();
  private readonly idleSources = new Set<SourceEntry>();
  private sourcesMade = 0;
  private rebuildWanted = false;
  private rebuilds = 0;
  private localSpeaking: Speaking = QUIET;
  private coarse: MediaQueryList | null = null;
  private readonly samples = new Float32Array(HEARD_SAMPLES);
  /** Packets dropped as steps no camera could take, for the debug view. */
  private implausible = 0;

  constructor(config: Partial<ProximityConfig>, fetchToken: TokenFetcher) {
    this.config = { ...DEFAULT_PROXIMITY_CONFIG, ...config };
    this.fetchToken = fetchToken;
    // FORGE: livekit-client logs warnings and errors only.
    setLogLevel(LogLevel.warn);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): EngineSnapshot {
    const peers: PeerSnapshot[] = [];
    for (const [identity, p] of this.peers) {
      // FORGE: no distance until the scene has said where we are.
      const d = this.distanceTo(p);
      const pub = this.micPublication(p.participant);
      peers.push({
        identity,
        // FORGE: the name our token route signed, sanitised again; never anything a packet says.
        name: sanitizeName(p.participant.name),
        position: p.position,
        distance: d,
        gain: p.gain,
        reverbSend: p.reverbSend,
        cutoffHz: p.cutoffHz,
        occlusion: p.occlusion,
        subscription: p.subscription,
        // FORGE: what we hear of them (`heard`), not the SFU's word.
        speaking: p.speaking.speaking,
        audioLevel: p.level,
        localMuted: p.localMuted,
        micMuted: pub?.isMuted ?? false,
        noMic: !pub,
        lastSeenAt: p.lastSeenAt,
        capped: p.capped,
      });
    }
    peers.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    return {
      status: this.status,
      error: this.error,
      refusal: this.refusal,
      roomName: this.roomName,
      localIdentity: this.localIdentity,
      // FORGE: from our own mic meter, not the SFU's speaker updates.
      localSpeaking: this.localSpeaking.speaking && !this.micMuted,
      micMuted: this.micMuted,
      micPending: this.micPending,
      micProblem: this.micProblem,
      deafened: this.deafened,
      playbackBlocked: this.playbackBlocked,
      reverbStatus: this.reverbStatus,
      reverbError: this.reverbError,
      // FORGE: a copy, since the scene's frames update ours in place.
      localPosition: { ...this.localPosition },
      peers,
      config: this.config,
    };
  }

  // FORGE: refused whole (and false) if it would put a NaN, a negative margin
  // or an inverted range into the gains, which would throw in every tick.
  updateConfig(patch: Partial<ProximityConfig>): boolean {
    const prev = this.config;
    const next = { ...prev, ...patch };
    if (voiceConfigProblem(next) !== null) return false;
    this.config = next;
    const cfg = this.config;

    if (cfg.positionHz !== prev.positionHz && this.room) this.startTick();

    if (cfg.spatialPanning !== prev.spatialPanning) {
      // Rebuild audio graphs so the panner is added/removed.
      for (const p of this.peers.values()) {
        if (p.audio) {
          const track = this.micPublication(p.participant)?.track as RemoteTrack | undefined;
          this.teardownPeerAudio(p);
          if (track) this.buildPeerAudio(p, track);
        }
      }
    }

    if (cfg.reverb !== prev.reverb) {
      void this.loadReverb();
    }

    this.evaluate();
    return true;
  }

  // FORGE: a SelfState, since the listener's heading orients the panner; and
  // copied into our own object, since the scene calls this every frame.
  setLocalPosition(v: SelfState): void {
    const local = this.localPosition;
    local.x = v.x;
    local.y = v.y;
    local.z = v.z;
    local.yaw = v.yaw;
    this.localKnown = true;
    if (this.config.positionHz === 0) this.evaluate();
  }

  /** Feed a peer position from an authoritative source instead of the data channel. */
  setPeerPosition(identity: string, v: SelfState): void {
    const p = this.peers.get(identity);
    if (!p) return;
    p.position = { x: v.x, y: v.y, z: v.z, yaw: v.yaw };
    p.lastSeenAt = Date.now();
    if (this.config.positionHz === 0) this.evaluate();
  }

  /**
   * 0 = clear line of sight, 1 = fully blocked. Drive this from a raycast in
   * your scene (listener -> speaker). Muffles and cuts the direct path; the
   * reverb mostly survives, like sound bending around a corner.
   */
  setPeerOcclusion(identity: string, occlusion: number): void {
    const p = this.peers.get(identity);
    if (!p) return;
    p.occlusion = clamp01(occlusion);
    if (this.config.positionHz === 0) this.evaluate();
  }

  async join(roomName: string): Promise<void> {
    if (this.room) await this.leave();
    const seq = ++this.joinSeq;
    this.error = null;
    this.refusal = null;
    this.roomName = roomName;
    // FORGE: development builds only; next build compiles it out.
    if (process.env.NODE_ENV !== 'production') this.installDebugView();

    // 1. FORGE: no microphone at join. Members join to listen; setMicMuted(false)
    // captures and publishes it the first time, inside the click that asks for it.

    // 2. Token from our own backend (trusted-server flow).
    this.setStatus('fetching-token');
    let creds: TokenResponse;
    try {
      const answer = await this.fetchToken(roomName);
      if (seq !== this.joinSeq) return;
      // FORGE: the route said why there's no token, and the panel says it on.
      if (typeof answer === 'string') {
        this.refusal = answer;
        this.setStatus('error');
        return;
      }
      creds = answer;
    } catch (e) {
      if (seq !== this.joinSeq) return;
      this.error = describeError(e, 'Could not fetch a voice token');
      this.refusal = 'error';
      this.setStatus('error');
      return;
    }

    // 3. Audio output graph. Created inside the user gesture so it starts running.
    // FORGE: there's no gesture at join (the lobby joins on load), so it may
    // start suspended: the panel's "Turn on sound" and the first tap or key
    // anywhere resume it. And a browser that won't make one (older iOS caps
    // how many a page may hold) is a join that failed here, not an exception.
    try {
      this.ensureAudioContext();
    } catch (e) {
      this.error = describeError(e, 'Could not start audio');
      this.refusal = 'failed';
      this.setStatus('error');
      return;
    }

    // 4. Connect with autoSubscribe off. We decide who we hear.
    this.setStatus('connecting');
    const room = this.roomForJoin();
    this.room = room;
    this.bindRoomEvents(room);
    // FORGE: nobody may receive our mic until we know where they are. Set
    // before connecting, this is only stored, and livekit-client's own first
    // send of the permissions (when its engine connects) carries it, rather
    // than its default of everyone.
    room.localParticipant.setTrackSubscriptionPermissions(false, []);
    this.permittedList = [];

    this.connecting = room;
    try {
      await room.connect(creds.url, creds.token, { autoSubscribe: false });
    } catch (e) {
      if (this.connecting === room) this.connecting = null;
      // FORGE: a Disconnected event already said why (or a leave() overtook
      // the join), and a failed join ends in 'error', not Fable's leave() to
      // 'idle', which would lose the reason the panel shows. It failed here,
      // in this browser: the token route had answered.
      if (this.room !== room) return;
      this.error = describeError(e, 'Could not connect to the voice server');
      this.refusal = 'failed';
      this.dropRoom(room);
      this.setStatus('error');
      return;
    }
    if (this.connecting === room) this.connecting = null;
    if (seq !== this.joinSeq || this.room !== room) {
      // FORGE: overtaken (a leave, or a rejoin after this room was evicted)
      // while LiveKit was still connecting it: let go of it here too.
      if (this.room !== room) {
        room.removeAllListeners();
        void room.disconnect().catch(() => undefined);
      }
      return;
    }

    // FORGE: who we are is the room's word, from the token our route signed.
    this.localIdentity = room.localParticipant.identity;
    this.joined = room;
    for (const rp of room.remoteParticipants.values()) this.addPeer(rp);
    // FORGE: the list fills as positions arrive (updatePermissions).
    this.updatePermissions(room, performance.now());
    this.refreshMic(room);
    this.setStatus('connected');
    this.startTick();
  }

  async leave(): Promise<void> {
    this.joinSeq++;
    this.reverbSeq++;
    this.stopTick();
    const room = this.room;
    this.room = null;
    this.joined = null;
    for (const p of this.peers.values()) this.teardownPeerAudio(p);
    this.peers.clear();
    if (room) {
      try {
        await room.disconnect();
      } catch {
        /* already gone */
      }
      // FORGE: a Room nobody listens to any more holds nothing of ours
      // (livekit-client keeps every Room it made reachable: its devicechange
      // listener).
      room.removeAllListeners();
    }
    this.stopLocalTrack();
    // FORGE: the gesture listeners and the debug view go with the engine.
    this.listenForUnlock(false);
    this.uninstallDebugView();
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      this.master = null;
      this.reverbBus = null;
      this.reverbReturn = null;
      this.masterTap = null;
      this.reverbTap = null;
      this.forgetSources();
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.playbackBlocked = false;
    this.reverbStatus = 'off';
    this.reverbError = null;
    this.roomName = null;
    this.localIdentity = null;
    this.setStatus('idle');
  }

  async setMicMuted(muted: boolean): Promise<void> {
    if (this.micPending) return;
    const room = this.room;
    // FORGE: the mic belongs to the room, so outside one there is none to change.
    if (!room || (this.status !== 'connected' && this.status !== 'reconnecting')) {
      this.emit();
      return;
    }
    // FORGE: this call's own token: an older call that settles late (its room
    // gone, or a newer call made since) leaves micPending and the problem alone.
    const call = ++this.micCall;
    this.micMuted = muted;
    if (!muted) this.micProblem = null;
    this.micPending = true;
    this.emit();
    try {
      // FORGE: the first "on" captures and publishes the mic (this click is the
      // gesture its permission prompt needs) and later ones unmute it; "off"
      // mutes it, which stopMicTrackOnMute turns into stopping the capture.
      await room.localParticipant.setMicrophoneEnabled(!muted, MIC_CAPTURE);
    } catch (e) {
      if (call === this.micCall) {
        this.error = describeError(e, 'Mute toggle failed');
        if (!muted) this.micProblem = micProblemFor(e);
      }
    } finally {
      // FORGE: the button shows what the room says, whatever was asked.
      if (call === this.micCall && this.room === room) {
        this.micPending = false;
        this.refreshMic(room);
      }
      this.emit();
    }
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(deafened ? 0 : 1, this.ctx.currentTime, 0.02);
    }
    this.emit();
  }

  setPeerLocalMuted(identity: string, muted: boolean): void {
    // FORGE: remembered by identity, so someone you muted stays muted when they rejoin.
    if (muted) this.mutedIdentities.add(identity);
    else this.mutedIdentities.delete(identity);
    const p = this.peers.get(identity);
    if (!p) return;
    p.localMuted = muted;
    this.evaluate();
  }

  /** Call from a click handler if snapshot.playbackBlocked is true. */
  async resumeAudio(): Promise<void> {
    // FORGE: the context is read once, since leave() can close it while this waits.
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      await ctx.resume();
    } catch (e) {
      this.error = describeError(e, 'Audio could not be resumed');
    }
    if (this.ctx !== ctx) return;
    this.playbackBlocked = ctx.state !== 'running';
    this.listenForUnlock(this.playbackBlocked);
    this.emit();
  }

  /** Re-run the reverb load (for example after a failed custom IR fetch). */
  reloadReverb(): void {
    void this.loadReverb();
  }

  /** FORGE: the local mic's level, 0..1, for the button's meter; 0 while it's off. */
  micLevel(): number {
    const meter = this.liveMeter();
    if (!meter) return 0;
    meter.analyser.getByteTimeDomainData(meter.samples);
    let sum = 0;
    for (const sample of meter.samples) sum += Math.abs(sample - 128);
    return Math.min(1, sum / meter.samples.length / METER_FULL_SCALE);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private setStatus(s: EngineStatus): void {
    this.status = s;
    this.emit();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snap = this.getSnapshot();
    for (const l of this.listeners) l(snap);
  }

  private stopLocalTrack(): void {
    // FORGE: the room owns the mic it published; this only lets go of it (and
    // stops it, if the room hasn't already).
    this.unbindMeter();
    if (this.localTrack) {
      this.localTrack.stop();
      this.localTrack = null;
    }
  }

  private ensureAudioContext(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();

    const master = ctx.createGain();
    master.gain.value = this.deafened ? 0 : 1;
    master.connect(ctx.destination);

    // Shared reverb bus: every peer's wet send lands here.
    const reverbBus = ctx.createConvolver();
    reverbBus.normalize = true;
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 1;
    reverbBus.connect(reverbReturn);
    reverbReturn.connect(master);

    ctx.addEventListener('statechange', () => {
      // FORGE: a context that leave() closed, or a rebuild replaced, says nothing more.
      if (this.ctx !== ctx || ctx.state === 'closed') return;
      this.playbackBlocked = ctx.state !== 'running';
      // FORGE: iOS can suspend it again (a call, Siri), and then the next gesture resumes it.
      this.listenForUnlock(this.playbackBlocked);
      this.emit();
    });

    this.ctx = ctx;
    this.master = master;
    this.reverbBus = reverbBus;
    this.reverbReturn = reverbReturn;
    this.playbackBlocked = ctx.state !== 'running';
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {
        /* UI will show the enable-audio button */
      });
      // FORGE: and the first tap or key anywhere tries again.
      this.listenForUnlock(true);
    }

    void this.loadReverb();
  }

  private async loadReverb(): Promise<void> {
    const ctx = this.ctx;
    const bus = this.reverbBus;
    if (!ctx || !bus) return;

    const seq = ++this.reverbSeq;
    this.reverbError = null;

    const preset = this.config.reverb;
    if (preset === 'none') {
      bus.buffer = null;
      this.reverbStatus = 'off';
      this.emit();
      return;
    }

    try {
      // FORGE: no 'custom' preset and no IR fetch: the impulse response is always synthesized.
      this.reverbStatus = 'generating';
      this.emit();
      // Yield once so the spinner paints before the synchronous render.
      await new Promise<void>((r) => setTimeout(r, 0));
      if (seq !== this.reverbSeq || this.ctx !== ctx) return;
      // FORGE: rendered by the pure synthesizer, then copied into an AudioBuffer.
      const [left, right] = synthesizeImpulseResponse(ctx.sampleRate, REVERB_PRESETS[preset]);
      const ir = ctx.createBuffer(2, left.length, ctx.sampleRate);
      ir.copyToChannel(left, 0);
      ir.copyToChannel(right, 1);
      bus.buffer = ir;
      this.reverbStatus = 'ready';
    } catch (e) {
      if (seq !== this.reverbSeq || this.ctx !== ctx) return;
      bus.buffer = null;
      this.reverbStatus = 'failed';
      this.reverbError = describeError(e, 'Reverb could not be loaded');
    }
    this.emit();
  }

  private bindRoomEvents(room: Room): void {
    // FORGE: a room this engine has let go of says nothing more.
    const live = (): boolean => this.room === room;
    room
      .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        if (!live()) return;
        if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) {
          this.setStatus('reconnecting');
        } else if (state === ConnectionState.Connected && this.status === 'reconnecting') {
          this.setStatus('connected');
        }
      })
      .on(RoomEvent.Reconnecting, () => {
        if (!live()) return;
        // FORGE: a full reconnect: livekit-client sends the stored permissions
        // again when it signals back in, before anyone's position is known
        // again. Stored as "nobody", that is what it sends.
        this.clearPermissions(room);
      })
      .on(RoomEvent.Reconnected, () => {
        if (!live()) return;
        // FORGE: the mic is as the room has it (a reconnect never forces it off),
        // and our position goes out again on the next tick.
        this.lastSent = null;
        this.refreshMic(room);
        this.emit();
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (!live()) return;
        this.error = reason !== undefined ? `Disconnected (${String(reason)})` : 'Disconnected';
        // FORGE: why, as the member sees it. Another tab or device took the
        // seat (one identity, one seat); a room that never finished joining is
        // a join that failed here; anything else closed the room.
        const elsewhere = reason === DisconnectReason.DUPLICATE_IDENTITY;
        const failedJoin = this.joined !== room;
        this.stopTick();
        for (const p of this.peers.values()) this.teardownPeerAudio(p);
        this.peers.clear();
        this.room = null;
        this.joined = null;
        this.stopLocalTrack();
        this.resetRoomState();
        if (elsewhere) {
          this.refusal = 'elsewhere';
          this.setStatus('disconnected');
        } else if (failedJoin) {
          this.refusal = 'failed';
          this.setStatus('error');
        } else {
          this.setStatus('disconnected');
        }
        // FORGE: and the room holds nothing of ours until the next join binds it again.
        room.removeAllListeners();
      })
      .on(RoomEvent.ParticipantConnected, (rp: RemoteParticipant) => {
        if (!live()) return;
        this.addPeer(rp);
        // FORGE: somebody new, so our position goes out on the next tick, not at the next heartbeat.
        this.lastSent = null;
        this.emit();
      })
      .on(RoomEvent.ParticipantDisconnected, (rp: RemoteParticipant) => {
        if (!live()) return;
        const p = this.peers.get(rp.identity);
        // FORGE: only the record that left; a rejoin may already have replaced it.
        if (p && p.participant !== rp) return;
        if (p) this.teardownPeerAudio(p);
        this.peers.delete(rp.identity);
        forgetSender(this.limiter, rp.identity);
        // FORGE: and they leave the list of who may receive our mic at once.
        this.updatePermissions(room, performance.now());
        this.emit();
      })
      .on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, rp: RemoteParticipant) => {
        if (!live()) return;
        const p = this.addPeer(rp);
        this.checkSession(p);
        // FORGE: a new mic starts the refusals' backoff over.
        if (pub.source === Track.Source.Microphone && pub.trackSid !== p.failedSid) {
          p.failures = 0;
          p.failedSid = null;
          p.retryAt = 0;
        }
        this.evaluate();
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, rp: RemoteParticipant) => {
        if (!live()) return;
        if (track.kind !== Track.Kind.Audio || pub.source !== Track.Source.Microphone || !known(room, rp)) {
          // FORGE: only a microphone plays, from someone the room knows; anything else goes straight back.
          pub.setSubscribed(false);
          return;
        }
        const p = this.addPeer(rp);
        this.checkSession(p);
        this.buildPeerAudio(p, track);
        p.subscription = 'in-range';
        p.failures = 0;
        p.failedSid = null;
        p.retryAt = 0;
        this.evaluate();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, rp: RemoteParticipant) => {
        if (!live()) return;
        if (track.kind !== Track.Kind.Audio) return;
        const p = this.peers.get(rp.identity);
        if (!p) return;
        // FORGE: only the publication this peer's chain plays ends it (a
        // refused track that was briefly subscribed is not their mic).
        if (p.audio && p.audio.trackSid !== pub.trackSid) return;
        this.teardownPeerAudio(p);
        p.subscription = 'out-of-range';
        this.emit();
      })
      .on(RoomEvent.TrackSubscriptionFailed, (trackSid: string, rp: RemoteParticipant) => {
        if (!live()) return;
        const p = this.peers.get(rp.identity);
        if (!p) return;
        p.subscription = 'out-of-range';
        // FORGE: and not again for a while: 1 s, doubling to 30 s, until a new mic.
        p.failures = p.failedSid === trackSid ? p.failures + 1 : 1;
        p.failedSid = trackSid;
        p.retryAt = performance.now() + retryDelay(p.failures);
        this.emit();
      })
      // FORGE: our own mic's mutes and publications refresh the button too.
      .on(RoomEvent.TrackMuted, (_pub: TrackPublication, participant: Participant) => {
        if (!live()) return;
        if (participant.isLocal) this.refreshMic(room);
        this.emit();
      })
      .on(RoomEvent.TrackUnmuted, (_pub: TrackPublication, participant: Participant) => {
        if (!live()) return;
        if (participant.isLocal) this.refreshMic(room);
        this.emit();
      })
      .on(RoomEvent.LocalTrackPublished, () => {
        if (!live()) return;
        this.refreshMic(room);
        this.emit();
      })
      .on(RoomEvent.LocalTrackUnpublished, () => {
        if (!live()) return;
        this.refreshMic(room);
        this.emit();
      })
      // FORGE: no ActiveSpeakersChanged. Speaking is what we hear of someone
      // (the tick's `listen`), never the SFU's room-wide speaker updates.
      .on(RoomEvent.DataReceived, (payload: Uint8Array, rp?: RemoteParticipant, _kind?: unknown, topic?: string) => {
        if (!live()) return;
        if (topic !== POSITION_TOPIC || !rp) return;
        // FORGE: from a participant the room knows, within their rate limit,
        // and FORGE's 9-byte packet, which refuses any place no camera can be.
        if (!known(room, rp) || !acceptPacket(this.limiter, rp.identity, performance.now())) return;
        const v = decodePosition(payload);
        if (!v) return;
        const p = this.addPeer(rp);
        this.checkSession(p);
        // FORGE: and nowhere a camera couldn't have got to since their last
        // packet (a session's first is taken as it comes).
        const at = performance.now();
        if (!plausibleStep(p.position, p.heardAt, v, at)) {
          this.implausible += 1;
          return;
        }
        p.position = v;
        p.heardAt = at;
        p.lastSeenAt = Date.now();
      });
  }

  private addPeer(rp: RemoteParticipant): PeerInternal {
    let p = this.peers.get(rp.identity);
    if (!p) {
      p = {
        participant: rp,
        position: null,
        lastSeenAt: 0,
        subscription: 'out-of-range',
        gain: 0,
        reverbSend: 0,
        cutoffHz: CUTOFF_OPEN_HZ,
        occlusion: 0,
        // FORGE: muted by you before, muted again.
        localMuted: this.mutedIdentities.has(rp.identity),
        audio: null,
        sid: rp.sid,
        heardAt: 0,
        changedAt: Number.NEGATIVE_INFINITY,
        failures: 0,
        failedSid: null,
        retryAt: 0,
        speaking: QUIET,
        level: 0,
        capped: false,
      };
      this.peers.set(rp.identity, p);
    } else if (p.participant !== rp) {
      // FORGE: a full reconnect can hand us a new record for the same identity.
      p.participant = rp;
      this.checkSession(p);
    }
    return p;
  }

  private micPublication(rp: RemoteParticipant): RemoteTrackPublication | undefined {
    const pub = rp.getTrackPublication(Track.Source.Microphone);
    // FORGE: a microphone of kind audio is the only thing ever subscribed.
    return pub?.kind === Track.Kind.Audio ? pub : undefined;
  }

  private buildPeerAudio(p: PeerInternal, track: RemoteTrack): void {
    const ctx = this.ctx;
    const master = this.master;
    const reverbBus = this.reverbBus;
    if (!ctx || !master || !reverbBus) return;
    if (p.audio) this.teardownPeerAudio(p);

    // FORGE: one element, stream and source per received track, made the
    // first time and found again on every re-subscribe (SourceEntry).
    const receiver = track.mediaStreamTrack;
    let entry = this.sources.get(receiver);
    if (entry?.owner && entry.owner !== p) this.teardownPeerAudio(entry.owner);
    if (!entry) {
      const stream = new MediaStream([receiver]);

      // Chrome will not push remote WebRTC audio into a Web Audio graph unless the
      // stream is also bound to a media element. Keep it muted; the graph is what
      // actually plays.
      const element = document.createElement('audio');
      element.srcObject = stream;
      element.muted = true;
      element.autoplay = true;
      element.setAttribute('playsinline', 'true');
      // FORGE: marked, so a test or a person debugging can find the lobby's voices.
      element.setAttribute('data-lobby-voice', '');
      element.style.display = 'none';

      const source = ctx.createMediaStreamSource(stream);
      entry = { element, stream, source, owner: null };
      this.sources.set(receiver, entry);
      this.sourcesMade += 1;
    } else {
      this.idleSources.delete(entry);
    }
    entry.owner = p;
    const { element, stream, source } = entry;
    document.body.appendChild(element);
    element.play().catch(() => {
      /* muted autoplay is permitted; ignore */
    });

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    filter.frequency.value = p.cutoffHz;

    const dry = ctx.createGain();
    dry.gain.value = 0;

    const send = ctx.createGain();
    send.gain.value = 0;

    let panner: PannerNode | null = null;
    if (this.config.spatialPanning) {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      // We own distance attenuation; neutralise the panner's.
      panner.distanceModel = 'linear';
      panner.refDistance = 1;
      panner.maxDistance = 1e9;
      panner.rolloffFactor = 0;
      source.connect(panner);
      panner.connect(filter);
    } else {
      source.connect(filter);
    }

    filter.connect(dry);
    filter.connect(send);
    dry.connect(master);
    send.connect(reverbBus);

    // FORGE: what we hear of them, direct and sent to the cave: speaking is read here.
    const heard = ctx.createAnalyser();
    heard.fftSize = HEARD_SAMPLES;
    dry.connect(heard);
    send.connect(heard);

    p.audio = { element, stream, source, panner, filter, dry, send, trackSid: track.sid ?? '', entry, heard, aimed: null };
  }

  private teardownPeerAudio(p: PeerInternal): void {
    const a = p.audio;
    if (!a) return;
    try {
      // FORGE: the source itself is kept (SourceEntry): only what comes after it goes.
      a.source.disconnect();
      a.panner?.disconnect();
      a.filter.disconnect();
      a.dry.disconnect();
      a.send.disconnect();
      a.heard.disconnect();
    } catch {
      /* ignore */
    }
    a.element.pause();
    a.element.remove();
    a.entry.owner = null;
    this.idleSources.add(a.entry);
    // FORGE: too many kept for tracks nobody plays: start afresh when it's quiet.
    if (this.idleSources.size > IDLE_SOURCE_LIMIT) this.rebuildWanted = true;
    p.audio = null;
    p.speaking = QUIET;
    p.level = 0;
  }

  private startTick(): void {
    this.stopTick();
    if (this.config.positionHz <= 0) return;
    const ms = Math.max(20, Math.round(1000 / this.config.positionHz));
    this.tickTimer = setInterval(() => this.tick(), ms);
  }

  private stopTick(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick(): void {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    const now = performance.now();
    // FORGE: who may receive our mic comes first, so nothing below can hold it
    // back; a record now speaking for a new session is dealt with before that.
    for (const p of this.peers.values()) this.checkSession(p);
    this.updatePermissions(room, now);
    // FORGE: FORGE's packet under its send policy, not a packet every tick: at
    // most ten a second while moving, and a heartbeat every second, which a
    // hidden tab keeps sending because this runs on a timer.
    if (this.localKnown && sendPolicy(this.lastSent, this.lastSentAt, now, this.localPosition)) {
      this.lastSent = { ...this.localPosition };
      this.lastSentAt = now;
      room.localParticipant
        .publishData(encodePosition(this.lastSent), { reliable: false, topic: POSITION_TOPIC })
        .catch(() => {
          /* lossy; next tick resends */
        });
    }
    this.listen(now);
    // FORGE: whatever goes wrong in one evaluation, the next tick comes.
    try {
      this.evaluate();
    } catch (e) {
      this.error = describeError(e, 'Voice evaluation failed');
    }
    if (this.rebuildWanted && !this.anyoneSpeaking()) this.rebuildAudio();
  }

  /** Re-run distance, subscription, gain, reverb send and filter for every peer. */
  private evaluate(): void {
    const now = Date.now();
    // FORGE: the dwell and the backoff run on the monotonic clock.
    const mono = performance.now();
    const cfg = this.config;
    const reverbActive = cfg.reverb !== 'none' && this.reverbStatus === 'ready';

    // FORGE: first, who is within reach, so the cap can pick from them.
    const reach = new Set<string>();
    const candidates: VoiceCandidate[] = [];
    for (const [identity, p] of this.peers) {
      if (p.position && now - p.lastSeenAt > cfg.positionStaleMs) p.position = null;
      const d = this.distanceTo(p);
      const subscribed = p.subscription === 'in-range' || p.subscription === 'subscribing';
      if (this.micPublication(p.participant) && shouldSubscribe(d, cfg, cfg.subscribeMargin, subscribed) && d !== null) {
        reach.add(identity);
        candidates.push({ id: identity, distance: d, speaking: p.speaking.speaking });
      }
    }
    // FORGE: the nearest few and anyone heard speaking, no more (VOICE's cap).
    const live = liveVoices(candidates, this.voiceCap());

    for (const [identity, p] of this.peers) {
      // FORGE: until the scene says where we are, every distance is unknown.
      const d = this.distanceTo(p);
      const pub = this.micPublication(p.participant);
      p.capped = reach.has(identity) && !live.has(identity);

      if (pub) {
        const want = live.has(identity);
        // FORGE: a voice taken or let go stays so for VOICE.dwellMs, and a
        // refused one waits out its backoff.
        const settled = mono - p.changedAt >= VOICE.dwellMs;
        if (want && p.subscription === 'out-of-range') {
          if (settled && mono >= p.retryAt) {
            p.subscription = 'subscribing';
            p.changedAt = mono;
            pub.setSubscribed(true);
          }
        } else if (!want && p.subscription === 'in-range') {
          if (settled) {
            p.subscription = 'unsubscribing';
            p.changedAt = mono;
            pub.setSubscribed(false);
          }
        } else if (!want && p.subscription === 'subscribing' && !pub.isSubscribed) {
          // FORGE: a request the sender never granted (their own range check
          // refuses it) is withdrawn once they're out of range, rather than
          // left waiting with the row reading "tuning in".
          if (settled) {
            p.subscription = 'out-of-range';
            p.changedAt = mono;
            pub.setSubscribed(false);
          }
        }
      } else if (p.subscription !== 'out-of-range' && !p.audio) {
        // FORGE: their mic went away before it ever arrived.
        p.subscription = 'out-of-range';
      }

      const silent = p.localMuted || d === null;
      const alpha = d === null ? 1 : distanceAlpha(d, cfg.fullVolumeDistance, cfg.falloffDistance);

      p.gain = silent ? 0 : computeGain(d, cfg) * occlusionDryGain(p.occlusion);
      p.reverbSend = silent || !reverbActive ? 0 : reverbSendGain(alpha, cfg.reverbWet) * occlusionWetGain(p.occlusion);
      p.cutoffHz = lowpassCutoff(alpha, p.occlusion, cfg.distanceMuffling);

      if (p.audio && this.ctx) {
        const t = this.ctx.currentTime;
        p.audio.dry.gain.setTargetAtTime(p.gain, t, 0.03);
        p.audio.send.gain.setTargetAtTime(p.reverbSend, t, 0.05);
        p.audio.filter.frequency.setTargetAtTime(p.cutoffHz, t, 0.05);
        if (p.audio.panner && p.position) {
          // FORGE: in the listener's own frame, since the cave has a heading;
          // and only once they've moved enough to hear (VOICE's panner step),
          // since every move makes the browser cross-fade its HRTFs.
          const target = listenerSpace(this.localPosition, p.position);
          if (pannerMoved(p.audio.aimed, target)) {
            placePanner(p.audio.panner, target, t);
            p.audio.aimed = target;
          }
        }
      }
    }
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // FORGE: internals the port adds
  // ---------------------------------------------------------------------------

  /** How far a peer is, or null while either position is unknown (or not a number). */
  private distanceTo(p: PeerInternal): number | null {
    if (!p.position || !this.localKnown) return null;
    const d = distance(this.localPosition, p.position);
    return Number.isFinite(d) ? d : null;
  }

  /** The most voices received at once: fewer on a phone or a tablet. */
  private voiceCap(): number {
    if (this.coarse === null && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.coarse = window.matchMedia(COARSE_QUERY);
    }
    return this.coarse?.matches ? VOICE.maxVoicesCoarse : VOICE.maxVoicesFine;
  }

  /**
   * A record whose sid changed speaks for a new session of that identity
   * (they joined again, and the room kept the record): nothing of the old
   * session carries over. No position, so they leave the permission list at
   * once and get back on it only once they say where they are; no audio; the
   * limiter, the dwell and the backoff start over; and our position goes out
   * to them on the next tick.
   */
  private checkSession(p: PeerInternal): void {
    if (p.participant.sid === p.sid) return;
    p.sid = p.participant.sid;
    p.position = null;
    p.heardAt = 0;
    p.lastSeenAt = 0;
    this.teardownPeerAudio(p);
    p.subscription = 'out-of-range';
    p.changedAt = Number.NEGATIVE_INFINITY;
    p.failures = 0;
    p.failedSid = null;
    p.retryAt = 0;
    p.capped = false;
    forgetSender(this.limiter, p.participant.identity);
    this.lastSent = null;
    if (this.room) this.updatePermissions(this.room, performance.now());
  }

  /**
   * The sender's own range check: tells the SFU that only participants whose
   * last known position is within VOICE.permitRange may receive our mic,
   * whatever their own client asks for. Nobody without a position is on it,
   * and nobody at all before the scene says where we are. A list that only
   * takes people off goes out at once; one that adds someone, at most every
   * PERMISSION_INTERVAL_MS (meanwhile its removals go out alone).
   * livekit-client sends it again itself after a reconnect. A listener it
   * refused gets TrackSubscribed once it grants them, so this composes with
   * selective subscription.
   */
  private updatePermissions(room: Room, now: number): void {
    const allowed: string[] = [];
    if (this.localKnown) {
      for (const [identity, p] of this.peers) {
        if (p.position && p.sid === p.participant.sid && permitted(distance(this.localPosition, p.position))) {
          allowed.push(identity);
        }
      }
    }
    allowed.sort();
    const before = this.permittedList;
    const adds = allowed.some((identity) => !before.includes(identity));
    const next = adds && now - this.permittedAt < PERMISSION_INTERVAL_MS ? before.filter((id) => allowed.includes(id)) : allowed;
    if (next.length === before.length && next.every((identity, i) => identity === before[i])) return;
    try {
      room.localParticipant.setTrackSubscriptionPermissions(
        false,
        next.map((identity) => ({ participantIdentity: identity, allowAll: true })),
      );
      if (next.some((identity) => !before.includes(identity))) this.permittedAt = now;
      this.permittedList = next;
    } catch {
      // The room is going; the next tick tries again if it isn't.
    }
  }

  /** Nobody may receive our mic: stored, and sent if the signal is up. */
  private clearPermissions(room: Room): void {
    try {
      room.localParticipant.setTrackSubscriptionPermissions(false, []);
    } catch {
      // The room is going.
    }
    this.permittedList = [];
  }

  /** The mic as the room has it, unless a change is in flight (setMicMuted settles it then). */
  private refreshMic(room: Room): void {
    if (this.micPending) return;
    this.micMuted = !room.localParticipant.isMicrophoneEnabled;
    const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    this.localTrack = track && track.kind === Track.Kind.Audio ? (track as LocalAudioTrack) : null;
  }

  /** What a room leaves behind once it's gone. */
  private resetRoomState(): void {
    this.limiter = createPacketLimiter();
    this.lastSent = null;
    this.permittedList = [];
    this.permittedAt = Number.NEGATIVE_INFINITY;
    this.micPending = false;
    this.micMuted = true;
    // Any mic call still in flight belongs to the room that went, and so does its problem.
    this.micCall += 1;
    this.micProblem = null;
    this.localSpeaking = QUIET;
  }

  /** Lets go of a room that failed to join. */
  private dropRoom(room: Room): void {
    if (this.room === room) this.room = null;
    if (this.joined === room) this.joined = null;
    this.stopTick();
    for (const p of this.peers.values()) this.teardownPeerAudio(p);
    this.peers.clear();
    this.stopLocalTrack();
    this.resetRoomState();
    room.removeAllListeners();
    void room.disconnect().catch(() => undefined);
  }

  /**
   * The Room for a join: this engine's own again when it is free, since
   * livekit-client keeps every Room it ever made reachable (its devicechange
   * listener), so one per join would leak one per "Rejoin here". A Room whose
   * connect() hasn't settled can't be reused (another connect() would only
   * hand back that pending promise), so a rejoin after an eviction mid-join
   * makes a new one.
   */
  private roomForJoin(): Room {
    const spare = this.spare;
    if (spare && spare !== this.connecting && spare.state === ConnectionState.Disconnected) return spare;
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      webAudioMix: false,
      // FORGE: stopMicTrackOnMute, so mic off stops the capture and the
      // browser's recording indicator goes out (setMicrophoneEnabled's publish
      // merges these defaults in: LocalParticipant.publishTrack).
      publishDefaults: { dtx: true, red: true, stopMicTrackOnMute: true },
    });
    this.spare = room;
    this.roomsMade += 1;
    return room;
  }

  /**
   * Speaking, for everyone we receive and for us, from what is actually
   * heard: each chain's `heard` analyser (after the dry gain and the reverb
   * send, so muting someone silences it), and our own mic's meter.
   */
  private listen(now: number): void {
    for (const p of this.peers.values()) {
      if (!p.audio) continue;
      p.level = this.rms(p.audio.heard);
      p.speaking = hearSpeaking(p.speaking, p.level, now);
    }
    const meter = this.liveMeter();
    this.localSpeaking = meter ? hearSpeaking(this.localSpeaking, this.rms(meter.analyser), now) : QUIET;
  }

  private rms(analyser: AnalyserNode): number {
    const samples = this.samples.subarray(0, analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  private anyoneSpeaking(): boolean {
    for (const p of this.peers.values()) {
      if (p.speaking.speaking) return true;
    }
    return false;
  }

  /**
   * Chrome keeps every MediaStreamAudioSourceNode alive while its context
   * runs; SourceEntry bounds them to one per track received, and this frees
   * them all once more than IDLE_SOURCE_LIMIT sit idle: a new context, the
   * cave's IR rendered again, and the voices being received rebuilt on it.
   * Run at a quiet moment (nobody heard speaking).
   */
  private rebuildAudio(): void {
    const old = this.ctx;
    this.rebuildWanted = false;
    if (!old) return;
    const playing = new Map<PeerInternal, RemoteTrack>();
    for (const p of this.peers.values()) {
      if (!p.audio) continue;
      const track = this.micPublication(p.participant)?.track as RemoteTrack | undefined;
      if (track && track.sid === p.audio.trackSid) playing.set(p, track);
      this.teardownPeerAudio(p);
    }
    this.unbindMeter();
    this.ctx = null;
    this.master = null;
    this.reverbBus = null;
    this.reverbReturn = null;
    this.masterTap = null;
    this.reverbTap = null;
    this.forgetSources();
    void old.close().catch(() => undefined);
    this.ensureAudioContext();
    for (const [p, track] of playing) this.buildPeerAudio(p, track);
    this.rebuilds += 1;
  }

  /** Lets go of every cached source: their context is closing. */
  private forgetSources(): void {
    for (const entry of this.idleSources) entry.element.srcObject = null;
    this.idleSources.clear();
    this.sources = new WeakMap();
  }

  private readonly unlock = (): void => {
    void this.resumeAudio();
  };

  /** While sound is blocked, every tap or key anywhere (capture phase, before anything can stop it) tries to start it. */
  private listenForUnlock(on: boolean): void {
    if (on === this.unlockListening) return;
    this.unlockListening = on;
    for (const type of UNLOCK_EVENTS) {
      if (on) window.addEventListener(type, this.unlock, { capture: true, passive: true });
      else window.removeEventListener(type, this.unlock, { capture: true });
    }
  }

  /**
   * The meter on our live mic, bound if it isn't yet, or null while the mic
   * is off: stopMicTrackOnMute hands the mic a new MediaStreamTrack each time
   * it comes back on.
   */
  private liveMeter(): Meter | null {
    const ctx = this.ctx;
    const track = this.localTrack?.mediaStreamTrack;
    if (!ctx || this.micMuted || this.micPending || !track || track.readyState !== 'live') return null;
    if (this.meter?.trackId !== track.id) this.bindMeter(ctx, track);
    return this.meter;
  }

  /** The meter's analyser, on the shared context. (livekit-client keeps a context of its own; see ADR-004.) */
  private bindMeter(ctx: AudioContext, track: MediaStreamTrack): void {
    this.unbindMeter();
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = METER_SAMPLES;
      source.connect(analyser);
      this.meter = { source, analyser, samples: new Uint8Array(analyser.fftSize), trackId: track.id };
    } catch {
      this.meter = null;
    }
  }

  private unbindMeter(): void {
    if (!this.meter) return;
    try {
      this.meter.source.disconnect();
    } catch {
      /* ignore */
    }
    this.meter = null;
  }

  /**
   * The debug view, `window.__forgeVoice`, in development builds only (next
   * build compiles it out: NODE_ENV is 'production' there). Read-only but for
   * `updateConfig` and `setPeerOcclusion`: the graph per peer (dry, send and
   * cutoff as the AudioParams hold them, the panner's position, the
   * subscription, the cap, what we hear of them), the AudioContext and reverb
   * states, the convolver's buffer, who may receive our mic, our mic's track,
   * the cached sources and rebuilds, the Rooms made, and the RMS at the master
   * or at the reverb's return (`rms('reverb')`), so the two can be read in the
   * same moment.
   */
  private installDebugView(): void {
    if (process.env.NODE_ENV === 'production') return;
    const view = {
      graph: () => ({
        status: this.status,
        context: this.ctx ? { state: this.ctx.state, sampleRate: this.ctx.sampleRate } : null,
        reverb: {
          status: this.reverbStatus,
          buffer: this.reverbBus?.buffer
            ? {
                channels: this.reverbBus.buffer.numberOfChannels,
                length: this.reverbBus.buffer.length,
                sampleRate: this.reverbBus.buffer.sampleRate,
              }
            : null,
        },
        master: this.master?.gain.value ?? null,
        deafened: this.deafened,
        config: { ...this.config },
        local: { ...this.localPosition },
        localSpeaking: this.localSpeaking.speaking,
        permitted: [...this.permittedList],
        mic: {
          muted: this.micMuted,
          pending: this.micPending,
          problem: this.micProblem,
          track: this.localTrack?.mediaStreamTrack.readyState ?? null,
        },
        cap: this.voiceCap(),
        sources: { made: this.sourcesMade, idle: this.idleSources.size },
        rebuilds: this.rebuilds,
        rooms: this.roomsMade,
        implausible: this.implausible,
        error: this.error,
        peers: [...this.peers.entries()].map(([identity, p]) => ({
          identity,
          sid: p.sid,
          distance: this.distanceTo(p),
          subscription: p.subscription,
          capped: p.capped,
          speaking: p.speaking.speaking,
          // The SFU's word on it, which nothing else here reads: for comparing.
          sfuSpeaking: p.participant.isSpeaking,
          level: p.level,
          gain: p.gain,
          reverbSend: p.reverbSend,
          cutoffHz: p.cutoffHz,
          occlusion: p.occlusion,
          localMuted: p.localMuted,
          audio: p.audio
            ? {
                dry: p.audio.dry.gain.value,
                send: p.audio.send.gain.value,
                cutoff: p.audio.filter.frequency.value,
                panner: p.audio.panner ? pannerPosition(p.audio.panner) : null,
                target: p.audio.panner && p.position ? listenerSpace(this.localPosition, p.position) : null,
              }
            : null,
        })),
      }),
      rms: (at: 'master' | 'reverb' = 'master'): number | null => {
        const ctx = this.ctx;
        const node = at === 'reverb' ? this.reverbReturn : this.master;
        if (!ctx || !node) return null;
        let tap = at === 'reverb' ? this.reverbTap : this.masterTap;
        if (!tap) {
          tap = ctx.createAnalyser();
          tap.fftSize = 2048;
          node.connect(tap);
          if (at === 'reverb') this.reverbTap = tap;
          else this.masterTap = tap;
        }
        const samples = new Float32Array(tap.fftSize);
        tap.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        return Math.sqrt(sum / samples.length);
      },
      updateConfig: (patch: Partial<ProximityConfig>) => this.updateConfig(patch),
      setPeerOcclusion: (identity: string, occlusion: number) => this.setPeerOcclusion(identity, occlusion),
    };
    (window as unknown as Record<string, unknown>)[DEBUG_GLOBAL] = view;
    this.debugView = view;
  }

  private uninstallDebugView(): void {
    if (process.env.NODE_ENV === 'production' || this.debugView === null) return;
    const host = window as unknown as Record<string, unknown>;
    if (host[DEBUG_GLOBAL] === this.debugView) delete host[DEBUG_GLOBAL];
    this.debugView = null;
  }
}

function describeError(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return `${fallback}: ${e.message}`;
  return fallback;
}

/** FORGE: whether the room knows this participant record (a packet or track from anyone else is dropped). */
function known(room: Room, rp: RemoteParticipant): boolean {
  return room.remoteParticipants.get(rp.identity) === rp;
}

/**
 * FORGE: getUserMedia's refusals, for the panel: the browser (or the member)
 * blocked it, there's no microphone to open, or something else went wrong.
 */
function micProblemFor(e: unknown): Exclude<MicProblem, null> {
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  if (name === 'NotAllowedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device';
  return 'failed';
}

/**
 * FORGE: moves a panner smoothly where the browser has position AudioParams,
 * and with setPosition() where it doesn't (Safari before 14.1).
 */
function placePanner(panner: PannerNode, v: Vec3, t: number): void {
  if (panner.positionX) {
    panner.positionX.setTargetAtTime(v.x, t, 0.05);
    panner.positionY.setTargetAtTime(v.y, t, 0.05);
    panner.positionZ.setTargetAtTime(v.z, t, 0.05);
  } else {
    panner.setPosition(v.x, v.y, v.z);
  }
}

/** FORGE: the panner's position as the AudioParams hold it now, for the debug view. */
function pannerPosition(panner: PannerNode): Vec3 | null {
  return panner.positionX
    ? { x: panner.positionX.value, y: panner.positionY.value, z: panner.positionZ.value }
    : null;
}
