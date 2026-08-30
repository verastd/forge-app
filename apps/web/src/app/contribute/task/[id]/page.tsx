'use client';

/**
 * One task, end to end: Claim → Dispatch → Watch → Iterate (PRD I.2).
 *
 * This is Maya's screen. She taps Claim, taps her agent, and comes back to a
 * status line she can read. Nothing here says fork, branch, PR or CI — the only
 * place that vocabulary appears is inside the compiled prompt, which is
 * addressed to her agent, not to her.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BridgeStatus, ClaimResponse, DispatchResult, Rail, TaskCard } from '@forge/shared';

import { Chip } from '../../../../components/Chip';
import { CopyBox } from '../../../../components/CopyBox';
import { HandoffModal } from '../../../../components/HandoffModal';
import { LeaseCountdown } from '../../../../components/LeaseCountdown';
import { RailPicker } from '../../../../components/RailPicker';
import { StatusStepper } from '../../../../components/StatusStepper';
import { useToast } from '../../../../components/Toast';
import {
  ConflictError,
  claimTask,
  dispatchTask,
  fetchStatus,
  fetchTasks,
  noteExistingLease,
  sendFeedback,
} from '../../../../lib/api';
import { LEASE_HOURS_BY_SIZE, findTaskFixture } from '../../../../lib/fixtures';
import { SIZE_LABEL, rewardLabel, tierFloorLabel } from '../../../../lib/format';
import { RAIL_INFO } from '../../../../lib/rails';

const STATUS_POLL_MS = 10_000;

interface Dispatched {
  rail: Rail;
  result: DispatchResult;
  preview: boolean;
}

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const taskId = Number(params?.id ?? NaN);

  const toast = useToast();

  const [task, setTask] = useState<TaskCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [claim, setClaim] = useState<ClaimResponse | null>(null);
  const [claimPreview, setClaimPreview] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [takenBy, setTakenBy] = useState<string | null>(null);
  const [dispatched, setDispatched] = useState<Dispatched | null>(null);
  const [busyRail, setBusyRail] = useState<Rail | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [relayedPrompt, setRelayedPrompt] = useState<string | null>(null);
  const [relaying, setRelaying] = useState(false);

  /**
   * Acceptance criteria are a spec detail, not a card field — they live in the
   * local mirror of the task list. Shown only when the card the server sent is
   * demonstrably the same task the mirror describes: a matching id alone would
   * let a real task inherit a fixture's criteria and call them its own.
   */
  const fixture = useMemo(
    () => (Number.isNaN(taskId) ? undefined : findTaskFixture(taskId)),
    [taskId],
  );

  useEffect(() => {
    if (Number.isNaN(taskId)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void fetchTasks()
      .then((result) => {
        if (cancelled) {
          return;
        }
        const found = result.data.find((candidate) => candidate.id === taskId) ?? null;
        setTask(found);
        if (found?.status === 'claimed' && found.claimedBy !== undefined) {
          if (found.claimedBy === 'you' && found.leaseEndsAt !== undefined) {
            // Already yours — a reload should land back on the agent step, not
            // on a Claim button that would only bounce off a conflict.
            const leaseHours = LEASE_HOURS_BY_SIZE[found.size];
            noteExistingLease(found.id, found.leaseEndsAt, leaseHours);
            setClaim({
              taskId: found.id,
              claimedBy: found.claimedBy,
              leaseEndsAt: found.leaseEndsAt,
              leaseHours,
            });
          } else if (found.claimedBy !== 'you') {
            setTakenBy(found.claimedBy);
          }
        }
        setLoading(false);
      })
      .catch(() => {
        // Live: no task, no Claim button. Offering one against a task we could
        // not read would hand out a lease nobody is holding.
        if (cancelled) {
          return;
        }
        setTask(null);
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, attempt]);

  // Watch (PRD I.2): once it's yours, poll the translated status.
  useEffect(() => {
    if (claim === null) {
      return;
    }
    let cancelled = false;
    const poll = () => {
      void fetchStatus(claim.taskId)
        .then((result) => {
          if (!cancelled) {
            setStatus(result.data);
            setStatusFailed(false);
          }
        })
        .catch(() => {
          // Live: the last stage we were told about stays on screen, and it
          // stops being described as current. Nothing advances on its own.
          if (!cancelled) {
            setStatusFailed(true);
          }
        });
    };
    poll();
    const timer = setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [claim]);

  const onClaim = useCallback(() => {
    if (Number.isNaN(taskId)) {
      return;
    }
    setClaiming(true);
    void claimTask(taskId)
      .then((result) => {
        setClaim(result.data);
        setClaimPreview(result.degraded);
        toast.push(
          result.degraded
            ? 'Practice claim only — nothing was saved.'
            : `It's yours for the next ${result.data.leaseHours} hours.`,
          'ok',
        );
      })
      .catch((error: unknown) => {
        if (error instanceof ConflictError) {
          setTakenBy(error.claimedBy ?? 'someone else');
          toast.push('Someone claimed this one first. Have a look at the others.', 'warn');
          return;
        }
        // No lease, no countdown, no rail picker: the claim did not happen and
        // there is nothing anywhere that will finish it later.
        toast.push("That didn't save — nothing was changed. Please try again.", 'danger');
      })
      .finally(() => {
        setClaiming(false);
      });
  }, [taskId, toast]);

  const onPickRail = useCallback(
    (rail: Rail) => {
      setBusyRail(rail);
      void dispatchTask(taskId, rail)
        .then((result) => {
          setDispatched({ rail, result: result.data, preview: result.degraded });
          if (result.data.mode === 'handoff') {
            setHandoffOpen(true);
          } else {
            toast.push(`${RAIL_INFO[rail].label} has started. We'll let you know.`, 'ok');
          }
        })
        .catch((error: unknown) => {
          if (error instanceof ConflictError) {
            toast.push('Claim this one first, then hand it to your agent.', 'warn');
            return;
          }
          // Nothing was handed to anything: no session, no prompt, no "started".
          toast.push("That didn't save — nothing was changed. Please try again.", 'danger');
        })
        .finally(() => {
          setBusyRail(null);
        });
    },
    [taskId, toast],
  );

  const onRelayFeedback = useCallback(() => {
    setRelaying(true);
    void sendFeedback(taskId)
      .then((result) => {
        setRelayedPrompt(result.data.prompt);
        toast.push('Notes ready for your agent.', 'ok');
      })
      .catch(() => {
        toast.push("That didn't work — nothing was sent. Please try again.", 'danger');
      })
      .finally(() => {
        setRelaying(false);
      });
  }, [taskId, toast]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  if (loading) {
    return (
      <main className="page">
        <div className="card stack">
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

  if (task === null) {
    return (
      <main className="page stack">
        <h1 className="page-title">We could not find that task</h1>
        <p className="muted">It may have shipped already.</p>
        <p>
          <Link href="/contribute" className="btn">
            Back to the task list
          </Link>
        </p>
      </main>
    );
  }

  const reward = rewardLabel(task.rewardClass, task.rewardUsd);
  const criteria = fixture?.title === task.title ? fixture.acceptanceCriteria : [];
  const claimedByOther = claim === null && takenBy !== null;

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
          {claim !== null && (
            <LeaseCountdown leaseEndsAt={claim.leaseEndsAt} leaseHours={claim.leaseHours} />
          )}
        </div>
      </div>

      <section className="card stack">
        <h2 className="section-title">What done looks like</h2>
        {criteria.length === 0 ? (
          <p className="muted">
            The details for this one are still being written. Check back shortly.
          </p>
        ) : (
          <ul className="checklist">
            {criteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        )}
        <p className="faint">
          Your agent has to satisfy every line before a maintainer ever sees it. The checks decide,
          not us.
        </p>
      </section>

      <section className="card stack">
        {claim === null ? (
          <>
            <h2>Take it on</h2>
            {claimedByOther ? (
              <p className="muted">
                {takenBy} is on this one right now. If they run out of time it comes back to the
                list.
              </p>
            ) : (
              <p className="muted">
                Claiming holds the task for you so nobody doubles up. You can hand it back any time
                — nothing bad happens if you change your mind.
              </p>
            )}
            <div className="row">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={onClaim}
                disabled={claiming || claimedByOther}
              >
                {claiming ? 'Claiming…' : 'Claim this'}
              </button>
              {claimedByOther && (
                <Link href="/contribute" className="btn btn-ghost">
                  Find another
                </Link>
              )}
            </div>
          </>
        ) : (
          <>
            <h2>Let my agent work on it</h2>
            <p className="muted">
              Pick the agent you already pay for. It does the work in your own copy of the app, on
              your own plan — we never spend your allowance for you.
            </p>
            {claimPreview && (
              <p className="faint">
                Practice claim: the FORGE service did not answer, so this one lives on this screen
                and nowhere else. Everything below is the real wording.
              </p>
            )}
            <RailPicker onPick={onPickRail} busyRail={busyRail} />
          </>
        )}
      </section>

      {dispatched !== null && dispatched.result.mode === 'api' && (
        <section className="card stack">
          <h2>Your agent has started. We&apos;ll notify you.</h2>
          <ul className="steps">
            {dispatched.result.instructions.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ul>
          <div className="row">
            <Chip tone="ok">{RAIL_INFO[dispatched.rail].label} is on it</Chip>
            {dispatched.result.sessionRef !== undefined && (
              <Chip title="Reference for this run">ref {dispatched.result.sessionRef}</Chip>
            )}
          </div>
          <p className="faint">
            Beta note: hand-off to real agents is still being wired up, so this run is simulated
            end to end{dispatched.preview ? ' and was composed on your device' : ''}. The wording
            below is exactly what your agent receives.
          </p>
          <CopyBox label="What your agent was told" text={dispatched.result.compiledPrompt} />
        </section>
      )}

      {dispatched !== null && dispatched.result.mode === 'handoff' && !handoffOpen && (
        <section className="card row">
          <Chip tone="info">Handed to {RAIL_INFO[dispatched.rail].label}</Chip>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setHandoffOpen(true);
            }}
          >
            Show the instructions again
          </button>
        </section>
      )}

      {claim !== null && (
        <section className="card stack">
          <h2 className="section-title">Where it is</h2>
          {status === null ? (
            statusFailed ? (
              <p className="muted" role="alert">
                We can&apos;t check on this one just now. Your agent carries on either way — come
                back in a few minutes.
              </p>
            ) : (
              <p className="muted">Checking…</p>
            )
          ) : (
            <>
              <StatusStepper status={status} />
              {statusFailed && (
                <p className="faint" role="alert">
                  This is the last thing we heard. We can&apos;t check for anything newer just now.
                </p>
              )}
            </>
          )}
          <hr className="divider" />
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={onRelayFeedback}
              disabled={relaying}
            >
              {relaying ? 'Fetching the notes…' : 'Send the notes back to your agent'}
            </button>
            <span className="faint">
              When the checks find something, this hands your agent the exact notes so it can take
              another pass.
            </span>
          </div>
          {relayedPrompt !== null && (
            <CopyBox label="The notes, ready to paste" text={relayedPrompt} />
          )}
        </section>
      )}

      {dispatched !== null && handoffOpen && dispatched.result.mode === 'handoff' && (
        <HandoffModal
          rail={dispatched.rail}
          result={dispatched.result}
          preview={dispatched.preview}
          onClose={() => {
            setHandoffOpen(false);
          }}
        />
      )}
    </main>
  );
}
