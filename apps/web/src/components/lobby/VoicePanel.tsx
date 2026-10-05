'use client';

/**
 * The lobby's HUD for voice and people (the "Dock" redesign): everything
 * from the presence feed's voice snapshot (presence/types.ts), in the cave's
 * own look (its amber `--cave-*` colours, mono type and square corners;
 * Lobby.module.css).
 *
 * Bottom centre, one column, top to bottom:
 * - the people drawer, while it is open: everyone else in the room, grouped
 *   by what you can hear of them (talking, in earshot, out of range, which
 *   stays folded behind its count, and muted by you), with a search from
 *   eight people on. One line per person; a press opens the line to the full
 *   name and Mute. Without voice (the practice build) it is one list,
 *   nearest first. On a phone it is a bottom sheet over a scrim, with Mute on
 *   every line;
 * - one notice, the most pressing of: the lobby open in another tab or
 *   device ("Rejoin here"), sound held back by the browser ("Turn on
 *   sound"), voice closed or failed ("Rejoin", "Try again"), why the mic
 *   didn't start, and voice connecting or not on here at all;
 * - the dock: Mic (its fill is the mic's level), Deafen and the people count,
 *   three icons in one bar. Without voice for good (signed out, the practice
 *   build, not set up) the dock is the count alone. On a phone the count
 *   moves to the top right.
 *
 * Every action that waits on something shows it: Mic turns to a spinner
 * while it starts or stops, the notice's buttons spin until what they asked
 * for settles, and the notice spins while voice connects.
 *
 * For keyboards and screen readers:
 * - The buttons stay focusable when they can't act (`aria-disabled`, not
 *   `disabled`), and the notice says why.
 * - The live regions (the status, the mic problem and the elsewhere notice)
 *   are always in the page, with their text set and cleared, so a screen
 *   reader announces each change; the one that matters most is also the
 *   notice on screen.
 * - A control that goes away under focus hands it on first: the notice's
 *   buttons to Mic (or the count, without voice); a row to the next row's
 *   same control, or else to its list.
 * - The order holds still while the pointer is over the drawer or focus is
 *   in it, so a press never lands on someone who just moved into its place.
 * - Toggles keep their words and let `aria-pressed` carry the state.
 * - Escape in the drawer closes it, focus back on the count.
 * Names are the feed's, already sanitised, and reach the page as text only.
 */

import { VOICE } from '@forge/lobby';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode, RefObject } from 'react';

import { HeadphonesIcon, MicIcon, PeopleIcon, Spinner } from './icons';
import styles from './Lobby.module.css';
import { NO_VOICE } from './presence/noneFeed';
import type { NoneReason } from './presence/noneFeed';
import type { FeedKind, FeedStatus, MicProblem, MicState, Person, PresenceFeed, VoiceSnapshot } from './presence/types';

