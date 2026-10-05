'use client';

/**
 * Step 2, "Your agent": the two ways in, once you hold the claim.
 *
 * 1. Start it for me — shown only while the `agent_start` flag is on and the
 *    API lists at least one start rail it will start.
 * 2. Open my agent — always: a link per agent that opens it with the task
 *    already typed in, in the contributor's copy once FORGE has set it up
 *    (step 1). Before that both stay usable, with a line saying the agent
 *    needs the copy first.
 *
 * Copy and paste survives only as the closed "Using another agent?" fallback
 * at the bottom (Phase 4: no copy/paste in the flow).
 */

import type { OpenRail, RailInfo, StartRail } from '@forge/shared';
import { railMeta } from '@forge/shared';

import { CopyBox } from '../CopyBox';
import { OpenRails } from './OpenRails';
import { StepTitle } from './RepoSteps';
import { SetupSteps, StartRails } from './StartRails';
import { describeStartError, startedSentence } from '../../lib/handoff';
import type { StartOutcome } from '../../lib/handoff';
import type { CopyStep } from '../../lib/launch';
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
  copy,
  copyStep,
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
  /** The copy's full name for the links (`TaskDetail.copy.fullName`), or null for none or a pretend one. */
  copy: string | null;
  /** What step 1 offers: before the copy ("Get started") the agent needs it first, and the steps that bring a copy up to date point there. */
  copyStep: CopyStep;
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
      <StepTitle id="handoff-title" number={2} done={false}>
        Your agent
      </StepTitle>
      {copyStep === 'get-started' && <p className="muted">Your agent needs your copy first: press Get started above.</p>}
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
              FORGE starts your agent for you. It works in your copy and opens a pull request.
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
          copy={copy}
          copyStep={copyStep}
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
