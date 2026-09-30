/**
 * The live build's presence feed: positions and proximity voice over
 * LiveKit.
 *
 * `connect()` asks this origin for a room token (`POST /api/lobby/token`),
 * then joins the room. Who a peer is (their identity and display name) comes
 * only from LiveKit's participant record, which the token route signed; a
 * position packet carries nothing but a position. Each packet must arrive on
 * the `pos` topic from a participant the room knows, within the sender's
 * rate limit, and decode to a place inside the cave.
 *
 * Voice follows the lobby contract: a peer is at full volume within 2 m,
 * fades to silence at 9 m, and past 14 m their audio is not received at all.
 * A peer whose position is not known yet stays silent. Only a peer's
 * microphone is voice: any other source is refused (the token lets members
 * publish nothing else anyway). Remote audio plays through hidden `<audio>`
 * elements this feed owns and removes on `close()`.
 *
 * The range holds at the source too, so a modified client can't listen from
 * across the cave: while the mic is on, the SFU is told every 500 ms who may
 * receive it, which is everyone whose last known position is within 14 m
 * (nobody whose position hasn't arrived). Mic off, or the room gone, lifts it.
 *
 * A reconnect that has to rejoin the room (the SFU restarted, or the network
 * was gone too long to resume) comes back with the mic off rather than
 * republishing it behind a button that reads off. The room holds each member
 * once, so opening the lobby in another tab or device takes this one's seat:
 * the status becomes `'none'`/`'elsewhere'`, and `connect()` takes it back.
 *
 * `livekit-client` is loaded on `connect()`, so a page that never joins
 * (the practice build, a signed-out visitor) never downloads it. It logs
 * warnings and errors only.
 */
import {
  SUBSCRIBE_RANGE,
  acceptPacket,
  createPacketLimiter,
  decodePosition,
  encodePosition,
  forgetSender,
  gainFor,
  near,
  sanitizeName,
  sendPolicy,
} from '@forge/lobby';
import type * as LiveKit from 'livekit-client';
import type {
  DisconnectReason,
  Participant,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  TrackPublication,
} from 'livekit-client';

import type { NoneReason } from './noneFeed';
import type { FeedStatus, PeerState, PresenceFeed, SelfState } from './types';

/** Where the feed asks for a room token: apps/web/src/app/api/lobby/token/route.ts. */
export const TOKEN_PATH = '/api/lobby/token';
/** The data topic position packets travel on. */
const POSITION_TOPIC = 'pos';
/** Re-subscribe a metre inside SUBSCRIBE_RANGE, so a peer standing on the edge doesn't flap. */
const RESUBSCRIBE_RANGE = SUBSCRIBE_RANGE - 1;
/** While the mic is on, how often the SFU is told again who is in range to receive it. */
const RANGE_INTERVAL_MS = 500;
/** The prototype's meter: mean distance from silence (128) in a byte waveform, full scale at 20. */
const METER_FULL_SCALE = 20;

interface Grant {
  url: string;
  token: string;
}

interface Voice {
  track: RemoteAudioTrack;
  element: HTMLAudioElement;
}

interface Remote {
  participant: RemoteParticipant;
  /** From the server-signed token, sanitised again all the same. */
  name: string;
  position: SelfState | null;
  /** By track sid. */
  voices: Map<string, Voice>;
  gain: number;
  subscribed: boolean;
}

interface Meter {
  context: AudioContext;
  analyser: AnalyserNode;
  samples: Uint8Array;
  trackId: string;
}