const cx = (...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(' ');

// ---------- the feed, as a store ----------

/** The feed's status and voice snapshot, read together; status is null while there's no feed yet. */
export interface FeedState {
  status: FeedStatus | null;
  voice: VoiceSnapshot;
}

const NO_FEED_STATE: FeedState = { status: null, voice: NO_VOICE };
const noSubscription = (): (() => void) => () => undefined;

/** The feed's state, re-rendering when the feed says it changed (`onVoice`). */
export function useFeedState(feed: PresenceFeed | null): FeedState {
  const cache = useRef<FeedState>(NO_FEED_STATE);
  const subscribe = useCallback((onChange: () => void) => (feed ? feed.onVoice(onChange) : noSubscription()), [feed]);
  const read = useCallback((): FeedState => {
    if (!feed) {
      return NO_FEED_STATE;
    }
    const status = feed.status();
    const voice = feed.voice();
    if (cache.current.status !== status || cache.current.voice !== voice) {
      cache.current = { status, voice };
    }
    return cache.current;
  }, [feed]);
  return useSyncExternalStore(subscribe, read, () => NO_FEED_STATE);
}

/** What the lobby's root reports about presence and voice, for e2e and for anyone debugging. */
export interface FeedSummary {
  feed: FeedKind;
  voice: 'unavailable' | 'off' | 'on';
  sound: 'blocked' | 'on' | 'none';
  roomSound: VoiceSnapshot['roomSound'];
  deafened: boolean;
  /** The lobby is open in another tab or device, which took this one's seat. */
  elsewhere: boolean;
  /** Joining the room failed in this browser: worth one more go (Lobby.tsx tries once, after the scene is up). */
  failed: boolean;
}

const NO_SUMMARY: FeedSummary = {
  feed: 'none',
  voice: 'unavailable',
  sound: 'none',
  roomSound: 'off',
  deafened: false,
  elsewhere: false,
  failed: false,
};

function summarise({ status, voice }: FeedState): FeedSummary {
  if (status === null) {
    return NO_SUMMARY;
  }
  return {
    // What presence runs on now, not which feed this is: a LiveKit feed that
    // was refused a token, or couldn't reach the room, reports 'none'.
    feed: status.kind,
    voice: !voice.available ? 'unavailable' : voice.mic === 'on' ? 'on' : 'off',
    sound: !voice.available ? 'none' : voice.soundBlocked ? 'blocked' : 'on',
    roomSound: voice.roomSound,
    deafened: voice.deafened,
    elsewhere: status.kind === 'none' && status.reason === 'elsewhere',
    failed: status.kind === 'none' && status.reason === 'failed',
  };
}

const sameSummary = (a: FeedSummary, b: FeedSummary): boolean =>
  a.feed === b.feed &&
  a.voice === b.voice &&
  a.sound === b.sound &&
  a.roomSound === b.roomSound &&
  a.deafened === b.deafened &&
  a.elsewhere === b.elsewhere &&
  a.failed === b.failed;

/** The root's summary only: a new object (and a re-render) only when one of its values changes. */
export function useFeedSummary(feed: PresenceFeed | null): FeedSummary {
  const cache = useRef<FeedSummary>(NO_SUMMARY);
  const subscribe = useCallback((onChange: () => void) => (feed ? feed.onVoice(onChange) : noSubscription()), [feed]);
  const read = useCallback((): FeedSummary => {
    const next = feed ? summarise({ status: feed.status(), voice: feed.voice() }) : NO_SUMMARY;
    if (!sameSummary(cache.current, next)) {
      cache.current = next;
    }
    return cache.current;
  }, [feed]);
  return useSyncExternalStore(subscribe, read, () => NO_SUMMARY);
}

// ---------- who's here ----------

/** The room in numbers, for the count, the drawer's head and the Enter gate. */
export interface RoomCount {
  /** The feed can see the room: voice is on, or the practice build's tabs. */
  sees: boolean;
  /** Everyone in the room, you included. */
  here: number;
  /** Everyone else speaking, and heard by you. */
  talking: number;
  /** Not seeing the room yet, but on the way: no feed yet, or voice connecting. */
  finding: boolean;
}

export function roomCount({ status, voice }: FeedState): RoomCount {
  const sees = voice.available || status?.kind === 'local';
  const connecting =
    status === null ||
    (status.kind !== 'none' && status.state === 'connecting') ||
    voice.connection === 'connecting' ||
    voice.connection === 'reconnecting';
  return {
    sees,
    here: voice.people.length + 1,
    talking: voice.people.filter((person) => person.speaking).length,
    finding: !sees && connecting,
  };
}

// ---------- the mic on entry ----------

/**
 * Whether you want your mic on, for this page load: the Enter gate asks for
 * it (`wantMicOnEntry`), and pressing Mic says yes or no from then on. The
 * panel turns it on once per feed when voice comes up, so coming back from
 * an app finds the mic as you left it.
 */
let micWanted = false;

export function wantMicOnEntry(): void {
  micWanted = true;
}

// ---------- words ----------

const NO_VOICE_BECAUSE: Record<Exclude<NoneReason, 'elsewhere'>, string> = {
  'signed-out': 'Sign in with GitHub to hear and talk to people here.',
  practice: 'The practice account has no voice. Sign in with GitHub to talk.',
  unavailable: "Voice isn't set up on this site yet.",
  error: "Couldn't reach the voice server. Reload to try again.",
  failed: "Couldn't connect to voice.",
};

/** The practice build has no voice at all, and no GitHub sign-in: it says where voice is instead. */
const PRACTICE_COPY = 'This practice copy has no voice. Voice is on the live site, signed in with GitHub.';
const PRACTICE_SIGNED_OUT = "Sign in to see who's here. The practice copy has no voice.";
const ELSEWHERE = "You're in the lobby in another tab or device.";

/** Whether voice is on, and if it isn't, why; empty when another notice says it (elsewhere) or there's no feed yet. */
function statusLine({ status, voice }: FeedState, practice: boolean): string {
  switch (voice.connection) {
    case 'connected':
      return voice.soundBlocked ? 'Voice on. Sound is off until you press Turn on sound.' : 'Voice on';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'closed':
      return 'Voice disconnected.';
    default:
      break;
  }
  if (status === null) {
    return '';
  }
  // The practice build's feed carries presence between tabs, and no voice.
  if (status.kind === 'local') {
    return PRACTICE_COPY;
  }
  if (status.kind === 'none' && status.reason !== 'elsewhere') {
    return status.reason === 'signed-out' && practice ? PRACTICE_SIGNED_OUT : NO_VOICE_BECAUSE[status.reason];
  }
  if (status.kind === 'livekit' && status.state === 'connecting') {
    return 'Connecting…';
  }
  return '';
}

/**
 * No voice on this visit, whatever is pressed: signed out, the practice
 * build, voice not set up, or the server out of reach (which says reload).
 * The dock is the people count alone then.
 */
function voiceGone(status: FeedStatus | null, voice: VoiceSnapshot): boolean {
  if (status === null || voice.available) {
    return false;
  }
  if (status.kind === 'local') {
    return true;
  }
  return status.kind === 'none' && status.reason !== 'elsewhere' && status.reason !== 'failed';
}

const MIC_LABEL: Record<MicState, string> = {
  off: 'Mic',
  starting: 'Starting mic…',
  on: 'Mic · live',
  stopping: 'Stopping mic…',
};

const MIC_PROBLEM: Record<Exclude<MicProblem, null>, string> = {
  denied: 'Your browser blocked the mic. Allow it in the site settings, then press the mic.',
  'no-device': 'No microphone found.',
  failed: "The mic didn't start. Press the mic to try again.",
};

/** Where the search shows: a list this long is worth finding a name in. */
const SEARCH_FROM = 8;
/** How long the order holds still after the pointer leaves the drawer, or focus leaves it. */
const ORDER_HOLD_MS = 500;

type Group = 'here' | 'talking' | 'earshot' | 'far' | 'muted';

/**
 * Which group someone is listed in. Without voice there is nothing to hear,
 * so everyone is simply here. With it: muted by you, speaking (and heard),
 * within the falloff, or past it (and anyone whose position hasn't arrived,
 * since nobody knows yet whether they're in range).
 */
function groupOf(person: Person, voiced: boolean): Group {
  if (!voiced) {
    return 'here';
  }
  if (person.mutedByYou) {
    return 'muted';
  }
  if (person.speaking) {
    return 'talking';
  }
  if (person.distance === null || person.distance >= VOICE.falloffDistance) {
    return 'far';
  }
  return 'earshot';
}

/** Why you can't hear someone, beside their name; nothing the group's own heading already says. */
function stateWords(person: Person, group: Group): string | null {
  if (person.mutedByYou) {
    return group === 'muted' ? null : 'muted by you';
  }
  if (person.distance === null) {
    return 'joining';
  }
  if (person.reception === null) {
    return null;
  }
  if (!person.micOn) {
    return 'mic off';
  }
  if (person.distance >= VOICE.falloffDistance) {
    return group === 'far' ? null : 'out of range';
  }
  if (person.crowded) {
    return 'too many voices nearby';
  }
  return person.reception === 'out-of-range' && group !== 'far' ? 'out of range' : null;
}

// ---------- buttons that hand focus on, and say they're busy ----------

/**
 * A button that goes away once it has done its job ("Turn on sound",
 * "Rejoin here"…): if it has focus when it goes, focus moves to `handOff()`
 * first. A layout effect's cleanup runs before React takes the node out.
 */
function HandOffButton({ handOff, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { handOff: () => HTMLElement | null }) {
  const ref = useRef<HTMLButtonElement>(null);
  const target = useRef(handOff);
  useLayoutEffect(() => {
    target.current = handOff;
  });
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (node !== null && node.contains(document.activeElement)) {
        target.current()?.focus();
      }
    };
  }, []);
  return <button ref={ref} type="button" {...props} />;
}

