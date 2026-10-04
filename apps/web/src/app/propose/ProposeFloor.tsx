'use client';

/**
 * /propose, the floor (Phase 5 contract §4): every proposal in four sections
 * (Needs a second, In debate, Voting, Decided), the way in for a member who
 * wants to bring one, the test-timers banner and, for admins, its switch.
 * The rules sit collapsed at the bottom, under "How proposals work".
 *
 * Anyone can read it. Signed out, "Bring a proposal" is "Sign in to bring a
 * proposal"; a member with a proposal still on the floor is pointed at it
 * instead (one active proposal per person). The practice app shows the
 * practice floor (`lib/proposals-offline.ts`) and says nothing is saved; its
 * practice account can try the form, which then refuses it.
 *
 * The list stays current while it is open: it is read again every 30 seconds
 * while the tab is visible, on coming back to the tab, and right after any
 * card's deadline passes (on the server's clock), which is when the API moves
 * that proposal on. A re-read that fails keeps the last list, and one that
 * left before a newer one landed is dropped. The API lists every active
 * proposal and the newest decided ones; "Show earlier decided proposals"
 * pages back through the rest. While the API says the floor is paused, a
 * banner says so and no deadline counts down.
 *
 * The heading and lede render in every state, first: arriving from the
 * lobby moves focus to the page's h1 (`SiteChrome`), and `?slot=` puts its
 * line straight after them.
 */

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ProposalMe } from '@forge/shared';

import { useSession } from '../../components/SessionProvider';
import { useToast } from '../../components/Toast';
import { ProposeSlotNote } from '../../components/lobby/ProposeSlotNote';
import { Freshness } from '../../lib/freshness';
import { isDemoMode } from '../../lib/mode';
import { failureOf, loadMe, loadProposals, switchTestTimers } from '../../lib/proposals';
import {
  FLOOR_SECTIONS,
  SECTION_EMPTY,
  SECTION_TITLE,
  decidedCursor,
  describeProposalError,
  floorCards,
  floorHasMore,
  foldFloor,
  groupBySection,
  isActive,
  nextDeadlineRead,
  signInHref,
} from '../../lib/proposals-format';
import { PRACTICE_NOTE } from '../../lib/proposals-offline';
import { serverNow } from '../../lib/server-clock';
import { HowProposalsWork } from './HowProposalsWork';
import { ProposalTile } from './ProposalTile';
import { FloorPaused, Loading, SwitchedOff, useProposalsFlag } from './gate';
import styles from './propose.module.css';

/** How often an open floor reads the list again, while the tab is visible. */
const POLL_MS = 30_000;
/** After a deadline, give the API a moment to move the proposal on before reading again. */
const AFTER_DEADLINE_MS = 1500;

type ListState = 'loading' | 'ready' | 'failed' | 'disabled';

