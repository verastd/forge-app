'use client';

/**
 * /propose/<id>: one proposal, its whole record, and what you can do about
 * it (Phase 5 contract §4).
 *
 * Top to bottom: the title, state, mover, seconder and the deadline as a
 * countdown; the pitch (plain text, line breaks kept: one longer than a
 * member may write, an admin's, opens with its first 4,000 characters and a
 * button for the rest, `PitchText`); where it stands
 * (consent progress, turnout, the tally after the close, the Contribute task
 * once published); your part, driven by the API's `you` (edit, withdraw,
 * second, consent or object, vote); the admin panel for admins; the debate;
 * the timeline.
 *
 * Reading it: the proposal is read in public first (the API itself), so it
 * shows whatever happens to the sign-in path; signed in with GitHub, the page
 * then asks the BFF what you can do (`you`). If the BFF can't answer, the
 * page stays readable, says "Your actions can't load right now", and offers
 * to try again. Signed out (and, on the build we deploy, for anything but a
 * GitHub session) it is read-only, with "Sign in with GitHub to take part".
 * The practice app walks the practice floor (`lib/proposals-offline.ts`) and
 * says nothing is saved.
 *
 * While open, the page reads the proposal every 60 seconds (when the tab is
 * visible), on coming back to the tab, and right after its deadline passes on
 * the server's clock, which is when the API moves it on. Answers are shown in
 * order (`lib/freshness`): a read that left before a write never puts the old
 * state back. While the API says the floor is paused, a banner says so and the
 * deadline doesn't count down.
 *
 * Writes follow the Contribute rules: a refusal changes nothing on screen and
 * says why in plain words, next to the part it came from, and focus moves to
 * that line. No answer is not a "no": the proposal is read again, and the
 * page says whether the write went through.
 *
 * A signed-in member's own view (with `you`: their part, and an admin's panel
 * with the draft task being written in it) is never traded for the public
 * one: when a read through the BFF fails, the page keeps what it shows and
 * says it may be out of date until a read works again.
 *
 * Phase 6: while the house model drafts a passed proposal's task (an admin's
 * page, `house` queued or running), the page reads the proposal every 5
 * seconds, one read at a time and only while the tab is visible, and stops
 * once it is done, failed or off, or the page is left. After 3 failed reads
 * in a row it reads once a minute, and the house block says so, until one
 * works. The practice app shows its simulated house draft on a card of its
 * own.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { pitchLimit } from '@forge/shared';
import type { DraftTaskRequest, NewProposal, ProposalComment, ProposalState, VoteChoice } from '@forge/shared';

import { Chip } from '../../../components/Chip';
import { useSession } from '../../../components/SessionProvider';
import { formatDate } from '../../../lib/format';
import { Freshness } from '../../../lib/freshness';
import { isDemoMode } from '../../../lib/mode';
import {
  answerConsent,
  castVote,
  closeVoteNow,
  editProposal,
  endDebateNow,
  failureOf,
  loadEarlierComments,
  loadMe,
  loadProposal,
  loadProposalAsMember,
  mayHaveHappened,
  postComment,
  publishDraftTask,
  requestHouseDraft,
  saveDraftTask,
  secondProposal,
  withdrawProposal,
} from '../../../lib/proposals';
import type { DisplayDetail } from '../../../lib/proposals';
import {
  STATE_LABEL,
  STATE_TONE,
  VOTE_LABEL,
  commentsBy,
  consentLine,
  describeProposalError,
  didNotGoThrough,
  houseDraftAsked,
  isActive,
  isHouseWorking,
  mergeComments,
  nextDeadlineRead,
  notReadBack,
  standingLine,
  tallyLines,
  turnoutLine,
  wentThrough,
} from '../../../lib/proposals-format';
import type { Intent, ProposalAction } from '../../../lib/proposals-format';
import { PRACTICE_ME, PRACTICE_NOTE } from '../../../lib/proposals-offline';
import { serverNow } from '../../../lib/server-clock';
import { DeadlineCountdown } from '../Countdown';
import { FloorPaused, Loading, SwitchedOff, useProposalsFlag } from '../gate';
import styles from '../propose.module.css';
import { ActionPanel } from './ActionPanel';
import type { YouState } from './ActionPanel';
import { AdminPanel } from './AdminPanel';
import { PracticeHouse } from './HouseDraft';
import { PitchText } from './PitchText';
import { OUTCOME_ID } from './problem';
import type { Outcome, OutcomePart } from './problem';
import { DebateThread, Timeline } from './Record';

/** How often an open page reads the proposal again, while the tab is visible. */
const POLL_MS = 60_000;
/** While the house model drafts (an admin's page), how often the page reads the proposal again. */
const HOUSE_POLL_MS = 5000;
/** After this many reads through the BFF fail in a row, the house model's reads slow to POLL_MS, and the block says so. */
const HOUSE_POLL_FAILURES = 3;
/** After a deadline, give the API a moment to move the proposal on before reading it. */
const AFTER_DEADLINE_MS = 1500;

