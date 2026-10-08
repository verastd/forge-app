import type { FeedStatus, PeerState, Person, PresenceFeed, VoiceSnapshot } from './types';

/** Why a feed is inert: the `reason` of the contract's `'none'` status. */
export type NoneReason = Extract<FeedStatus, { kind: 'none' }>['reason'];

/**
 * The voice snapshot of a feed with no voice: nobody, nothing on. Frozen and
 * shared, so it is the same object every time (types.ts). The feeds that do
 * list people start from it.
 */
export const NO_VOICE: VoiceSnapshot = Object.freeze({
  available: false,
  connection: null,
  mic: 'off',
  micProblem: null,
  deafened: false,
  soundBlocked: false,
  roomSound: 'off',
  speaking: false,
  people: Object.freeze([]) as unknown as Person[],
});

/** The people panel's order: nearest first, joining last; ties by name, then id, so equal distances never shuffle. */
export function sortPeople(people: Person[]): Person[] {
  return people.sort(
    (a, b) =>
      (a.distance ?? Infinity) - (b.distance ?? Infinity) ||
      a.name.localeCompare(b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

const NO_PEERS: ReadonlyMap<string, PeerState> = new Map();
const NOBODY_JOINING: ReadonlyMap<string, string> = new Map();
const nothing = (): void => undefined;

/** The inert feed: no peers, no voice, nothing sent. `status()` carries the reason. */
export function noneFeed(reason: NoneReason): PresenceFeed {
  const status: FeedStatus = { kind: 'none', reason };
  return {
    kind: 'none',
    connect: () => Promise.resolve(),
    status: () => status,
    publish: nothing,
    peers: () => NO_PEERS,
    joining: () => NOBODY_JOINING,
    setMic: () => Promise.resolve(false),
    micOn: () => false,
    micLevel: () => 0,
    voiceAvailable: () => false,
    setListener: nothing,
    voice: () => NO_VOICE,
    onVoice: () => nothing,
    setDeafened: nothing,
    setReverbLevel: nothing,
    setMuted: nothing,
    resumeAudio: () => Promise.resolve(),
    retryRoomSound: nothing,
    close: nothing,
  };
}
