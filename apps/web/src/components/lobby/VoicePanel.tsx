'use client';

/**
 * The people panel, "People nearby": who else is in the lobby, what you hear
 * of each of them and why, and your own voice controls, all from the presence
 * feed's voice snapshot (presence/types.ts). In the cave's own look: its
 * amber `--cave-*` colours, mono type and square buttons (Lobby.module.css).
 *
 * Top to bottom, a block that keeps its size: the elsewhere notice and
 * "Rejoin here", when another tab or device took this one's seat; "Turn on
 * sound", while the browser holds sound back until a tap; a status line
 * saying whether voice is on and, if not, why ("Rejoin" after the room closed,
 * "Try again" after a join that failed in this browser); the cave-sound pill;
 * the mic and deafen buttons; and why the mic didn't start. Under it, the
 * only part that scrolls: everyone else in the room, nearest first, joining
 * last. Each row's level bar keeps the technical detail of what you hear from
 * them (the full name, direct and reverb levels, the lowpass, occlusion)
 * behind a tooltip, the way the run-time chip on Contribute keeps its token
 * estimate (components/RunEstimate.tsx): it shows on hover or focus, a tap
 * toggles it, and Escape hides it, whether it was hovered or focused (WCAG
 * 1.4.13).
 *
 * For keyboards and screen readers:
 * - The buttons stay focusable when they can't act (`aria-disabled`, not
 *   `disabled`), and the status line says why.
 * - The live regions (the status, the mic problem, the elsewhere notice and
 *   the cave sound failing) are always in the page, with their text set and
 *   cleared, so a screen reader announces each change.
 * - A control that goes away under focus hands it on first: "Turn on sound",
 *   Retry, "Rejoin here", "Rejoin" and "Try again" to Mic; a row to the next
 *   row's same control, or else to the list.
 * - The order holds still while the pointer is over the list or focus is in
 *   it, so a click never lands on someone who just moved into its place.
 * - Toggles keep their words and let `aria-pressed` carry the state.
 * Names are the feed's, already sanitised, and reach the page as text only.
 */

import { VOICE } from '@forge/lobby';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, RefObject } from 'react';

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

/** Whether voice is on, and if it isn't, why; empty when another block says it (elsewhere) or there's no feed yet. */
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
  return '';
}

const MIC_LABEL: Record<MicState, string> = {
  off: 'Mic',
  starting: 'Starting mic…',
  on: 'Mic · live',
  stopping: 'Stopping mic…',
};

const MIC_PROBLEM: Record<Exclude<MicProblem, null>, string> = {
  denied: "Your browser blocked the mic. Allow the microphone in your browser's site settings, then press Mic again.",
  'no-device': 'No microphone found.',
  failed: "The mic didn't start. Press Mic to try again.",
};

/** On a phone, the nearest few (and anyone speaking) until the list is opened up; Lobby.module.css hides the rest. */
const PHONE_ROWS = 4;
/** How long the order holds still after the pointer leaves the list, or focus leaves it. */
const ORDER_HOLD_MS = 500;

/** What you hear of someone, in numbers: the row's tooltip, under their full name. */
function technical(person: Person): string {
  const parts = [`Direct ${Math.round(person.direct * 100)}%`, `Reverb ${Math.round(person.reverb * 100)}%`];
  // Nothing heard (a feed without voice, or someone out of earshot): a lowpass is nothing to report.
  if (person.cutoffHz > 0 && (person.direct > 0 || person.reverb > 0)) {
    parts.push(`${(person.cutoffHz / 1000).toFixed(1)} kHz`);
  }
  if (person.occlusion > 0) {
    parts.push(`Occluded ${Math.round(person.occlusion * 100)}%`);
  }
  return parts.join(' · ');
}

/** Why you can't hear someone, when voice is on: muted by you, their mic, the distance, or the cap. */
function stateWords(person: Person): string | null {
  if (person.reception === null) {
    return null;
  }
  if (person.mutedByYou) {
    return 'muted by you';
  }
  if (!person.micOn) {
    return 'mic off';
  }
  // Joining: where they are isn't known, so neither is whether they're in range.
  if (person.distance === null) {
    return null;
  }
  if (person.distance >= VOICE.falloffDistance) {
    return 'out of range';
  }
  if (person.crowded) {
    return 'too many voices nearby';
  }
  return person.reception === 'out-of-range' ? 'out of range' : null;
}

