import type { FeedStatus, PeerState, PresenceFeed } from './types';

/** Why a feed is inert: the `reason` of the contract's `'none'` status. */
export type NoneReason = Extract<FeedStatus, { kind: 'none' }>['reason'];

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
    close: nothing,
  };
}
