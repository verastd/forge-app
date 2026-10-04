'use client';

/**
 * One task, end to end (PRD I.2, Phase 4): read it, claim it, get your agent
 * on it, watch it, iterate, release.
 *
 * This is Maya's screen, and Maya may never have used git. She signs in,
 * taps Claim, then either lets FORGE start her agent ("Start it for me") or
 * taps her agent and it opens with the task typed in ("Open my agent"). There
 * is nothing to copy: the brief only appears in a closed "Using another
 * agent?" fallback. Afterwards the same screen shows where it is, from the
 * API's status, polled every 15 seconds while the tab is visible.
 *
 * The links and the fallback carry the API's own brief (`TaskDetail.brief`,
 * personalized for the signed-in contributor), so every rail hands over the
 * same text; only the practice app, with nothing behind it, compiles one.
 *
 * Signed out, everything can be browsed and the claim button is "Sign in to
 * claim". The practice app (demo builds) simulates every step locally
 * (`lib/offline.ts`) and says so; its links still open real agents.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeStage, BridgeStatus, CheckResults, RailList, TaskDetail } from '@forge/shared';

import { Chip } from '../Chip';
import { LeaseCountdown } from '../LeaseCountdown';
import { useSession } from '../SessionProvider';
import { useToast } from '../Toast';
import { AgentHandoff, CallbackOutcome } from './AgentHandoff';
import { useContributeFlags } from './ContributeFlags';
import { TaskProgress } from './TaskProgress';
import {
  ConflictError,
  claimTask,
  errorCode,
  failureOf,
  fetchChecks,
  fetchRails,
  fetchStatus,
  fetchTaskDetail,
  mayHaveHappened,
  releaseTask,
} from '../../lib/api';
import { DEMO_IDENTITY, LEASE_HOURS_BY_SIZE } from '../../lib/fixtures';
import { SIZE_LABEL, rewardLabel, tierFloorLabel } from '../../lib/format';
import { describeClaimError, describeTaskError, startedSince } from '../../lib/handoff';
import type { StartOutcome } from '../../lib/handoff';
import { isDemoMode } from '../../lib/mode';

/** How often the status is read while the tab is visible. */
const POLL_MS = 15_000;
/** Failures back off, doubling, up to this. */
const MAX_BACKOFF_MS = 5 * 60_000;
/** After an "Open my agent" click, give the fire-and-forget note a moment before reading the status. */
const AFTER_OPEN_MS = 1500;
/**
 * A `?started=copilot` (which any link can carry) is said only when the
 * status shows FORGE started Copilot on this task this recently.
 */
const STARTED_WINDOW_MS = 10 * 60_000;
/** Claim refusals that are FORGE's rules working, not something going wrong. */
const RULES: ReadonlySet<string> = new Set(['tier_too_low', 'claim_rate_limit']);

/** Stages at which a pull request exists, so its checks are worth reading. */
const CHECKED_STAGES: ReadonlySet<BridgeStage> = new Set(['in_checks', 'in_review', 'shipping', 'shipped']);

interface Lease {
  leaseEndsAt: string;
  leaseHours: number;
  /** The claim only happened on this screen (the practice app). */
  practice: boolean;
}