/** The rows a phone shows before the list is opened: everyone speaking (and heard), then the nearest. */
function phoneRows(people: Person[]): Set<string> {
  const shown = new Set(people.filter((person) => person.speaking).map((person) => person.id));
  for (const person of people) {
    if (shown.size >= PHONE_ROWS) {
      break;
    }
    shown.add(person.id);
  }
  return shown;
}

// ---------- focus that doesn't fall to the page ----------

/**
 * A button that goes away once it has done its job ("Turn on sound", Retry,
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

// ---------- the panel ----------

export interface VoicePanelProps {
  feed: PresenceFeed | null;
  /** The mic button, whose `--lvl` the scene sets every frame from the feed's mic level. */
  micRef: RefObject<HTMLButtonElement | null>;
  reducedMotion: boolean;
  /** The practice build: no voice there, and no GitHub sign-in, so the wording says so. */
  practice: boolean;
  /** Joins again: "Rejoin here" (takes the seat back from the other tab), "Rejoin" and "Try again". */
  onRejoin(): void;
}

export function VoicePanel({ feed, micRef, reducedMotion, practice, onRejoin }: VoicePanelProps) {
  const state = useFeedState(feed);
  const { status, voice } = state;
  const elsewhere = status?.kind === 'none' && status.reason === 'elsewhere';
  const failed = status?.kind === 'none' && status.reason === 'failed';
  const closed = voice.connection === 'closed';
  const line = statusLine(state, practice);
  const pending = voice.mic === 'starting' || voice.mic === 'stopping';
  const micBlocked = !voice.available || pending;
  const micPressed = voice.available && (voice.mic === 'on' || voice.mic === 'stopping');
  const problem = voice.available && voice.micProblem !== null ? MIC_PROBLEM[voice.micProblem] : '';
  const statusRef = useRef<HTMLParagraphElement>(null);
  /** Where focus goes when the control that had it goes away: Mic, always there, or else the status line. */
  const toMic = useCallback((): HTMLElement | null => micRef.current ?? statusRef.current, [micRef]);

  const toggleMic = (): void => {
    if (!feed || micBlocked) {
      return;
    }
    // Inside the click: let the browser play sound first, then the mic (each
    // wants the gesture, iOS especially).
    void feed.resumeAudio();
    void feed.setMic(voice.mic !== 'on');
  };

  const toggleDeafen = (): void => {
    if (feed && voice.available) {
      feed.setDeafened(!voice.deafened);
    }
  };

  // Everyone else the panel can see: who's here only when the feed can see the room.
  const seesRoom = voice.available || status?.kind === 'local';
  const people = voice.people;
  return (
    <aside className={styles.chat} aria-label="People nearby">
      <div className={styles.head}>
        <div className={elsewhere ? styles.elsewhere : styles.srOnly}>
          <p role="status" data-live="elsewhere">
            {elsewhere ? ELSEWHERE : ''}
          </p>
          {elsewhere && (
            <HandOffButton handOff={toMic} onClick={onRejoin}>
              Rejoin here
            </HandOffButton>
          )}
        </div>
        {voice.soundBlocked && (
          <HandOffButton handOff={toMic} className={styles.sound} onClick={() => void feed?.resumeAudio()}>
            Turn on sound
          </HandOffButton>
        )}
        <p
          ref={statusRef}
          tabIndex={-1}
          className={
            line === ''
              ? styles.srOnly
              : cx(styles.status, voice.connection === 'connected' && !voice.soundBlocked && styles.live)
          }
          role="status"
          data-live="status"
        >
          {line}
        </p>
        {(closed || failed) && (
          <HandOffButton handOff={toMic} className={styles.again} onClick={onRejoin}>
            {closed ? 'Rejoin' : 'Try again'}
          </HandOffButton>
        )}
        {voice.available && voice.roomSound !== 'off' && (
          <p className={cx(styles.pill, voice.roomSound === 'failed' && styles.failed)}>
            {voice.roomSound === 'rendering' &&
              (reducedMotion ? (
                'Rendering cave sound…'
              ) : (
                <>
                  <span className={styles.spinner} aria-hidden="true" />
                  Rendering cave sound
                </>
              ))}
            {voice.roomSound === 'live' && 'Cave sound'}
            {voice.roomSound === 'failed' && (
              <>
                Cave sound failed
                <HandOffButton handOff={toMic} onClick={() => feed?.retryRoomSound()}>
                  Retry
                </HandOffButton>
              </>
            )}
          </p>
        )}
        <p className={styles.srOnly} role="status" data-live="room-sound">
          {voice.available && voice.roomSound === 'failed' ? 'Cave sound failed.' : ''}
        </p>
        <div className={styles.controls}>
          <button
            ref={micRef}
            type="button"
            className={cx(styles.mic, micPressed && styles.on, voice.speaking && styles.speaking)}
            aria-pressed={micPressed}
            aria-disabled={micBlocked || undefined}
            onClick={toggleMic}
          >
            <span>{MIC_LABEL[voice.available ? voice.mic : 'off']}</span>
          </button>
          <button
            type="button"
            className={cx(styles.toggle, voice.deafened && styles.on)}
            aria-pressed={voice.deafened}
            aria-disabled={!voice.available || undefined}
            onClick={toggleDeafen}
          >
            Deafen
          </button>
        </div>
        <p className={problem === '' ? styles.srOnly : styles.problem} role="status" data-live="problem">
          {problem}
        </p>
      </div>
      {people.length > 0 ? (
        <PeopleList people={people} canMute={voice.available} feed={feed} handOff={toMic} />
      ) : (
        seesRoom && <p className={styles.empty}>Nobody else is here yet.</p>
      )}
    </aside>
  );
}

