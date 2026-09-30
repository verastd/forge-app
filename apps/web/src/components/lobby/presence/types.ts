/**
 * The lobby presence interface, from the lobby contract (units 3P and 3M),
 * plus what the review added: `joining()` (people in the room with no
 * position yet, so the people panel can list them), `micOn()` (the feed's
 * own word on the mic, which a reconnect can turn off) and the `'elsewhere'`
 * reason (the member opened the lobby in another tab or device, which took
 * this one's seat). The scene and shell code against these types; the feeds
 * beside this file implement them.
 *
 * The contract's bodiless `export function createPresenceFeed(...)` cannot
 * stand in a `.ts` module (no implementation, and nothing at runtime), so the
 * implementation lives in `./createPresenceFeed.ts` and is re-exported here
 * with exactly that signature. Import it from either module.
 */
export interface SelfState { x: number; y: number; z: number; yaw: number }
export interface PeerState extends SelfState { id: string; name: string; talking: boolean }
export type FeedKind = 'livekit' | 'local' | 'none';
export type FeedStatus =
  | { kind: 'none'; reason: 'signed-out' | 'practice' | 'unavailable' | 'error' | 'elsewhere' }
  | { kind: 'local' | 'livekit'; state: 'connecting' | 'connected' | 'closed' };
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
  /** Whether the local mic is on now: false whenever voice is unavailable, and after a reconnect that rejoined. */
  micOn(): boolean;
  /** Local mic level 0..1 for the meter, 0 when off. */
  micLevel(): number;
  /** Whether voice can work at all on this feed ('livekit' with env present). */
  voiceAvailable(): boolean;
  /** Feed calls this with each peer's distance to apply audio gain; the scene supplies it each frame. */
  setListener(state: SelfState): void;
  close(): void;
}
export interface FeedIdentity { name: string }
export { createPresenceFeed } from './createPresenceFeed';