/**
 * A notice's action: spins, and won't act twice, from the press until what
 * it started settles (or it goes away, its job done).
 */
function ActionButton({
  handOff,
  onAct,
  children,
}: {
  handOff: () => HTMLElement | null;
  onAct(): Promise<unknown> | void;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <HandOffButton
      handOff={handOff}
      className={styles.action}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={() => {
        if (busy) {
          return;
        }
        const result = onAct();
        if (result instanceof Promise) {
          setBusy(true);
          void result
            .catch(() => undefined)
            .finally(() => {
              if (mounted.current) {
                setBusy(false);
              }
            });
        }
      }}
    >
      {busy && <Spinner />}
      {children}
    </HandOffButton>
  );
}

// ---------- the panel ----------

export interface VoicePanelProps {
  feed: PresenceFeed | null;
  /** The mic button, whose `--lvl` the scene sets every frame from the feed's mic level. */
  micRef: RefObject<HTMLButtonElement | null>;
  /** The practice build: no voice there, and no GitHub sign-in, so the wording says so. */
  practice: boolean;
  /** Joins again: "Rejoin here" (takes the seat back from the other tab), "Rejoin" and "Try again". */
  onRejoin(): Promise<void> | void;
}

type NoticeKind = 'elsewhere' | 'status' | 'problem' | null;