/**
 * Everyone else in the room, the part of the panel that scrolls. The order
 * is the feed's (nearest first, joining last), except that it holds still
 * while the pointer is over the list or focus is in it, and for
 * ORDER_HOLD_MS after. On a phone it shows the nearest few, and anyone
 * speaking, until "and N more" opens it up.
 */
function PeopleList({
  people,
  canMute,
  feed,
  handOff,
}: {
  people: Person[];
  canMute: boolean;
  feed: PresenceFeed | null;
  handOff: () => HTMLElement | null;
}) {
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [focusFirstExtra, setFocusFirstExtra] = useState(false);
  const holding = useRef({ pointer: false, focus: false });
  const releaseTimer = useRef<number | undefined>(undefined);

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

  // The list itself going (the last person left) with focus in it: Mic has it next.
  const target = useRef(handOff);
  useLayoutEffect(() => {
    target.current = handOff;
  });
  useLayoutEffect(() => {
    const list = listRef.current;
    return () => {
      if (list !== null && list.contains(document.activeElement)) {
        target.current()?.focus();
      }
    };
  }, []);

  const ordered = frozen === null ? people : holdOrder(people, frozen);
  const shown = phoneRows(ordered);
  const extra = ordered.length - shown.size;

  // Opened up: focus to the first row that was out of sight.
  useEffect(() => {
    if (!focusFirstExtra) {
      return;
    }
    setFocusFirstExtra(false);
    listRef.current?.querySelector<HTMLElement>('li[data-extra] [data-control="level"]')?.focus();
  }, [focusFirstExtra]);

  return (
    <div className={styles.roster}>
      <ul
        ref={listRef}
        id={listId}
        className={styles.list}
        aria-label="People in the lobby"
        tabIndex={-1}
        data-expanded={expanded ? 'true' : undefined}
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
        {ordered.map((person) => (
          <PersonRow
            key={person.id}
            person={person}
            extra={!shown.has(person.id)}
            canMute={canMute}
            onMute={(muted) => feed?.setMuted(person.id, muted)}
          />
        ))}
      </ul>
      {extra > 0 && (
        <HandOffButton
          handOff={() => listRef.current}
          className={styles.more}
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => {
            setExpanded(!expanded);
            if (!expanded) {
              setFocusFirstExtra(true);
            }
          }}
        >
          {expanded ? 'Show fewer' : `and ${extra} more`}
        </HandOffButton>
      )}
    </div>
  );
}