export function TaskView({
  taskId,
  appSlug,
  outcome,
}: {
  /** NaN when the URL's id is not a task number. */
  taskId: number;
  /** GITHUB_APP_SLUG, for the Copilot rail's install link; null when unset. */
  appSlug: string | null;
  /** What the Copilot callback sent back in the query string, once. */
  outcome: StartOutcome | null;
}) {
  const { session } = useSession();
  const flags = useContributeFlags();
  const toast = useToast();
  const demo = isDemoMode();
  const practice = demo || session?.demo === true;
  const signedIn = session !== null;
  /** The BFF vouches for this visitor, so reads come back personalized. */
  const identified = signedIn && !practice;
  /** The login the links name; the practice account has no fork. */
  const login = session !== null && !session.demo ? session.login : null;
  const validTask = Number.isSafeInteger(taskId) && taskId > 0;

  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(validTask);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [lease, setLease] = useState<Lease | null>(null);
  const [takenBy, setTakenBy] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [rails, setRails] = useState<RailList | null>(null);
  const [railsFailed, setRailsFailed] = useState(false);
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [checks, setChecks] = useState<CheckResults | null>(null);
  const [refresh, setRefresh] = useState(0);
  /** The status said the task isn't yours any more (released elsewhere, or its time ran out). */
  const [lost, setLost] = useState(false);
  /** A claim just landed: keyboard focus goes to the hand-off it opened. */
  const focusHandoff = useRef(false);

  const holding = lease !== null;

  const isMine = useCallback(
    (claimedBy: string): boolean =>
      practice ? claimedBy === DEMO_IDENTITY : login !== null && claimedBy.toLowerCase() === login.toLowerCase(),
    [login, practice],
  );

  // The Copilot callback's outcome is shown once: a reload must not show it again.
  useEffect(() => {
    if (outcome === null) {
      return;
    }
    const url = new URL(window.location.href);
    for (const key of ['started', 'start_error', 'status']) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [outcome]);

  // The task, its criteria, and who holds it.
  useEffect(() => {
    if (!validTask) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void fetchTaskDetail(taskId, identified)
      .then((result) => {
        if (cancelled) {
          return;
        }
        const card = result.data.task;
        setDetail(result.data);
        setTakenBy(null);
        if (card.status === 'claimed' && card.claimedBy !== undefined) {
          if (!isMine(card.claimedBy)) {
            setTakenBy(card.claimedBy);
          } else if (card.leaseEndsAt !== undefined) {
            // Already yours: a reload lands back on the agent step, not on a
            // Claim button that would only bounce.
            setLease({
              leaseEndsAt: card.leaseEndsAt,
              leaseHours: LEASE_HOURS_BY_SIZE[card.size],
              practice: result.degraded,
            });
          }
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        // Live: no task, no Claim button. Offering one against a task we could
        // not read would hand out a lease nobody is holding.
        if (cancelled) {
          return;
        }
        setDetail(null);
        // A task the API doesn't have (any more) is an answer, not a hiccup:
        // the not-found view, with no "Try again" that can never work.
        setFailed(errorCode(error) !== 'task_not_found');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, validTask, identified, isMine, attempt]);

  // Which agents FORGE can start for you, once it's yours.
  useEffect(() => {
    if (!holding) {
      return;
    }
    let cancelled = false;
    void fetchRails(identified)
      .then((result) => {
        if (!cancelled) {
          setRails(result.data);
          setRailsFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRailsFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [holding, identified]);

  // Watch: the status every 15 s while the tab is visible, backing off on failures.
  useEffect(() => {
    if (!holding) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let delay = POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = (): void => {
      timer = undefined;
      if (cancelled || inFlight || document.visibilityState !== 'visible') {
        // Hidden: stop here; becoming visible starts it again.
        return;
      }
      inFlight = true;
      void fetchStatus(taskId, identified)
        .then((result) => {
          if (cancelled) {
            return;
          }
          const { holder } = result.data;
          if (!result.degraded && (holder === undefined || !isMine(holder))) {
            // Not yours any more: released (from another tab, say) or out of
            // time, or someone else's now. Back to "Take it on", and no
            // further polling: the agent sections go with the lease.
            setLease(null);
            setStatus(null);
            setChecks(null);
            setRails(null);
            setTakenBy(holder ?? null);
            setLost(true);
            return;
          }
          setStatus(result.data);
          setStatusFailed(false);
          delay = POLL_MS;
        })
        .catch(() => {
          // Live: the last stage we were told about stays on screen, and it
          // stops being described as current. Nothing advances on its own.
          if (!cancelled) {
            setStatusFailed(true);
            delay = Math.min(delay * 2, MAX_BACKOFF_MS);
          }
        })
        .finally(() => {
          inFlight = false;
          if (!cancelled) {
            timer = setTimeout(tick, delay);
          }
        });
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible' && !inFlight) {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        tick();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [holding, taskId, identified, isMine, refresh]);

  // Once a pull request exists, its checks.
  const wantsChecks = status !== null && (status.prUrl !== undefined || CHECKED_STAGES.has(status.stage));
  useEffect(() => {
    if (!holding || !wantsChecks) {
      return;
    }
    let cancelled = false;
    void fetchChecks(taskId, identified)
      .then((result) => {
        if (!cancelled) {
          setChecks(result.data);
        }
      })
      .catch(() => {
        // The last checks we read stay on screen; the status says the rest.
      });
    return () => {
      cancelled = true;
    };
  }, [holding, wantsChecks, taskId, identified, status]);

  // After a claim, keyboard and screen-reader users land on what it opened.
  useEffect(() => {
    if (lease !== null && focusHandoff.current) {
      focusHandoff.current = false;
      document.getElementById('handoff-title')?.focus();
    }
  }, [lease]);

  const onClaim = useCallback(() => {
    setClaiming(true);
    void claimTask(taskId)
      .then((result) => {
        focusHandoff.current = true;
        setLease({ leaseEndsAt: result.data.leaseEndsAt, leaseHours: result.data.leaseHours, practice: result.degraded });
        setTakenBy(null);
        setLost(false);
        toast.push(
          result.degraded
            ? 'Practice claim only — nothing was saved.'
            : `It's yours for the next ${result.data.leaseHours} hours.`,
          'ok',
        );
      })
      .catch((error: unknown) => {
        if (error instanceof ConflictError && error.code === 'already_claimed') {
          setTakenBy(error.claimedBy ?? 'Someone else');
          toast.push(describeClaimError('already_claimed'), 'warn');
          return;
        }
        if (mayHaveHappened(error)) {
          // No answer is not a "no": the claim may have landed. The task, read
          // again, says whether it is yours.
          toast.push(describeClaimError('upstream_timeout'), 'warn');
          setAttempt((current) => current + 1);
          return;
        }
        // No lease, no countdown, no agents: the claim did not happen and
        // there is nothing anywhere that will finish it later.
        const expected = error instanceof ConflictError || RULES.has(errorCode(error));
        toast.push(describeClaimError(failureOf(error)), expected ? 'warn' : 'danger');
      })
      .finally(() => {
        setClaiming(false);
      });
  }, [taskId, toast]);

  const onRelease = useCallback(async (): Promise<boolean> => {
    try {
      const result = await releaseTask(taskId);
      setLease(null);
      setStatus(null);
      setStatusFailed(false);
      setChecks(null);
      setRails(null);
      toast.push(result.degraded ? 'Practice: released. Nothing was saved.' : 'Released. The task is back on the board.', 'ok');
      setAttempt((current) => current + 1);
      return true;
    } catch (error) {
      if (mayHaveHappened(error)) {
        // No answer is not a "no": the release may have gone through. The
        // status, read again now, says whether the task is still yours.
        toast.push(describeTaskError('upstream_timeout', taskId), 'warn');
        setRefresh((current) => current + 1);
        return false;
      }
      toast.push(describeTaskError(failureOf(error), taskId), 'danger');
      return false;
    }
  }, [taskId, toast]);

  /** Read the status again now (after a start, say), rather than at the next poll. */
  const readStatusNow = useCallback(() => {
    setRefresh((current) => current + 1);
  }, []);

  const onOpened = useCallback(() => {
    setTimeout(readStatusNow, AFTER_OPEN_MS);
  }, [readStatusNow]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  if (loading) {
    return (
      <main className="page">
        <div className="card stack" aria-busy="true">
          <p className="loading-line">
            <span className="spinner" aria-hidden="true" />
            Opening the task…
          </p>
          <div className="skeleton" style={{ width: '55%' }} />
          <div className="skeleton" style={{ width: '80%' }} />
          <div className="skeleton" style={{ width: '35%' }} />
        </div>
      </main>
    );
  }

  if (failed) {
    return (
      <main className="page stack">
        <h1 className="page-title">We can&apos;t open that task just now</h1>
        <div className="card stack" role="alert">
          <p className="muted">
            The details would not load, so there is nothing here to take on yet. Nothing has been
            claimed and nothing has been sent.
          </p>
          <div className="row">
            <button type="button" className="btn" onClick={retry}>
              Try again
            </button>
            <Link href="/contribute" className="btn btn-ghost">
              Back to the task list
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (detail === null) {
    return (
      <main className="page stack">
        <h1 className="page-title">This task doesn&apos;t exist (any more)</h1>
        <p className="muted">It may have shipped already, or the link has a typo in it.</p>
        <p>
          <Link href="/contribute" className="btn">
            Back to the task list
          </Link>
        </p>
      </main>
    );
  }

  const { task, acceptanceCriteria, brief } = detail;
  const reward = rewardLabel(task.rewardClass, task.rewardUsd);
  const signInHref = `/signin?${new URLSearchParams({ next: `/contribute/task/${task.id}` }).toString()}`;
  const startRails = (rails?.rails ?? []).filter((rail) => rail.mode === 'start' && rail.enabled);
  const agentStart = flags?.agent_start === true;
  // Anyone can link here with `?started=copilot`: it is said only when the status backs it up.
  const shownOutcome =
    outcome === null || outcome.kind === 'error'
      ? outcome
      : status !== null && startedSince(status, outcome.rail, Date.now() - STARTED_WINDOW_MS)
        ? outcome
        : null;

  return (
    <main className="page stack-lg">
      <div>
        <Link href="/contribute" className="faint">
          ← All tasks
        </Link>
        <h1 className="page-title" style={{ marginTop: 10 }}>
          {task.civilianSummary}
        </h1>
        <p className="task-title" style={{ marginTop: 6 }}>
          {task.title}
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <Chip>{SIZE_LABEL[task.size]}</Chip>
          {reward !== null && <Chip tone="accent">{reward}</Chip>}
          <Chip>{tierFloorLabel(task.tierFloor)}</Chip>
          {lease !== null && <LeaseCountdown leaseEndsAt={lease.leaseEndsAt} leaseHours={lease.leaseHours} />}
        </div>
      </div>

      <section className="card stack">
        <h2 className="section-title">What done looks like</h2>
        {acceptanceCriteria.length === 0 ? (
          <p className="muted">The details for this one are still being written. Check back shortly.</p>
        ) : (
          <ul className="checklist">
            {acceptanceCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        )}
        <p className="faint">
          Your agent has to satisfy every line before a maintainer ever sees it. The checks decide, not
          us.
        </p>
      </section>

      {lease === null ? (
        <section className="card stack" aria-labelledby="take-title">
          <h2 id="take-title">Take it on</h2>
          {shownOutcome !== null && <CallbackOutcome outcome={shownOutcome} appSlug={appSlug} />}
          {lost && (
            <p className="muted" role="status">
              This task isn&apos;t yours any more: it was released, or its time ran out. Anything your
              agent pushed is still in your fork.
            </p>
          )}
          {takenBy !== null ? (
            <p className="muted">
              {takenBy} is on this one right now. If they run out of time it comes back to the list.
            </p>
          ) : (
            <p className="muted">
              Claiming holds the task for you so nobody doubles up. You can hand it back any time —
              nothing bad happens if you change your mind.
            </p>
          )}
          <div className="row">
            {signedIn ? (
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={onClaim}
                disabled={claiming || takenBy !== null}
                aria-busy={claiming || undefined}
              >
                {claiming && <span className="spinner" aria-hidden="true" />}
                {claiming ? 'Claiming…' : 'Claim this'}
              </button>
            ) : (
              takenBy === null && (
                <Link href={signInHref} className="btn btn-primary btn-lg">
                  Sign in to claim
                </Link>
              )
            )}
            {takenBy !== null && (
              <Link href="/contribute" className="btn btn-ghost">
                Find another
              </Link>
            )}
          </div>
          {!signedIn && takenBy === null && (
            <p className="faint">
              Anyone can look around. Claiming needs you signed in, so FORGE knows whose agent is on it.
            </p>
          )}
        </section>
      ) : (
        <AgentHandoff
          taskId={task.id}
          brief={brief}
          login={login}
          appSlug={appSlug}
          practice={practice || lease.practice}
          agentStart={agentStart}
          connector={flags?.mcp_connector === true}
          startRails={startRails}
          vault={rails?.vault ?? false}
          railsLoaded={rails !== null}
          railsFailed={railsFailed}
          outcome={shownOutcome}
          onStarted={readStatusNow}
          onCheck={readStatusNow}
          onOpened={onOpened}
        />
      )}

      {lease !== null && (
        <TaskProgress
          taskId={task.id}
          status={status}
          statusFailed={statusFailed}
          checks={checks}
          practice={practice || lease.practice}
          onRelease={onRelease}
          onChange={readStatusNow}
        />
      )}
    </main>
  );
}