export function VoicePanel({ feed, micRef, practice, onRejoin }: VoicePanelProps) {
  const state = useFeedState(feed);
  const { status, voice } = state;
  const room = roomCount(state);
  const elsewhere = status?.kind === 'none' && status.reason === 'elsewhere';
  const failed = status?.kind === 'none' && status.reason === 'failed';
  const closed = voice.connection === 'closed';
  const gone = voiceGone(status, voice);
  const line = statusLine(state, practice);
  const pending = voice.mic === 'starting' || voice.mic === 'stopping';
  const micBlocked = !voice.available || pending;
  const micPressed = voice.available && (voice.mic === 'on' || voice.mic === 'stopping');
  const problem = voice.available && voice.micProblem !== null ? MIC_PROBLEM[voice.micProblem] : '';
  const connecting = line === 'Connecting…' || line === 'Reconnecting…';

  // One notice on screen at a time: what stops you hearing anyone first, then the mic, then the rest.
  const urgent = voice.soundBlocked || closed || failed;
  const notice: NoticeKind = elsewhere
    ? 'elsewhere'
    : urgent && line !== ''
      ? 'status'
      : problem !== ''
        ? 'problem'
        : line !== '' && voice.connection !== 'connected'
          ? 'status'
          : null;

  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const countRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  /** Where focus goes when the control that had it goes away: Mic, when it shows, or else the count. */
  const toMic = useCallback((): HTMLElement | null => {
    const mic = micRef.current;
    return mic !== null && !mic.hidden ? mic : countRef.current;
  }, [micRef]);

  // Entered with the mic asked for: on, once per feed, as soon as voice can take it.
  const askedFor = useRef<PresenceFeed | null>(null);
  useEffect(() => {
    if (
      feed !== null &&
      askedFor.current !== feed &&
      micWanted &&
      voice.available &&
      voice.connection === 'connected' &&
      voice.mic === 'off' &&
      voice.micProblem === null
    ) {
      askedFor.current = feed;
      void feed.setMic(true);
    }
  }, [feed, voice.available, voice.connection, voice.mic, voice.micProblem]);

  const toggleMic = (): void => {
    if (!feed || micBlocked) {
      return;
    }
    const on = voice.mic !== 'on';
    micWanted = on;
    askedFor.current = feed;
    // Inside the click: let the browser play sound first, then the mic (each
    // wants the gesture, iOS especially).
    void feed.resumeAudio();
    void feed.setMic(on);
  };

  const toggleDeafen = (): void => {
    if (feed && voice.available) {
      feed.setDeafened(!voice.deafened);
    }
  };

  const close = (): void => {
    setOpen(false);
    countRef.current?.focus();
  };

  const hereLabel = room.sees ? `${room.here} here` : 'People';
  return (
    <aside className={styles.hud} aria-label="People nearby" data-deafened={voice.deafened ? 'true' : undefined}>
      <div className={styles.notices}>
        <div className={notice === 'elsewhere' ? styles.notice : styles.srOnly}>
          <p role="status" data-live="elsewhere">
            {elsewhere ? ELSEWHERE : ''}
          </p>
          {notice === 'elsewhere' && (
            <ActionButton handOff={toMic} onAct={onRejoin}>
              Rejoin here
            </ActionButton>
          )}
        </div>
        <div className={notice === 'status' ? styles.notice : styles.srOnly}>
          {notice === 'status' && connecting && <Spinner />}
          <p ref={statusRef} tabIndex={-1} role="status" data-live="status">
            {line}
          </p>
          {notice === 'status' && voice.soundBlocked && (
            <ActionButton handOff={toMic} onAct={() => feed?.resumeAudio()}>
              Turn on sound
            </ActionButton>
          )}
          {notice === 'status' && (closed || failed) && (
            <ActionButton handOff={toMic} onAct={onRejoin}>
              {closed ? 'Rejoin' : 'Try again'}
            </ActionButton>
          )}
        </div>
        <div className={notice === 'problem' ? cx(styles.notice, styles.danger) : styles.srOnly}>
          <p role="status" data-live="problem">
            {problem}
          </p>
        </div>
      </div>

      <div className={styles.dock} data-controls={gone ? 'count' : 'voice'} data-dimmed={elsewhere ? 'true' : undefined}>
        <button
          ref={micRef}
          type="button"
          hidden={gone}
          className={cx(
            styles.dockButton,
            styles.mic,
            micPressed && styles.on,
            voice.speaking && styles.speaking,
            problem !== '' && styles.refused,
          )}
          aria-label={MIC_LABEL[voice.available ? voice.mic : 'off']}
          title={MIC_LABEL[voice.available ? voice.mic : 'off']}
          aria-pressed={micPressed}
          aria-disabled={micBlocked || undefined}
          aria-busy={pending || undefined}
          onClick={toggleMic}
        >
          {pending ? <Spinner /> : <MicIcon off={!micPressed} />}
          <span className={styles.meter} aria-hidden="true" />
        </button>
        <button
          type="button"
          hidden={gone}
          className={cx(styles.dockButton, styles.deafen, voice.deafened && styles.on)}
          aria-label="Deafen"
          title={voice.deafened ? 'Deafened' : 'Deafen'}
          aria-pressed={voice.deafened}
          aria-disabled={!voice.available || undefined}
          onClick={toggleDeafen}
        >
          <HeadphonesIcon off={voice.deafened} />
        </button>
        <button
          ref={countRef}
          type="button"
          data-hud="count"
          className={cx(styles.dockButton, styles.count, open && styles.on, room.talking > 0 && styles.lit)}
          aria-label={hereLabel}
          title={hereLabel}
          aria-expanded={open}
          aria-controls={drawerId}
          onClick={() => setOpen(!open)}
        >
          <PeopleIcon />
          {room.sees ? <span>{room.here}</span> : room.finding && <Spinner />}
        </button>
      </div>
      {open && <div className={styles.scrim} aria-hidden="true" onClick={() => setOpen(false)} />}
      <section
        id={drawerId}
        className={styles.drawer}
        aria-label="People in the lobby"
        hidden={!open}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
        }}
      >
        <span className={styles.grip} aria-hidden="true" />
        <header className={styles.drawerHead}>
          <h2>People</h2>
          {room.sees && (
            <span className={styles.drawerCount}>{`${room.here} here · ${room.talking} talking`}</span>
          )}
          <button type="button" className={styles.close} aria-label="Close" onClick={close}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <People
          people={voice.people}
          voiced={voice.available}
          canMute={voice.available}
          feed={feed}
          room={room}
          handOff={() => countRef.current}
        />
      </section>
    </aside>
  );
}

