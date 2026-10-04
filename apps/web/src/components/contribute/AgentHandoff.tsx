'use client';

/**
 * "Get your agent on it": the two ways in, once you hold the claim.
 *
 * 1. Start it for me — shown only while the `agent_start` flag is on and the
 *    API lists at least one start rail it will start.
 * 2. Open my agent — always: a link per agent that opens it with the task
 *    already typed in.
 *
 * Copy and paste survives only as the closed "Using another agent?" fallback
 * at the bottom (Phase 4: no copy/paste in the flow).
 */

import type { OpenRail, RailInfo, StartRail } from '@forge/shared';
import { railMeta } from '@forge/shared';

import { CopyBox } from '../CopyBox';
import { OpenRails } from './OpenRails';
import { SetupSteps, StartRails } from './StartRails';
import { describeStartError, startedSentence } from '../../lib/handoff';
import type { StartOutcome } from '../../lib/handoff';
import styles from './contribute.module.css';

/**
 * What the Copilot callback sent back (`?started=` / `?start_error=`), said
 * once. A setup failure brings the rail's setup steps with it, right below
 * the sentence that points at them.
 */
export function CallbackOutcome({ outcome, appSlug }: { outcome: StartOutcome; appSlug: string | null }) {
  const meta = railMeta(outcome.rail);
  if (outcome.kind === 'started') {
    return (
      <div className={`${styles.outcome} ${styles.outcomeOk}`} role="status">
        <p className={styles.outcomeTitle}>{startedSentence(meta.label)}</p>
        <p className="muted">Its progress shows up below as it works.</p>
      </div>
    );
  }
  const setup = outcome.failure.code === 'rail_setup_needed';
  return (
    <div className={`${styles.outcome} ${styles.outcomeError}`} role="alert">
      <p className={styles.outcomeTitle}>{describeStartError(outcome.failure, meta, { steps: 'below' })}</p>
      {setup && <SetupSteps meta={meta} vault={false} appSlug={appSlug} />}
    </div>
  );
}

export function AgentHandoff({
  taskId,
  brief,
  login,
  appSlug,
  practice,
  agentStart,
  connector,
  startRails,
  vault,
  railsLoaded,
  railsFailed,
  outcome,
  onStarted,
  onCheck,
  onOpened,
}: {
  taskId: number;
  /** The text every rail hands over: the API's `TaskDetail.brief`. */
  brief: string;
  login: string | null;
  appSlug: string | null;
  practice: boolean;
  /** The `agent_start` flag. */
  agentStart: boolean;
  /** The `mcp_connector` flag: the FORGE connector is on. */
  connector: boolean;
  /** The start rails the API says are on. */
  startRails: readonly RailInfo[];
  vault: boolean;
  railsLoaded: boolean;
  railsFailed: boolean;
  outcome: StartOutcome | null;
  onStarted: (rail: StartRail) => void;
  onCheck: () => void;
  onOpened: (rail: OpenRail) => void;
}) {
  const showStart = agentStart && startRails.length > 0;

  return (
    <section className="card stack" aria-labelledby="handoff-title">
      {/* Focusable, so a claim can take keyboard and screen-reader users straight here. */}
      <h2 id="handoff-title" tabIndex={-1}>
        Get your agent on it
      </h2>
      {practice && (
        <p className="faint">
          Practice account: a start here is pretend and sends nothing anywhere. The &ldquo;Open my
          agent&rdquo; links open your real agent.
        </p>
      )}
      {outcome !== null && <CallbackOutcome outcome={outcome} appSlug={appSlug} />}

      {showStart && (
        <div className={styles.part} aria-labelledby="start-title" role="group">
          <div className={styles.partHead}>
            <h3 id="start-title">Start it for me</h3>
            <p className="muted">
              FORGE starts your agent for you. It works in your fork and opens a pull request.
            </p>
          </div>
          <StartRails
            taskId={taskId}
            rails={startRails}
            vault={vault}
            appSlug={appSlug}
            practice={practice}
            onStarted={onStarted}
            onCheck={onCheck}
          />
        </div>
      )}
      {agentStart && railsFailed && !railsLoaded && (
        <p className="faint">
          We can&apos;t list the agents FORGE starts for you just now. You can still open yours below.
        </p>
      )}

      <div className={styles.part} aria-labelledby="open-title" role="group">
        <div className={styles.partHead}>
          <h3 id="open-title">Open my agent</h3>
          <p className="muted">Opens your agent with the task already typed in. You press send.</p>
        </div>
        <OpenRails
          taskId={taskId}
          brief={brief}
          login={login}
          appSlug={appSlug}
          connector={connector}
          onOpened={onOpened}
        />
      </div>

      <details className="disclosure">
        <summary>Using another agent? Copy the brief</summary>
        <div className="disclosure-body stack">
          <p className="muted">This is exactly what the links above type in for you.</p>
          <CopyBox label="The brief" text={brief} />
        </div>
      </details>
    </section>
  );
}