export function livekitFeed(): PresenceFeed {
  const remotes = new Map<string, Remote>();
  const peers = new Map<string, PeerState>();
  /** Participants the room knows whose position hasn't arrived: identity → name. */
  const unplaced = new Map<string, string>();
  const talking = new Set<string>();
  let limiter = createPacketLimiter();
  let status: FeedStatus = { kind: 'livekit', state: 'connecting' };
  let lk: typeof LiveKit | null = null;
  let room: Room | null = null;
  /** The room once `connect()` resolved for it: a room that drops before that never joined. */
  let joined: Room | null = null;
  /** Bumped by every connect() and close(), so a join that was overtaken stands down. */
  let generation = 0;
  let joining: Promise<void> | null = null;
  let lastSent: SelfState | null = null;
  let lastSentAt = 0;
  let micOn = false;
  /** Bumped by every mic change, so a change that was overtaken doesn't settle the range. */
  let micChange = 0;
  let meter: Meter | null = null;
  /** Where we are (setListener): the centre of the range our open mic reaches. */
  let listener: SelfState | null = null;
  let rangeTimer: ReturnType<typeof setInterval> | undefined;
  /** Who the SFU was last told may receive our mic (a key), or null while anyone may. */
  let allowed: string | null = null;

  const connected = (): boolean => status.kind === 'livekit' && status.state === 'connected';
  /** On only while the feed switched it on and the room agrees (a moderator's mute, say, turns it off). */
  const micLive = (): boolean => micOn && room !== null && room.localParticipant.isMicrophoneEnabled;
  const isVoice = (publication: TrackPublication): boolean =>
    lk !== null && publication.source === lk.Track.Source.Microphone;

  const showPeer = (identity: string, remote: Remote): void => {
    if (remote.position !== null) {
      peers.set(identity, { id: identity, name: remote.name, talking: talking.has(identity), ...remote.position });
    }
  };

  /** The room's record of `participant`, or null if the room does not know them (any more). */
  const remoteFor = (current: Room, participant: RemoteParticipant | undefined): Remote | null => {
    if (participant === undefined || current.remoteParticipants.get(participant.identity) !== participant) {
      return null;
    }
    let remote = remotes.get(participant.identity);
    if (remote === undefined) {
      remote = {
        participant,
        name: sanitizeName(participant.name),
        position: null,
        voices: new Map(),
        gain: 0,
        subscribed: true,
      };
      remotes.set(participant.identity, remote);
      unplaced.set(participant.identity, remote.name);
    } else if (remote.participant !== participant) {
      // A full reconnect can hand us a new record for the same identity.
      remote.participant = participant;
    }
    return remote;
  };

  const removeVoice = (remote: Remote, trackSid: string): void => {
    const voice = remote.voices.get(trackSid);
    if (voice === undefined) return;
    voice.track.detach(voice.element);
    voice.element.remove();
    remote.voices.delete(trackSid);
  };

  const forget = (identity: string): void => {
    const remote = remotes.get(identity);
    if (remote !== undefined) {
      for (const trackSid of [...remote.voices.keys()]) removeVoice(remote, trackSid);
    }
    remotes.delete(identity);
    peers.delete(identity);
    unplaced.delete(identity);
    talking.delete(identity);
    forgetSender(limiter, identity);
  };

  const stopMeter = (): void => {
    if (meter === null) return;
    void meter.context.close().catch(() => undefined);
    meter = null;
  };

  const startMeter = (current: Room): void => {
    if (lk === null) return;
    const track = current.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.track?.mediaStreamTrack;
    if (track === undefined || meter?.trackId === track.id) return;
    stopMeter();
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
      meter = { context, analyser, samples: new Uint8Array(analyser.fftSize), trackId: track.id };
    } catch {
      meter = null;
    }
  };

  /**
   * Tells the SFU who may receive our mic: every participant whose last
   * known position is within SUBSCRIBE_RANGE of ours. Nobody without a
   * position, and nobody at all before we know where we are. Sent only when
   * that changes; the SDK sends it again itself after a reconnect.
   */
  const restrictListeners = (current: Room): void => {
    const inRange: string[] = [];
    for (const [identity, remote] of remotes) {
      if (listener !== null && remote.position !== null && distance(remote.position, listener) <= SUBSCRIBE_RANGE) {
        inRange.push(identity);
      }
    }
    const key = JSON.stringify(inRange.sort());
    if (key === allowed) return;
    allowed = key;
    try {
      current.localParticipant.setTrackSubscriptionPermissions(
        false,
        inRange.map((identity) => ({ participantIdentity: identity, allowAll: true })),
      );
    } catch {
      allowed = null;
    }
  };

  const stopRangeTimer = (): void => {
    clearInterval(rangeTimer);
    rangeTimer = undefined;
  };

  /** Once a mic change has settled: keep the range while the mic is live, lift it once it isn't. */
  const settleRange = (current: Room): void => {
    if (room !== current) return;
    if (current.localParticipant.isMicrophoneEnabled) {
      restrictListeners(current);
      rangeTimer ??= setInterval(() => {
        if (room === current) restrictListeners(current);
      }, RANGE_INTERVAL_MS);
      return;
    }
    stopRangeTimer();
    if (allowed === null) return;
    allowed = null;
    try {
      current.localParticipant.setTrackSubscriptionPermissions(true);
    } catch {
      // The room is going; its restriction goes with it.
    }
  };

  /** Browsers hold audio back until a gesture: the first click or key after joining lets peers be heard. */
  const unlockAudio = (): void => {
    if (room !== null && !room.canPlaybackAudio) void room.startAudio().catch(() => undefined);
  };

  const teardown = (): void => {
    for (const identity of [...remotes.keys()]) forget(identity);
    peers.clear();
    unplaced.clear();
    talking.clear();
    limiter = createPacketLimiter();
    stopMeter();
    micOn = false;
    micChange += 1;
    // The room is gone, and with it any restriction on who may hear us.
    stopRangeTimer();
    allowed = null;
    lastSent = null;
    window.removeEventListener('pointerdown', unlockAudio, true);
    window.removeEventListener('keydown', unlockAudio, true);
  };

  const wire = (current: Room, kit: typeof LiveKit): void => {
    const { RoomEvent } = kit;
    const live = (): boolean => room === current;

    current
      .on(RoomEvent.ParticipantConnected, (participant) => {
        if (!live()) return;
        remoteFor(current, participant);
        // Somebody new: send our position on the next frame rather than at the next heartbeat.
        lastSent = null;
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (live()) forget(participant.identity);
      })
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (!live() || topic !== POSITION_TOPIC) return;
        const remote = remoteFor(current, participant);
        if (remote === null || participant === undefined) return;
        if (!acceptPacket(limiter, participant.identity, performance.now())) return;
        const position = decodePosition(payload);
        if (position === null) return;
        remote.position = position;
        unplaced.delete(participant.identity);
        showPeer(participant.identity, remote);
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (!live()) return;
        talking.clear();
        for (const speaker of speakers) {
          if (!speaker.isLocal) talking.add(speaker.identity);
        }
        for (const [identity, remote] of remotes) showPeer(identity, remote);
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant) => {
        if (!live()) return;
        const remote = remoteFor(current, participant);
        // A microphone only: no video, no screen-share audio, and nobody out of range.
        if (remote === null || !isVoice(publication) || !(track instanceof kit.RemoteAudioTrack) || !remote.subscribed) {
          publication.setSubscribed(false);
          return;
        }
        removeVoice(remote, publication.trackSid);
        const element = document.createElement('audio');
        element.hidden = true;
        element.setAttribute('data-lobby-voice', '');
        document.body.append(element);
        track.attach(element);
        const voice = { track, element };
        remote.voices.set(publication.trackSid, voice);
        applyGain(voice, remote.gain);
      })
      .on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
        const remote = remotes.get(participant.identity);
        if (live() && remote !== undefined) removeVoice(remote, publication.trackSid);
      })
      .on(RoomEvent.Reconnecting, () => {
        if (!live()) return;
        status = { kind: 'livekit', state: 'connecting' };
        // Rejoining republishes every track, the mic live included, while the
        // button reads off (voice is unavailable meanwhile). Come back muted.
        micOn = false;
        stopMeter();
        stopRangeTimer();
        const change = (micChange += 1);
        void current.localParticipant
          .setMicrophoneEnabled(false)
          .catch(() => undefined)
          .then(() => {
            if (change === micChange) settleRange(current);
          });
      })
      .on(RoomEvent.Reconnected, () => {
        if (!live()) return;
        status = { kind: 'livekit', state: 'connected' };
        lastSent = null;
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (!live()) return;
        room = null;
        // A join still under way for this room is over too: connect() starts afresh.
        generation += 1;
        joining = null;
        teardown();
        if (reason === kit.DisconnectReason.DUPLICATE_IDENTITY) {
          // The member joined from another tab or device, which took this seat.
          status = { kind: 'none', reason: 'elsewhere' };
          return;
        }
        // LiveKit also reports a failed join this way, before connect() rejects.
        status = joined === current ? { kind: 'livekit', state: 'closed' } : { kind: 'none', reason: 'error' };
      });
  };

  const join = async (joinGeneration: number): Promise<void> => {
    status = { kind: 'livekit', state: 'connecting' };
    const grant = await fetchGrant();
    if (joinGeneration !== generation) return;
    if (typeof grant === 'string') {
      status = { kind: 'none', reason: grant };
      return;
    }
    let kit: typeof LiveKit;
    try {
      kit = await import('livekit-client');
    } catch {
      if (joinGeneration === generation) status = { kind: 'none', reason: 'error' };
      return;
    }
    if (joinGeneration !== generation) return;
    kit.setLogLevel(kit.LogLevel.warn);
    lk = kit;
    const current = new kit.Room({ adaptiveStream: false, dynacast: false });
    room = current;
    wire(current, kit);
    try {
      await current.connect(grant.url, grant.token, { autoSubscribe: true });
    } catch {
      if (room === current) {
        room = null;
        teardown();
        status = { kind: 'none', reason: 'error' };
      }
      current.removeAllListeners();
      void current.disconnect().catch(() => undefined);
      return;
    }
    if (room !== current || joinGeneration !== generation) {
      current.removeAllListeners();
      void current.disconnect().catch(() => undefined);
      return;
    }
    joined = current;
    status = { kind: 'livekit', state: 'connected' };
    for (const participant of current.remoteParticipants.values()) remoteFor(current, participant);
    window.addEventListener('pointerdown', unlockAudio, true);
    window.addEventListener('keydown', unlockAudio, true);
  };

  return {
    kind: 'livekit',

    connect() {
      if (joining !== null) return joining;
      if (room !== null) return Promise.resolve();
      generation += 1;
      const pending = join(generation).finally(() => {
        if (joining === pending) joining = null;
      });
      joining = pending;
      return pending;
    },

    status: () => status,

    publish(state) {
      const current = room;
      if (current === null || !connected()) return;
      const now = performance.now();
      if (!sendPolicy(lastSent, lastSentAt, now, state)) return;
      lastSent = { x: state.x, y: state.y, z: state.z, yaw: state.yaw };
      lastSentAt = now;
      void current.localParticipant
        .publishData(encodePosition(lastSent), { reliable: false, topic: POSITION_TOPIC })
        .catch(() => undefined);
    },

    peers: () => peers,

    joining: () => unplaced,

    async setMic(on) {
      const current = room;
      if (current === null || !connected()) return false;
      const local = current.localParticipant;
      const change = (micChange += 1);
      // In range before it can go live: the SFU hears who may receive it first.
      if (on) restrictListeners(current);
      try {
        if (on) await current.startAudio().catch(() => undefined);
        await local.setMicrophoneEnabled(on);
      } catch {
        // Permission refused, no microphone (getUserMedia failed), or the room went away.
      }
      if (room !== current) return false;
      micOn = local.isMicrophoneEnabled;
      if (micOn) startMeter(current);
      else stopMeter();
      if (change === micChange) settleRange(current);
      return micOn;
    },

    micOn: micLive,

    micLevel() {
      if (!micLive() || meter === null) return 0;
      meter.analyser.getByteTimeDomainData(meter.samples);
      let sum = 0;
      for (const sample of meter.samples) sum += Math.abs(sample - 128);
      return Math.min(1, sum / meter.samples.length / METER_FULL_SCALE);
    },

    voiceAvailable: connected,

    setListener(self) {
      if (!Number.isFinite(self.x) || !Number.isFinite(self.y) || !Number.isFinite(self.z)) return;
      listener ??= { x: 0, y: 0, z: 0, yaw: 0 };
      listener.x = self.x;
      listener.y = self.y;
      listener.z = self.z;
      for (const remote of remotes.values()) {
        // Until a peer's position arrives they stay silent, and their subscription is left alone.
        if (remote.position === null) continue;
        const dist = distance(remote.position, self);
        const gain = Math.round(gainFor(near(dist)) * 100) / 100;
        if (gain !== remote.gain) {
          remote.gain = gain;
          for (const voice of remote.voices.values()) applyGain(voice, gain);
        }
        const subscribe = dist <= (remote.subscribed ? SUBSCRIBE_RANGE : RESUBSCRIBE_RANGE);
        if (subscribe !== remote.subscribed) {
          remote.subscribed = subscribe;
          for (const publication of remote.participant.audioTrackPublications.values()) {
            if (isVoice(publication)) publication.setSubscribed(subscribe);
          }
        }
      }
    },

    close() {
      generation += 1;
      joining = null;
      const current = room;
      room = null;
      joined = null;
      teardown();
      if (current !== null) {
        current.removeAllListeners();
        void current.disconnect().catch(() => undefined);
      }
      if (status.kind === 'livekit') status = { kind: 'livekit', state: 'closed' };
    },
  };
}

function distance(a: SelfState, b: SelfState): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Volume through LiveKit, and `muted` besides: iOS ignores an element's
 * volume, so there silence at least stays silence.
 */
function applyGain(voice: Voice, gain: number): void {
  voice.track.setVolume(gain);
  voice.element.muted = gain === 0;
}

/** The room URL and token, or why there are none (the contract's `'none'` reasons). */
async function fetchGrant(): Promise<Grant | NoneReason> {
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
