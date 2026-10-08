/**
 * The lobby presence interface, from the lobby contract (units 3P and 3M),
 * plus what the review added: `joining()` (people in the room with no
 * position yet, so the people panel can list them), `micOn()` (the feed's
 * own word on the mic) and the `'elsewhere'` reason (the member opened the
 * lobby in another tab or device, which took this one's seat). The scene and
 * shell code against these types; the feeds beside this file implement them.
 *
 * Voice v2 (2026-10-04) added the voice snapshot: everything the people panel
 * shows, from one place. `voice()` is the current snapshot and `onVoice()`
 * says when it changes, so React reads it as an external store. A snapshot is
 * a new object only when something in it changed; distances and gains are
 * rounded (0.5 m, 0.02) and change it at most five times a second, so a
 * walking member doesn't re-render the panel every frame. Status changes
 * notify too, so `status()` and `voice()` are read together.
 *
 * The contract's bodiless `export function createPresenceFeed(...)` cannot
 * stand in a `.ts` module (no implementation, and nothing at runtime), so the
 * implementation lives in `./createPresenceFeed.ts` and is re-exported here
 * with exactly that signature. Import it from either module.
 */
export interface SelfState { x: number; y: number; z: number; yaw: number }
/** `talking`: speaking, and audible to you (in range, not muted by you, and you not deafened). */
export interface PeerState extends SelfState { id: string; name: string; talking: boolean }
export type FeedKind = 'livekit' | 'local' | 'none';
/**
 * `'error'`: the token route answered something unexpected, or couldn't be
 * reached. `'failed'`: the route gave a token, and joining the room failed in
 * this browser (the engine's chunk didn't load, no AudioContext, LiveKit's
 * connect gave up), which trying again may well fix.
 */
export type FeedStatus =
  | { kind: 'none'; reason: 'signed-out' | 'practice' | 'unavailable' | 'error' | 'failed' | 'elsewhere' }
  | { kind: 'local' | 'livekit'; state: 'connecting' | 'connected' | 'closed' };

export type VoiceConnection = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type MicState = 'off' | 'starting' | 'on' | 'stopping';
export type MicProblem = 'denied' | 'no-device' | 'failed' | null;
/** Fable's SubscriptionState, worded for people. */
export type Reception = 'out-of-range' | 'tuning-in' | 'in-range' | 'dropping';
/** Fable's ReverbStatus, worded for people. */
export type RoomSound = 'off' | 'rendering' | 'live' | 'failed';

/** Someone else in the room, as the people panel shows them. */
export interface Person {
  id: string;
  name: string;
  /** Metres, to the nearest 0.5; null until their position arrives ("joining"). */
  distance: number | null;
  /** 0..1, the visual "within earshot" cue (`nearness` in @forge/lobby). */
  nearness: number;
  /** 0..1, the dry gain you hear: 0 when muted by you, out of range or their mic is off, and on feeds without voice. */
  direct: number;
  /** 0..1, the reverb send you hear, likewise. */
  reverb: number;
  /** The lowpass now, Hz; 0 on feeds without voice. */
  cutoffHz: number;
  /** 0..1. */
  occlusion: number;
  /** null on feeds without voice. */
  reception: Reception | null;
  /** Within reach, but past the cap on voices received at once: someone nearer, or speaking, has it. */
  crowded: boolean;
  /** Speaking, and audible to you. */
  speaking: boolean;
  /** They have a live mic. */
  micOn: boolean;
  mutedByYou: boolean;
}

export interface VoiceSnapshot {
  /** In a LiveKit room, connected or reconnecting. */
  available: boolean;
  connection: VoiceConnection | null;
  mic: MicState;
  micProblem: MicProblem;
  deafened: boolean;
  /** The browser holds sound until a tap. */
  soundBlocked: boolean;
  roomSound: RoomSound;
  /** You. */
  speaking: boolean;
  /** Everyone else in the room: nearest first, joining last. */
  people: Person[];
}

export interface PresenceFeed {
  readonly kind: FeedKind;
  /** Resolves once joined (or immediately for 'none'). Never throws; failures show in status(). */
  connect(): Promise<void>;
  status(): FeedStatus;
  /** Called every animation frame with the local state; the feed decides when to send. */
  publish(state: SelfState): void;
  /** Called once per animation frame; the current peers (excluding self). */
  peers(): ReadonlyMap<string, PeerState>;
  /** Everyone else in the room whose position hasn't arrived yet, id → name: no orb, but not invisible. */
  joining(): ReadonlyMap<string, string>;
  /** Mic toggle. Resolves to the resulting state; false when voice is unavailable or blocked. */
  setMic(on: boolean): Promise<boolean>;
  /** Whether the local mic is on now, as the room says: false whenever voice is unavailable. */
  micOn(): boolean;
  /** Local mic level 0..1 for the meter, 0 when off. */
  micLevel(): number;
  /** Whether voice can work at all on this feed ('livekit', in the room). */
  voiceAvailable(): boolean;
  /** Where the listener is, and which way they face; the scene supplies it each frame. */
  setListener(state: SelfState): void;
  /** The voice snapshot now. The same object until `onVoice` listeners hear of a change. */
  voice(): VoiceSnapshot;
  /** Any change to `voice()` or `status()`; distance and gain changes at most 5 Hz. Returns the unsubscribe. */
  onVoice(listener: () => void): () => void;
  /** Silence everyone (the master gain), or hear them again. */
  setDeafened(on: boolean): void;
  /**
   * How much of the cave's reverb you hear, 0 (dry) to 1 (the cave as designed): your own
   * mix only. Taken now, and kept for a room joined later.
   */
  setReverbLevel(level: number): void;
  /** Mute one person, for yourself only. */
  setMuted(id: string, muted: boolean): void;
  /** Let the browser play sound: call it inside a user gesture. */
  resumeAudio(): Promise<void>;
  /** Render the cave's reverb again after it failed. */
  retryRoomSound(): void;
  close(): void;
}
export interface FeedIdentity { name: string }
export { createPresenceFeed } from './createPresenceFeed';