// ---------- the drawer's list ----------

/** `people` in the order of `frozen` (ids), anyone new after them in their own order. */
function holdOrder(people: Person[], frozen: string[]): Person[] {
  const rank = new Map(frozen.map((id, i) => [id, i]));
  return [...people].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

const GROUP_TITLE: Record<Group, string> = {
  here: 'Here',
  talking: 'Talking',
  earshot: 'In earshot',
  far: 'Out of range',
  muted: 'Muted by you',
};

/**
 * Everyone else in the room, in groups, the part of the drawer that scrolls.
 * The order is the feed's (nearest first, joining last), except that it
 * holds still while the pointer is over it or focus is in it, and for
 * ORDER_HOLD_MS after.
 */
function People({
  people,
  voiced,
  canMute,
  feed,
  room,
  handOff,
}: {
  people: Person[];
  voiced: boolean;
  canMute: boolean;
  feed: PresenceFeed | null;
  room: RoomCount;
  handOff: () => HTMLElement | null;
}) {
  const searchId = useId();
  const farId = useId();
  const [query, setQuery] = useState('');
  const [showFar, setShowFar] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const holding = useRef({ pointer: false, focus: false });
  const releaseTimer = useRef<number | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement>(null);

  const hold = (): void => {
    window.clearTimeout(releaseTimer.current);
    setFrozen((current) => current ?? people.map((person) => person.id));
  };
  const letGo = (): void => {
    if (holding.current.pointer || holding.current.focus) {
      return;
    }
    window.clearTimeout(releaseTimer.current);
    releaseTimer.current = window.setTimeout(() => setFrozen(null), ORDER_HOLD_MS);
  };
  useEffect(() => () => window.clearTimeout(releaseTimer.current), []);

  // The list itself going (the last person left) with focus in it: the count has it next.
  const target = useRef(handOff);
  useLayoutEffect(() => {
    target.current = handOff;
  });
  const hasPeople = people.length > 0;
  useLayoutEffect(() => {
    if (!hasPeople) {
      return undefined;
    }
    const body = bodyRef.current;
    return () => {
      if (body !== null && body.contains(document.activeElement)) {
        target.current()?.focus();
      }
    };
  }, [hasPeople]);

  if (!hasPeople) {
    if (room.sees) {
      return <p className={styles.empty}>Nobody else is here yet.</p>;
    }
    return (
      <p className={styles.empty}>
        {room.finding ? (
          <>
            <Spinner />
            Finding who&apos;s here…
          </>
        ) : (
          "Can't see who's here right now."
        )}
      </p>
    );
  }

  const ordered = frozen === null ? people : holdOrder(people, frozen);
  const needle = query.trim().toLowerCase();
  const found = needle === '' ? ordered : ordered.filter((person) => person.name.toLowerCase().includes(needle));
  const groups = new Map<Group, Person[]>();
  for (const person of found) {
    const group = groupOf(person, voiced);
    groups.set(group, [...(groups.get(group) ?? []), person]);
  }
  // Searching opens everything: the name you're after may be out of range.
  const farShown = showFar || needle !== '';

  const list = (group: Group, members: Person[]) => (
    <ul className={styles.list} aria-label={GROUP_TITLE[group]} id={group === 'far' ? farId : undefined}>
      {members.map((person) => (
        <PersonRow
          key={person.id}
          person={person}
          group={group}
          open={openId === person.id}
          onToggle={() => setOpenId(openId === person.id ? null : person.id)}
          canMute={canMute}
          onMute={(muted) => feed?.setMuted(person.id, muted)}
          handOff={handOff}
        />
      ))}
    </ul>
  );

  return (
    <>
      {people.length + 1 >= SEARCH_FROM && (
        <div className={styles.search}>
          <label htmlFor={searchId} className={styles.srOnly}>
            Find a name
          </label>
          <input
            id={searchId}
            type="search"
            placeholder="Find a name"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      <div
        ref={bodyRef}
        className={styles.roster}
        onPointerEnter={() => {
          holding.current.pointer = true;
          hold();
        }}
        onPointerLeave={() => {
          holding.current.pointer = false;
          letGo();
        }}
        onFocus={() => {
          holding.current.focus = true;
          hold();
        }}
        onBlur={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
            return;
          }
          holding.current.focus = false;
          letGo();
        }}
      >
        {found.length === 0 && <p className={styles.empty}>Nobody here by that name.</p>}
        {(['here', 'talking', 'earshot', 'far', 'muted'] as const).map((group) => {
          const members = groups.get(group);
          if (members === undefined) {
            return null;
          }
          return (
            <div key={group} className={styles.group} data-group={group}>
              <div className={styles.groupHead}>
                <span>{GROUP_TITLE[group]}</span>
                <span className={styles.groupCount}>{members.length}</span>
                {group === 'earshot' && <span className={styles.groupNote}>{`within ${VOICE.falloffDistance} m`}</span>}
                {group === 'far' && needle === '' && (
                  <button
                    type="button"
                    className={styles.reveal}
                    aria-expanded={farShown}
                    aria-controls={farId}
                    onClick={() => setShowFar(!showFar)}
                  >
                    {farShown ? 'Hide' : 'Show'}
                  </button>
                )}
              </div>
              {(group !== 'far' || farShown) && list(group, members)}
            </div>
          );
        })}
      </div>
    </>
  );
}

function PersonRow({
  person,
  group,
  open,
  onToggle,
  canMute,
  onMute,
  handOff,
}: {
  person: Person;
  group: Group;
  open: boolean;
  onToggle(): void;
  canMute: boolean;
  onMute(muted: boolean): void;
  /** Where focus goes if the list goes too (the last person left): the count. */
  handOff: () => HTMLElement | null;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const target = useRef(handOff);
  useLayoutEffect(() => {
    target.current = handOff;
  });
  // Leaving with focus on one of its controls: the next row's same control
  // has it next, or else the list; and if the list went with it, the count.
  useLayoutEffect(() => {
    const row = rowRef.current;
    return () => {
      if (row === null || !(document.activeElement instanceof HTMLElement) || !row.contains(document.activeElement)) {
        return;
      }
      const control = document.activeElement.dataset.control;
      const next = row.nextElementSibling ?? row.previousElementSibling;
      const same = control !== undefined && next !== null ? next.querySelector<HTMLElement>(`[data-control="${control}"]`) : null;
      const list = row.parentElement;
      if (same !== null) {
        same.focus();
      } else if (list !== null) {
        list.tabIndex = -1;
        list.focus();
      }
      // Once React has finished taking nodes out: focus fallen to the page means the list went too.
      queueMicrotask(() => {
        if (document.activeElement === null || document.activeElement === document.body) {
          target.current()?.focus();
        }
      });
    };
  }, []);

  const words = stateWords(person, group);
  return (
    <li
      ref={rowRef}
      className={cx(styles.person, person.speaking && styles.talking, person.distance === null && styles.joining)}
      data-person-id={person.id}
      data-open={open ? 'true' : undefined}
    >
      <button type="button" className={styles.row} aria-expanded={open} data-control="row" onClick={onToggle}>
        <i aria-hidden="true" style={{ '--near': String(person.nearness) } as CSSProperties} />
        <span className={styles.who}>
          <span className={styles.name} dir="auto" title={person.name}>
            {person.name}
          </span>
          {words !== null && <span className={styles.words}>{words}</span>}
        </span>
        <span className={styles.far}>{person.distance === null ? '' : `${Math.round(person.distance)} m`}</span>
      </button>
      {open && (
        <span className={styles.fullName} dir="auto">
          {person.name}
        </span>
      )}
      {canMute && (
        <button
          type="button"
          className={styles.mute}
          aria-pressed={person.mutedByYou}
          data-control="mute"
          onClick={() => onMute(!person.mutedByYou)}
        >
          Mute<span className={styles.srOnly}>{` ${person.name}`}</span>
        </button>
      )}
    </li>
  );
}