/** `people` in the order of `frozen` (ids), anyone new after them in their own order. */
function holdOrder(people: Person[], frozen: string[]): Person[] {
  const rank = new Map(frozen.map((id, i) => [id, i]));
  return [...people].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

function PersonRow({
  person,
  extra,
  canMute,
  onMute,
}: {
  person: Person;
  extra: boolean;
  canMute: boolean;
  onMute(muted: boolean): void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  // Leaving with focus on one of its controls: the next row's same control
  // has it next, or else the list.
  useLayoutEffect(() => {
    const row = rowRef.current;
    return () => {
      if (row === null || !(document.activeElement instanceof HTMLElement) || !row.contains(document.activeElement)) {
        return;
      }
      const control = document.activeElement.dataset.control;
      const next = row.nextElementSibling;
      const same = control !== undefined && next !== null ? next.querySelector<HTMLElement>(`[data-control="${control}"]`) : null;
      (same ?? (row.parentElement as HTMLElement | null))?.focus();
    };
  }, []);

  const words = stateWords(person);
  return (
    <li
      ref={rowRef}
      className={cx(styles.person, person.speaking && styles.talking, person.distance === null && styles.joining, extra && styles.extra)}
      data-person-id={person.id}
      data-extra={extra ? 'true' : undefined}
    >
      <div className={styles.line}>
        <i aria-hidden="true" style={{ '--near': String(person.nearness) } as CSSProperties} />
        <span className={styles.name} dir="auto" title={person.name}>
          {person.name}
        </span>
        <span className={styles.far}>{person.distance === null ? 'joining' : `${Math.round(person.distance)} m`}</span>
      </div>
      <div className={styles.detail}>
        <Level person={person} />
        {words !== null && <span className={styles.words}>{words}</span>}
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
      </div>
    </li>
  );
}

/**
 * One small bar for what you hear of someone (direct plus reverb), on a
 * button, with their full name and the numbers behind a tooltip: shown on
 * hover or focus, toggled by a tap or a press, and hidden by Escape whether
 * it was hovered or focused. Being a button, Space presses it rather than
 * lifting the camera.
 */
function Level({ person }: { person: Person }) {
  const tipId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  /** Whether the tip was showing when a touch began: the tap that follows toggles it. */
  const touch = useRef<{ wasShown: boolean } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const shown = (hovered || focused) && !dismissed;
  const heard = Math.min(1, person.direct + person.reverb);

  // Shown: placed over the bar (under it, if there's no room above), on the
  // viewport, since the list scrolls and would clip it; kept there as the
  // page or the list scrolls.
  useLayoutEffect(() => {
    if (!shown) {
      return undefined;
    }
    const place = (): void => {
      const button = buttonRef.current;
      const tip = tipRef.current;
      if (button === null || tip === null) {
        return;
      }
      const bar = button.getBoundingClientRect();
      const box = tip.getBoundingClientRect();
      const below = bar.top - 6 - box.height < 8;
      tip.dataset.side = below ? 'below' : 'above';
      tip.style.top = `${below ? bar.bottom + 6 : bar.top - 6 - box.height}px`;
      tip.style.left = `${Math.max(8, Math.min(bar.left, window.innerWidth - box.width - 8))}px`;
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [shown, person.name, person.direct, person.reverb, person.cutoffHz, person.occlusion]);

  // While hovered, Escape anywhere hides it: the keyboard's focus may be elsewhere.
  useEffect(() => {
    if (!hovered) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDismissed(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hovered]);

  return (
    <span
      className={styles.level}
      data-open={shown ? 'true' : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') {
          setHovered(true);
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') {
          setHovered(false);
          setDismissed(false);
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.levelButton}
        aria-describedby={tipId}
        data-control="level"
        onPointerDown={(event) => {
          touch.current = event.pointerType === 'mouse' ? null : { wasShown: shown };
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setDismissed(true);
          }
        }}
        onClick={() => {
          // A tap shows it if it wasn't showing as the finger came down, and hides it if it was; a click or a key press toggles it.
          setDismissed(touch.current !== null ? touch.current.wasShown : shown);
          touch.current = null;
        }}
      >
        <span className={styles.bar} aria-hidden="true">
          <span style={{ width: `${Math.round(heard * 100)}%` }} />
        </span>
        <span className={styles.srOnly}>{`What you hear of ${person.name}`}</span>
      </button>
      <span ref={tipRef} role="tooltip" id={tipId} className={styles.tip}>
        <span className={styles.tipName} dir="auto">
          {person.name}
        </span>{' '}
        <span>{technical(person)}</span>
      </span>
    </span>
  );
}

/** The hint line's range: how far a voice carries in the cave (VOICE.falloffDistance). */
export const VOICE_RANGE_HINT = `Voices carry about ${VOICE.falloffDistance} m`;