/** Refusals that mean the page is behind: read the proposal again so it shows where things stand. */
const STALE: ReadonlySet<string> = new Set([
  'wrong_state',
  'already_seconded',
  'already_decided_consent',
  'not_eligible',
  'not_mover',
  'own_proposal',
  'proposal_changed',
  'edit_limit',
  // "Draft it again": the house block shows that it is drafting, or that it is off.
  'house_busy',
  'house_off',
]);

/** Refusals that may mean the same request already went through (a retry after a lost answer). */
const ALREADY: ReadonlySet<string> = new Set(['already_seconded', 'already_decided_consent']);

const ADMIN_ACTIONS: ReadonlySet<ProposalAction> = new Set(['end_debate', 'close_vote', 'save_draft', 'publish', 'house_draft']);

/** Which part of the page a write's outcome is said in. */
function partOf(action: ProposalAction): OutcomePart {
  if (action === 'comment') return 'debate';
  return ADMIN_ACTIONS.has(action) ? 'admin' : 'part';
}

/** When a write turns out to have gone through already (a retry), what the page says. */
const ALREADY_DONE: Partial<Record<ProposalAction, string>> = {
  second: "You've seconded it already, so debate is open.",
  consent: "You'd already consented.",
  object: "You'd already objected, so it goes to a vote after debate.",
};

type View = 'loading' | 'ready' | 'failed' | 'missing' | 'disabled';

/** Earlier comments a member has opened, kept across re-reads. */
interface Earlier {
  comments: ProposalComment[];
  /** Even older ones exist. */
  more: boolean;
}