export function ProposeFloor() {
  const flag = useProposalsFlag();
  const { session, availability } = useSession();
  const toast = useToast();
  const demo = isDemoMode();
  const practiceUser = session !== null && (demo || session.demo);
  /** A signed-in GitHub member: the BFF can vouch for them. */
  const identified = session !== null && !practiceUser;

  const [floor, dispatch] = useReducer(foldFloor, null);
  const [practice, setPractice] = useState(false);
  const [listState, setListState] = useState<ListState>('loading');
  const [stale, setStale] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [me, setMe] = useState<ProposalMe | null>(null);
  const [meFailed, setMeFailed] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderProblem, setOlderProblem] = useState<string | null>(null);
  const freshness = useRef(new Freshness());
  /** Deadlines already read again for, once passed: the 30 s poll covers them from then on. */
  const deadlinesRead = useRef(new Set<string>());
  const focusCard = useRef<number | null>(null);

  /** Read the first page. A failure keeps what is on screen; the first one says so. */
  const readFloor = useCallback(async (): Promise<void> => {
    const ticket = freshness.current.read();
    try {
      const result = await loadProposals();
      if (!freshness.current.accept(ticket)) return;
      dispatch({ kind: 'first', list: result.data });
      setPractice(result.practice);
      setStale(false);
      setListState('ready');
    } catch (error: unknown) {
      const disabled = failureOf(error).code === 'proposals-disabled';
      setListState((current) => (disabled ? 'disabled' : current === 'ready' ? current : 'failed'));
      setStale(true);
    }
  }, []);

  // The list (and "Try again").
  useEffect(() => {
    if (!flag.on) {
      return;
    }
    setListState('loading');
    void readFloor();
  }, [flag.on, attempt, readFloor]);

  useEffect(() => {
    if (!flag.on || !identified) {
      return;
    }
    let cancelled = false;
    setMeFailed(false);
    void loadMe()
      .then((result) => {
        if (!cancelled) setMe(result);
      })
      .catch(() => {
        // "Bring a proposal" still shows: the API enforces one at a time, and the form checks again.
        if (!cancelled) setMeFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [flag.on, identified, attempt]);

  // Every 30 s while the tab is visible, and on coming back to it. The practice floor only moves when you do.
  useEffect(() => {
    if (listState !== 'ready' || practice) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      if (document.visibilityState === 'visible') void readFloor();
      timer = setTimeout(tick, POLL_MS);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void readFloor();
    };
    timer = setTimeout(tick, POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [listState, practice, readFloor]);

  const cards = useMemo(() => (floor === null ? [] : floorCards(floor)), [floor]);
  const paused = floor?.first.floorPaused === true;

  // Right after the next card's deadline: that is when the API moves it on (on its next read).
  useEffect(() => {
    if (listState !== 'ready' || practice || paused) {
      return;
    }
    const next = nextDeadlineRead(
      cards.filter((card) => isActive(card.state)).map((card) => card.deadline),
      serverNow(),
      deadlinesRead.current,
      POLL_MS,
    );
    if (next === null || next.waitMs > 2 ** 31 - 1 - AFTER_DEADLINE_MS) {
      return;
    }
    const timer = setTimeout(() => {
      if (Date.parse(next.deadline) <= serverNow()) deadlinesRead.current.add(next.deadline);
      void readFloor();
    }, next.waitMs + AFTER_DEADLINE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [cards, listState, practice, paused, readFloor]);

  // After "Show earlier", the first card it added takes focus.
  useEffect(() => {
    const id = focusCard.current;
    if (id === null) return;
    focusCard.current = null;
    document.getElementById(`motion-${id}`)?.focus();
  });

  const groups = useMemo(() => groupBySection(cards), [cards]);
  const testTimers = me?.testTimers ?? floor?.first.testTimers ?? false;
  const moreDecided = floor !== null && floorHasMore(floor);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const showEarlier = useCallback(() => {
    const cursor = decidedCursor(cards);
    if (loadingOlder || cursor === null) return;
    setLoadingOlder(true);
    setOlderProblem(null);
    void loadProposals(cursor)
      .then((result) => {
        const shown = new Set(cards.map((card) => card.id));
        const added = result.data.proposals.filter((card) => !shown.has(card.id));
        dispatch({ kind: 'older', page: result.data });
        focusCard.current = added[0]?.id ?? null;
      })
      .catch((error: unknown) => {
        setOlderProblem(describeProposalError(failureOf(error), 'load'));
      })
      .finally(() => {
        setLoadingOlder(false);
      });
  }, [cards, loadingOlder]);

  const toggleTimers = useCallback(() => {
    if (switching) return;
    const next = !testTimers;
    setSwitching(true);
    void switchTestTimers(next)
      .then((value) => {
        const now = value ?? next;
        setMe((current) => (current === null ? current : { ...current, testTimers: now }));
        toast.push(
          now
            ? 'Test timers are on. Deadlines set from now on are minutes, not days.'
            : "Test timers are off. Deadlines set from now on are the pilot's days.",
          'ok',
        );
        void readFloor();
      })
      .catch((error: unknown) => {
        toast.push(describeProposalError(failureOf(error), 'settings'), 'danger');
        // Whatever happened, show the switch as the API now has it.
        setAttempt((current) => current + 1);
      })
      .finally(() => {
        setSwitching(false);
      });
  }, [readFloor, switching, testTimers, toast]);

  const off = !flag.loading && (!flag.on || listState === 'disabled');

  return (
    <main className="page stack-lg">
      <div>
        <h1 className="page-title">Propose</h1>
        <p className="lede">
          Where FORGE decides what to build next. A member brings an idea, another seconds it, and the floor
          decides it together, in the open.
        </p>
      </div>
      {!off && (
        <Suspense fallback={null}>
          <ProposeSlotNote />
        </Suspense>
      )}

      {flag.loading ? (
        <Loading text="Opening the floor…" />
      ) : off ? (
        <SwitchedOff />
      ) : (
        <>
          {practice && (
            <p className="demo-banner">{PRACTICE_NOTE} These sample proposals live in this tab only.</p>
          )}
          {paused && <FloorPaused />}
          {testTimers && (
            <p className={styles.timersBanner} role="note">
              Test timers are on: deadlines are minutes, not days.
            </p>
          )}

          <BringAProposal
            signedIn={session !== null}
            offered={availability !== 'unavailable'}
            practiceUser={practiceUser}
            me={me}
            meSettled={!identified || me !== null || meFailed}
          />

          {me?.isAdmin === true && (
            <div className={styles.adminSwitch}>
              <button
                type="button"
                role="switch"
                aria-checked={testTimers}
                aria-describedby="test-timers-help"
                className={styles.switch}
                aria-disabled={switching || undefined}
                aria-busy={switching || undefined}
                onClick={toggleTimers}
              >
                <span className={styles.switchTrack} aria-hidden="true">
                  <span className={styles.switchThumb} />
                </span>
                Test timers
              </button>
              <p id="test-timers-help" className="faint">
                Admins only. On, deadlines set from now on are minutes, not days: 10 minutes to find a
                second, 5 of debate, 5 of voting. Deadlines already running keep theirs. &ldquo;End debate
                now&rdquo; and &ldquo;Close the vote now&rdquo; work only while it is on.
              </p>
            </div>
          )}

          {listState === 'loading' ? (
            <Loading text="Loading the floor…" />
          ) : listState === 'failed' || floor === null ? (
            <div className="card stack" role="alert">
              <h2 className="section-title">We can&apos;t show the proposals just now</h2>
              <p className="muted">
                The floor would not load, so we are not showing you one. Nothing on your side has gone wrong.
              </p>
              <div className="row">
                <button type="button" className="btn" onClick={retry}>
                  Try again
                </button>
              </div>
            </div>
          ) : (
            <>
              {stale && <p className="faint">This list may be out of date: the last update failed.</p>}
              {FLOOR_SECTIONS.map((section) => (
                <section key={section} className="stack" aria-labelledby={`floor-${section}`}>
                  <div className={styles.sectionHead}>
                    <h2 id={`floor-${section}`} className="section-title">
                      {SECTION_TITLE[section]}
                    </h2>
                    <span className={styles.count} aria-hidden="true">
                      {groups[section].length}
                    </span>
                  </div>
                  {groups[section].length === 0 ? (
                    <p className="faint">{SECTION_EMPTY[section]}</p>
                  ) : (
                    <ul className={styles.tiles}>
                      {groups[section].map((card) => (
                        <li key={card.id}>
                          <ProposalTile card={card} paused={paused} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {section === 'decided' && moreDecided && (
                    <div className={styles.more}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={showEarlier}
                        aria-disabled={loadingOlder || undefined}
                        aria-busy={loadingOlder || undefined}
                      >
                        {loadingOlder && <span className="spinner" aria-hidden="true" />}
                        {loadingOlder ? 'Loading earlier proposals…' : 'Show earlier decided proposals'}
                      </button>
                      {olderProblem !== null && (
                        <p className={styles.problem} role="alert">
                          {olderProblem}
                        </p>
                      )}
                    </div>
                  )}
                </section>
              ))}
            </>
          )}

          <HowProposalsWork />
        </>
      )}
    </main>
  );
}

/** "Bring a proposal", or what stands in its way. */
function BringAProposal({
  signedIn,
  offered,
  practiceUser,
  me,
  meSettled,
}: {
  signedIn: boolean;
  /** Sign-in is offered on this server. */
  offered: boolean;
  practiceUser: boolean;
  me: ProposalMe | null;
  meSettled: boolean;
}) {
  if (!signedIn) {
    return offered ? (
      <div className="row">
        <Link href={signInHref('/propose/new')} className="btn btn-primary btn-lg">
          Sign in to bring a proposal
        </Link>
        <span className="faint">Anyone can read the floor. Bringing, seconding and voting need you signed in.</span>
      </div>
    ) : (
      <p className="muted">Bringing a proposal needs you signed in, and sign-in isn&apos;t available here right now.</p>
    );
  }
  if (practiceUser) {
    return (
      <div className="row">
        <Link href="/propose/new" className="btn btn-primary btn-lg">
          Bring a proposal
        </Link>
        <span className="faint">
          Practice: you can try the form, but only a GitHub member can put a proposal on the floor. To walk one
          through, second the sample that needs a second, then consent.
        </span>
      </div>
    );
  }
  if (!meSettled) {
    return null;
  }
  if (me?.activeProposalId !== undefined) {
    return (
      <div className={styles.onFloor}>
        <p>
          <strong>You have a proposal on the floor.</strong> Once it&apos;s decided, you can bring another.
        </p>
        <Link href={`/propose/${me.activeProposalId}`} className="btn">
          See your proposal
        </Link>
      </div>
    );
  }
  return (
    <div className="row">
      <Link href="/propose/new" className="btn btn-primary btn-lg">
        Bring a proposal
      </Link>
      <span className="faint">One at a time: once yours is decided, you can bring another.</span>
    </div>
  );
}