export function ProposalView({ proposalId }: { proposalId: number }) {
  const flag = useProposalsFlag();
  const { session, availability } = useSession();
  const signedIn = session !== null;
  const practiceUser = signedIn && (isDemoMode() || session.demo);
  /** A signed-in GitHub member: the BFF says what they can do (`you`). */
  const identified = signedIn && !practiceUser;
  const login = session === null ? null : practiceUser ? PRACTICE_ME : session.login;
  const valid = Number.isSafeInteger(proposalId) && proposalId > 0;

  const [detail, setDetail] = useState<DisplayDetail | null>(null);
  const [practice, setPractice] = useState(false);
  const [view, setView] = useState<View>(valid ? 'loading' : 'missing');
  const [youState, setYouState] = useState<YouState>('none');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<ProposalAction | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [testTimers, setTestTimers] = useState<boolean | null>(null);
  const [meAttempt, setMeAttempt] = useState(0);
  const [earlier, setEarlier] = useState<Earlier | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierProblem, setEarlierProblem] = useState<string | null>(null);
  const lastState = useRef<ProposalState | null>(null);
  const freshness = useRef(new Freshness());
  const shown = useRef<DisplayDetail | null>(null);
  const working = useRef(false);
  /** Reads again under way (`refresh`, and the house model's 5 s reads): those never start on top of one. */
  const reading = useRef(0);
  const focusAfter = useRef<string | null>(null);
  /** Deadlines already read again for, once passed: the 60 s poll covers them from then on. */
  const deadlinesRead = useRef(new Set<string>());
  /** Reads through the BFF that have failed in a row. */
  const failedReads = useRef(0);
  /** HOUSE_POLL_FAILURES of them or more: the house model's reads slow down until one works. */
  const [readsFailing, setReadsFailing] = useState(false);

  /**
   * Put `next` on screen. Once earlier comments are open, the ones the last
   * answer brought stay readable too, however far the newest ones move on.
   */
  const show = useCallback((next: DisplayDetail) => {
    const previous = shown.current;
    shown.current = next;
    if (previous !== null) {
      setEarlier((opened) => (opened === null ? opened : { ...opened, comments: mergeComments(opened.comments, previous.comments) }));
    }
    setDetail(next);
  }, []);

  /**
   * What you can do, from the BFF; null when it failed. A failure leaves the
   * page readable, and a member's own view (`you` on screen) as it is: an
   * answer without `you` (the BFF couldn't vouch for them) is no view to
   * trade it for, so it counts as a failure too.
   */
  const readYou = useCallback(async (): Promise<DisplayDetail | null> => {
    const ticket = freshness.current.read();
    const failed = (): null => {
      failedReads.current += 1;
      if (failedReads.current >= HOUSE_POLL_FAILURES) setReadsFailing(true);
      setYouState('failed');
      return null;
    };
    let data: DisplayDetail;
    try {
      data = await loadProposalAsMember(proposalId);
    } catch {
      return failed();
    }
    if (data.you === undefined && shown.current?.you !== undefined) return failed();
    failedReads.current = 0;
    setReadsFailing(false);
    if (freshness.current.accept(ticket)) show(data);
    setYouState(data.you === undefined ? 'failed' : 'ok');
    return data;
  }, [proposalId, show]);

  // The proposal (and "Try again"): in public first, then your part.
  useEffect(() => {
    if (!valid || !flag.on) {
      return;
    }
    let cancelled = false;
    setView('loading');
    setYouState(identified ? 'loading' : 'none');
    const ticket = freshness.current.read();
    void loadProposal(proposalId, signedIn)
      .then((result) => {
        if (cancelled) return;
        if (freshness.current.accept(ticket)) show(result.data);
        setPractice(result.practice);
        setView('ready');
        if (identified) void readYou();
      })
      .catch(async (error: unknown) => {
        if (cancelled) return;
        const { code } = failureOf(error);
        if (identified && code !== 'proposal_not_found' && code !== 'proposals-disabled') {
          // The API couldn't be read from here, but the BFF may still reach it.
          const member = await readYou();
          if (cancelled) return;
          if (member !== null) {
            setPractice(false);
            setView('ready');
            return;
          }
        }
        // Live: no proposal, no buttons. Nothing is made up in its place.
        shown.current = null;
        setDetail(null);
        setView(code === 'proposal_not_found' ? 'missing' : code === 'proposals-disabled' ? 'disabled' : 'failed');
      });
    return () => {
      cancelled = true;
    };
  }, [proposalId, valid, identified, signedIn, flag.on, attempt, show, readYou]);

  /**
   * Read it again now: through the BFF when signed in (with your part), and in
   * public when that can't answer, unless your own view is on screen: that is
   * never traded for the public one (an admin's unsaved draft would go with
   * it). A failure leaves the last answer on screen. Returns what was read,
   * shown or not, or null when nothing was.
   */
  const refresh = useCallback(async (): Promise<DisplayDetail | null> => {
    reading.current += 1;
    try {
      if (identified) {
        const member = await readYou();
        if (member !== null) return member;
        if (shown.current?.you !== undefined) return null;
      }
      const ticket = freshness.current.read();
      try {
        const result = await loadProposal(proposalId, signedIn);
        if (freshness.current.accept(ticket)) {
          show(result.data);
          setPractice(result.practice);
        }
        return result.data;
      } catch (error: unknown) {
        if (failureOf(error).code === 'proposals-disabled') setView('disabled');
        return null;
      }
    } finally {
      reading.current -= 1;
    }
  }, [identified, proposalId, readYou, show, signedIn]);

  // A state change is said out loud, once.
  const state = detail?.proposal.state ?? null;
  useEffect(() => {
    if (state !== null && lastState.current !== null && lastState.current !== state) {
      setAnnouncement(`This proposal is now: ${STATE_LABEL[state]}.`);
    }
    lastState.current = state;
  }, [state]);

  // After a write, focus moves to the line that says how it went.
  useEffect(() => {
    const id = focusAfter.current;
    if (id === null) return;
    focusAfter.current = null;
    document.getElementById(id)?.focus();
  });

  // Every 60 s while the tab is visible, and on coming back to it. The practice floor only moves when you do.
  // Never on top of a write or another read (one of the house model's 5 s ones, say): the next tick catches up.
  useEffect(() => {
    if (view !== 'ready' || practice) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const free = (): boolean => document.visibilityState === 'visible' && !working.current && reading.current === 0;
    const tick = (): void => {
      if (free()) void refresh();
      timer = setTimeout(tick, POLL_MS);
    };
    const onVisibility = (): void => {
      if (free()) void refresh();
    };
    timer = setTimeout(tick, POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [view, practice, refresh]);

  // While the house model drafts (queued or running), on an admin's page: every 5 s, one read at a time, only
  // while the tab is visible, until it is done, failed or off. Leaving the page or the tab stops it; coming
  // back resumes it. Through the BFF only (the house is an admin's, so the public read has none of it): a read
  // that fails leaves the page as it is, the draft form an admin may be writing in included. After
  // HOUSE_POLL_FAILURES failed reads in a row, once a minute instead, until a read works.
  const isAdmin = detail?.you?.isAdmin === true;
  const houseWorking = detail?.house !== undefined && isHouseWorking(detail.house.status);
  useEffect(() => {
    if (view !== 'ready' || practice || !identified || !isAdmin || !houseWorking) {
      return;
    }
    const every = readsFailing ? POLL_MS : HOUSE_POLL_MS;
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (stopped || inFlight || timer !== undefined || document.visibilityState !== 'visible') return;
      timer = setTimeout(() => {
        timer = undefined;
        void tick();
      }, every);
    };
    const tick = async (): Promise<void> => {
      if (stopped || document.visibilityState !== 'visible') return;
      // Never on top of another read or a write: the next tick tries again.
      if (!working.current && reading.current === 0) {
        inFlight = true;
        reading.current += 1;
        try {
          await readYou();
        } finally {
          reading.current -= 1;
          inFlight = false;
        }
      }
      schedule();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        schedule();
      } else if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [view, practice, identified, isAdmin, houseWorking, readsFailing, readYou]);

  // Right after the deadline, on the server's clock: that is when the API moves it on (on its next read).
  const paused = detail?.floorPaused === true;
  useEffect(() => {
    if (practice || paused || detail === null || !isActive(detail.proposal.state)) {
      return;
    }
    const next = nextDeadlineRead([detail.proposal.deadline], serverNow(), deadlinesRead.current, POLL_MS);
    if (next === null || next.waitMs > 2 ** 31 - 1 - AFTER_DEADLINE_MS) {
      return;
    }
    const timer = setTimeout(() => {
      if (Date.parse(next.deadline) <= serverNow()) deadlinesRead.current.add(next.deadline);
      void refresh();
    }, next.waitMs + AFTER_DEADLINE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [detail, practice, paused, refresh]);

  // An admin's panel needs to know whether Test timers are on: the API takes its test tools only then.
  useEffect(() => {
    if (!isAdmin || practice) {
      return;
    }
    let cancelled = false;
    void loadMe()
      .then((me) => {
        if (!cancelled) setTestTimers(me.testTimers);
      })
      .catch(() => {
        if (!cancelled) setTestTimers(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, practice, meAttempt]);

  const say = useCallback(
    (action: ProposalAction, tone: Outcome['tone'], message: string, proposalId?: number) => {
      setOutcome({
        action,
        tone,
        message: tone === 'ok' && practice ? `${message} ${PRACTICE_NOTE}` : message,
        ...(proposalId === undefined ? {} : { proposalId }),
      });
    },
    [practice],
  );

  /**
   * One write: busy while it runs, the proposal as the API now has it after,
   * what it came to in words beside the part it came from (focus moves
   * there), and a read again whenever the page may be behind. When no answer
   * came back, or the API says it was done already, the proposal read back
   * says whether it went through.
   */
  const act = useCallback(
    async (
      intent: Intent,
      run: () => Promise<DisplayDetail | null>,
      success: (after: DisplayDetail | null) => string,
      unsure?: (after: DisplayDetail) => string,
    ): Promise<boolean> => {
      const { action } = intent;
      if (working.current) return false;
      working.current = true;
      setBusy(action);
      setOutcome(null);
      freshness.current.writeStarted();
      let answered: DisplayDetail | null = null;
      let failed: unknown = null;
      try {
        answered = await run();
      } catch (error) {
        failed = error;
      }
      const ticket = freshness.current.writeEnded();
      try {
        if (failed === null) {
          if (answered !== null && freshness.current.acceptWrite(ticket)) show(answered);
          const after = answered ?? (await refresh());
          say(action, 'ok', success(after));
          return true;
        }
        const failure = failureOf(failed);
        if (mayHaveHappened(failed)) {
          const after = await refresh();
          if (after === null) {
            // The read back failed too: the page still shows what it did, so it can't say yet.
            say(action, 'problem', notReadBack());
            return false;
          }
          const went = wentThrough(intent, after, login);
          if (went === true) {
            say(action, 'ok', unsure === undefined ? success(after) : unsure(after));
            return true;
          }
          say(action, 'problem', went === false ? didNotGoThrough(action) : describeProposalError('upstream_timeout', action));
          return false;
        }
        if (STALE.has(failure.code)) {
          const after = await refresh();
          if (ALREADY.has(failure.code) && after !== null && wentThrough(intent, after, login) === true) {
            say(action, 'ok', ALREADY_DONE[action] ?? success(after));
            return true;
          }
        }
        if (failure.code === 'test_mode_off') setMeAttempt((current) => current + 1);
        // A refusal naming the pitch gives the reader's own limit: an admin's is longer.
        const pitchMax = pitchLimit(shown.current?.you?.isAdmin === true);
        say(action, 'problem', describeProposalError(failure, action, pitchMax), failure.proposalId);
        return false;
      } finally {
        working.current = false;
        setBusy(null);
        focusAfter.current = OUTCOME_ID[partOf(action)];
      }
    },
    [login, refresh, say, show],
  );

  const onSecond = useCallback(() => {
    void act(
      { action: 'second' },
      () => secondProposal(proposalId, shown.current?.revision ?? 1),
      () => 'You seconded it. Debate is open.',
    );
  }, [act, proposalId]);

  const onConsent = useCallback(
    () =>
      act(
        { action: 'consent' },
        () => answerConsent(proposalId, true),
        (after) =>
          after?.proposal.state === 'passed' ? 'You consented, and with that everyone has: it passed.' : 'You consented.',
      ),
    [act, proposalId],
  );

  const onObject = useCallback(
    async (reason: string): Promise<boolean> => {
      // The objection first (it is what counts), then its reason as a comment.
      let reasonFailed: unknown = null;
      const done = await act(
        { action: 'object' },
        async () => {
          const objected = await answerConsent(proposalId, false);
          try {
            return (await postComment(proposalId, reason)) ?? objected;
          } catch (error) {
            reasonFailed = error;
            return objected;
          }
        },
        () => 'You objected. It goes to a vote after debate.',
        () => "Your objection went through, but its reason wasn't posted: add it in the debate below.",
      );
      if (done && reasonFailed !== null) {
        say(
          'object',
          'problem',
          `Your objection counts, but your reason wasn't posted. ${describeProposalError(failureOf(reasonFailed), 'comment')}`,
        );
      }
      return done;
    },
    [act, proposalId, say],
  );

  const onVote = useCallback(
    (choice: VoteChoice) => {
      void act(
        { action: 'vote', choice },
        () => castVote(proposalId, choice),
        () => `Your vote is in: ${VOTE_LABEL[choice]}. You can change it until the vote closes.`,
      );
    },
    [act, proposalId],
  );

  const onComment = useCallback(
    (text: string) =>
      act(
        { action: 'comment', text, postedBefore: commentsBy(shown.current?.comments ?? [], login, text) },
        () => postComment(proposalId, text),
        () => 'Your comment is posted.',
      ),
    [act, login, proposalId],
  );

  const onEdit = useCallback(
    (proposal: NewProposal) =>
      act(
        { action: 'edit', title: proposal.title, pitch: proposal.pitch },
        () => editProposal(proposalId, proposal),
        () => 'Saved. The floor sees your changes.',
      ),
    [act, proposalId],
  );

  const onWithdraw = useCallback(
    () =>
      act(
        { action: 'withdraw' },
        () => withdrawProposal(proposalId),
        () => 'Withdrawn. It keeps its record, and you can bring another.',
      ),
    [act, proposalId],
  );

  const onEndDebate = useCallback(
    () =>
      act(
        { action: 'end_debate' },
        () => endDebateNow(proposalId),
        (after) =>
          after?.proposal.state === 'voting'
            ? 'Debate ended. Voting is open.'
            : after?.proposal.state === 'passed'
              ? 'Debate ended with no objection, so it passed.'
              : 'Debate ended.',
      ),
    [act, proposalId],
  );

  const onCloseVote = useCallback(
    () => act({ action: 'close_vote' }, () => closeVoteNow(proposalId), () => 'The vote is closed and counted.'),
    [act, proposalId],
  );

  const onSaveDraft = useCallback(
    (draft: DraftTaskRequest) =>
      act({ action: 'save_draft', draft }, () => saveDraftTask(proposalId, draft), () => 'Draft saved.'),
    [act, proposalId],
  );

  const onPublish = useCallback(
    (draft: DraftTaskRequest) =>
      act(
        { action: 'publish' },
        async () => {
          // What is on screen is what gets published: save it first.
          await saveDraftTask(proposalId, draft);
          return publishDraftTask(proposalId);
        },
        (after) => {
          const taskId = after?.taskId ?? after?.draft?.taskId;
          return taskId === undefined
            ? 'Published to the Contribute board.'
            : `Published: it's task #${taskId} on the Contribute board.`;
        },
      ),
    [act, proposalId],
  );

  const onHouseDraft = useCallback(() => {
    // The house as it was when asked: if the answer is lost, any change to it in the read back means it went through.
    const house = shown.current?.house;
    const hadDraft = house?.spec !== undefined;
    return act(
      {
        action: 'house_draft',
        before: house === undefined ? undefined : { status: house.status, reason: house.reason, draftedAt: house.draftedAt },
      },
      async () => {
        // The API answers with the house's new state (queued): shown in place, with the rest as it was.
        const asked = await requestHouseDraft(proposalId);
        const current = shown.current;
        return asked === null || current === null ? null : { ...current, house: asked };
      },
      (after) => houseDraftAsked(hadDraft, after?.house),
      (after) => houseDraftAsked(hadDraft, after.house),
    );
  }, [act, proposalId]);

  const onShowEarlier = useCallback(() => {
    const current = shown.current;
    if (loadingEarlier || current === null) return;
    const thread = earlier === null ? current.comments : mergeComments(earlier.comments, current.comments);
    const oldest = thread[0];
    if (oldest === undefined) return;
    setLoadingEarlier(true);
    setEarlierProblem(null);
    void loadEarlierComments(proposalId, oldest.id)
      .then((page) => {
        setEarlier((opened) => ({ comments: mergeComments(page.comments, opened?.comments ?? []), more: page.moreComments }));
        const first = page.comments[0];
        if (first !== undefined) focusAfter.current = `comment-${first.id}`;
      })
      .catch((error: unknown) => {
        setEarlierProblem(describeProposalError(failureOf(error), 'load'));
      })
      .finally(() => {
        setLoadingEarlier(false);
      });
  }, [earlier, loadingEarlier, proposalId]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const retryYou = useCallback(() => {
    setYouState('loading');
    void readYou();
  }, [readYou]);

  if (!flag.loading && !flag.on) {
    return (
      <main className="page stack-lg">
        <h1 className="page-title">Propose</h1>
        <SwitchedOff />
      </main>
    );
  }

  if (flag.loading || view === 'loading') {
    return (
      <main className="page">
        <Loading text="Opening the proposal…" />
      </main>
    );
  }

  if (view === 'disabled') {
    return (
      <main className="page stack-lg">
        <h1 className="page-title">Propose</h1>
        <SwitchedOff />
      </main>
    );
  }

  if (view === 'failed') {
    return (
      <main className="page stack">
        <h1 className="page-title">We can&apos;t open that proposal just now</h1>
        <div className="card stack" role="alert">
          <p className="muted">The proposal would not load, so there is nothing to act on yet. Nothing has changed.</p>
          <div className="row">
            <button type="button" className="btn" onClick={retry}>
              Try again
            </button>
            <Link href="/propose" className="btn btn-ghost">
              Back to the floor
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (view === 'missing' || detail === null) {
    return (
      <main className="page stack">
        <h1 className="page-title">That proposal isn&apos;t here</h1>
        <p className="muted">The link may have a typo in it.</p>
        <p>
          <Link href="/propose" className="btn">
            Back to the floor
          </Link>
        </p>
      </main>
    );
  }

  const { proposal } = detail;
  const consent = consentLine(detail);
  const turnout = turnoutLine(detail);
  const tally = detail.tally === undefined ? null : tallyLines(detail.tally);
  const taskId = detail.taskId ?? detail.draft?.taskId;
  const outcomeIn = (part: OutcomePart): Outcome | null =>
    outcome !== null && partOf(outcome.action) === part ? outcome : null;
  const thread = earlier === null ? detail.comments : mergeComments(earlier.comments, detail.comments);
  const moreComments = earlier === null ? detail.moreComments === true : earlier.more;
  // The practice floor simulates the house model; with its flag off, the practice app shows none of it.
  const events = practice && !flag.house ? detail.events.filter((entry) => entry.kind !== 'house_drafted') : detail.events;
  // Your own view is on screen, but the last read of it through the BFF failed: it stays, and says so.
  const stale = detail.you !== undefined && youState === 'failed';

  return (
    <main className="page stack-lg">
      <div>
        <Link href="/propose" className="faint">
          ← All proposals
        </Link>
        <h1 className={`page-title ${styles.title}`} style={{ marginTop: 10 }}>
          {proposal.title}
        </h1>
        <div className={`row ${styles.meta}`}>
          <Chip tone={STATE_TONE[proposal.state]}>{STATE_LABEL[proposal.state]}</Chip>
          <span className="faint">
            Moved by <strong>{proposal.mover}</strong> on {formatDate(proposal.movedAt)}
          </span>
          {proposal.seconder !== undefined && (
            <span className="faint">
              Seconded by <strong>{proposal.seconder}</strong>
            </span>
          )}
        </div>
        {isActive(proposal.state) && proposal.deadline !== undefined && (
          <p className={styles.deadline}>
            <DeadlineCountdown state={proposal.state} deadline={proposal.deadline} paused={paused} announce />
          </p>
        )}
        <p className="visually-hidden" aria-live="polite">
          {announcement}
        </p>
      </div>

      {practice && <p className="demo-banner">{PRACTICE_NOTE} This sample lives in this tab only.</p>}
      {paused && <FloorPaused />}
      {/* Always on the page (empty and out of sight until needed), so a screen reader hears it when it fills. */}
      <p id="view-stale" aria-live="polite" className={stale ? styles.staleView : 'visually-hidden'}>
        {stale ? "Couldn't refresh your view just now. What you see may be out of date; it tries again shortly." : ''}
      </p>

      <section className="card stack" aria-labelledby="pitch-title">
        <h2 id="pitch-title" className="section-title">
          The pitch
        </h2>
        <PitchText pitch={detail.pitch} />
      </section>

      <section className="card stack" aria-labelledby="standing-title">
        <h2 id="standing-title" className="section-title">
          Where it stands
        </h2>
        <div className="stack" aria-live="polite">
          <p>{standingLine(detail)}</p>
          {consent !== null && <p className={styles.progress}>{consent}</p>}
          {turnout !== null && (
            <>
              <p className={styles.progress}>{turnout}</p>
              <p className="faint">The totals stay hidden until the vote closes.</p>
            </>
          )}
          {tally !== null && (
            <div className={styles.tally}>
              <p className={styles.tallyCounts}>{tally.counts}</p>
              <p className="faint">{tally.quorum}</p>
              <p>{tally.result}</p>
            </div>
          )}
          {taskId !== undefined && (
            <p>
              <Link href={`/contribute/task/${taskId}`} className={styles.inlineLink}>
                See the task on the Contribute board
              </Link>
            </p>
          )}
        </div>
      </section>

      <ActionPanel
        detail={detail}
        login={login}
        signedIn={signedIn}
        practice={practice}
        availability={availability}
        youState={youState}
        onRetryYou={retryYou}
        busy={busy}
        outcome={outcomeIn('part')}
        onEdit={onEdit}
        onWithdraw={onWithdraw}
        onSecond={onSecond}
        onConsent={onConsent}
        onObject={onObject}
        onVote={onVote}
      />

      {isAdmin && (
        <AdminPanel
          detail={detail}
          testTimers={testTimers}
          busy={busy}
          outcome={outcomeIn('admin')}
          houseUnchecked={readsFailing}
          onEndDebate={onEndDebate}
          onCloseVote={onCloseVote}
          onSaveDraft={onSaveDraft}
          onPublish={onPublish}
          onHouseDraft={onHouseDraft}
        />
      )}

      {/* The practice app has no admins: its simulated house draft gets a card of its own, while the flag is on. */}
      {practice && !isAdmin && flag.house && detail.house !== undefined && <PracticeHouse house={detail.house} />}

      <DebateThread
        detail={detail}
        thread={thread}
        moreComments={moreComments}
        loadingEarlier={loadingEarlier}
        earlierProblem={earlierProblem}
        onShowEarlier={onShowEarlier}
        busy={busy}
        outcome={outcomeIn('debate')}
        onComment={onComment}
      />

      <Timeline events={events} />
    </main>
  );
}
