/**
 * The Bridge, simulated for the practice app (demo builds only).
 *
 * The practice account is nobody on GitHub, so nothing it does may reach the
 * API (the BFF refuses it) — yet the Contribute flow still has to work end to
 * end, and the Playwright demo suite runs with nothing else up. Everything
 * here answers in exactly the shapes the API would (`@forge/shared`, Phase 4
 * contract §3), from the task fixtures, and says on screen that it is
 * practice: a practice "Start" never sends anything anywhere.
 *
 * Pure: the caller (`./api`) keeps one {@link PracticeTask} per claimed task
 * for the life of the tab and passes it in. Open-rail links stay real links;
 * only the bookkeeping behind them is simulated.
 */

import {
  BRIDGE_STAGES,
  RAIL_REGISTRY,
  branchName,
  compileBrief,
  isStartRail,
  railMeta,
} from '@forge/shared';
import type {
  BridgeEvent,
  BridgeStage,
  BridgeStatus,
  CheckResults,
  ClaimResponse,
  DispatchRequest,
  DispatchResult,
  FeedbackResponse,
  Rail,
  RailList,
  TaskDetail,
} from '@forge/shared';

import { DEMO_IDENTITY, LEASE_HOURS_BY_SIZE, type TaskFixture } from './fixtures';
import { canRelayNotes } from './handoff';

/** Once handed off, the practice run moves one stage on every 45 seconds. */
export const SECONDS_PER_STAGE = 45;

/** Said wherever the practice app pretends to start or tell an agent something. */
export const PRACTICE_NOTE = 'Practice: nothing was sent.';

const CHECKS_TOTAL = 5;
const CHECKS_PASSED = 3;

const SAMPLE_FAILURE = 'gauntlet: FAIL G2.3 — acceptance test issue-1/test_csv_export.py::test_headers';

/** What the practice app remembers about one task it holds, for the life of the tab. */
export interface PracticeTask {
  taskId: number;
  claimedAtMs: number;
  leaseHours: number;
  /** FORGE's own lines: claimed, handed off, notes sent. Agent lines are derived from the clock. */
  events: BridgeEvent[];
  /** The last hand-off. */
  rail?: Rail;
  handedOffAtMs?: number;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function forgeEvent(atMs: number, kind: BridgeEvent['kind'], message: string, rail?: Rail): BridgeEvent {
  return { at: isoOf(atMs), kind, source: 'forge', message, ...(rail === undefined ? {} : { rail }) };
}

/** GET /api/bridge/tasks/{id}, from the fixtures. The practice account has no fork, so the brief names none. */
export function localTaskDetail(task: TaskFixture): TaskDetail {
  const { acceptanceCriteria, ...card } = task;
  return {
    task: { ...card },
    acceptanceCriteria: [...acceptanceCriteria],
    branch: branchName(task.id, task.title),
    brief: compileBrief(task, acceptanceCriteria, null),
  };
}

/** GET /api/bridge/rails: every rail, all of them switched on, so the practice app shows the whole flow. */
export function localRails(): RailList {
  return {
    rails: RAIL_REGISTRY.map((meta) => ({
      ...meta,
      setup: [...meta.setup],
      enabled: true,
      savedCredential: false,
    })),
    vault: true,
  };
}

/** POST /api/bridge/claim. */
export function localClaim(task: TaskFixture, nowMs = Date.now()): { claim: ClaimResponse; practice: PracticeTask } {
  const leaseHours = LEASE_HOURS_BY_SIZE[task.size];
  return {
    claim: {
      taskId: task.id,
      claimedBy: DEMO_IDENTITY,
      leaseEndsAt: isoOf(nowMs + leaseHours * 60 * 60 * 1000),
      leaseHours,
    },
    practice: {
      taskId: task.id,
      claimedAtMs: nowMs,
      leaseHours,
      events: [forgeEvent(nowMs, 'claimed', `You claimed this task. It's yours for ${leaseHours} hours.`)],
    },
  };
}

/** POST /api/bridge/dispatch: an open rail is only noted; a start rail "starts" without sending anything. */
export function localDispatch(
  task: TaskFixture,
  practice: PracticeTask,
  request: Pick<DispatchRequest, 'rail'>,
  nowMs = Date.now(),
): { result: DispatchResult; practice: PracticeTask } {
  const meta = railMeta(request.rail);
  const start = isStartRail(request.rail);
  const message = start
    ? `Practice: ${meta.label} would start now. Nothing was sent.`
    : `You opened ${meta.label}.`;
  return {
    result: {
      mode: start ? 'start' : 'open',
      rail: request.rail,
      brief: compileBrief(task, task.acceptanceCriteria, null),
      startedAt: isoOf(nowMs),
      ...(start ? { credentialSaved: false } : {}),
    },
    practice: {
      ...practice,
      events: [...practice.events, forgeEvent(nowMs, start ? 'dispatched' : 'opened', message, request.rail)],
      rail: request.rail,
      handedOffAtMs: practice.handedOffAtMs ?? nowMs,
    },
  };
}

/** Which stage the practice run has reached: claimed until the hand-off, then one stage per 45 seconds. */
export function stageFor(practice: PracticeTask | undefined, nowMs = Date.now()): BridgeStage {
  if (practice?.handedOffAtMs === undefined) {
    return 'claimed';
  }
  const elapsed = Math.max(0, nowMs - practice.handedOffAtMs) / 1000;
  const index = 1 + Math.floor(elapsed / SECONDS_PER_STAGE);
  return BRIDGE_STAGES[Math.min(index, BRIDGE_STAGES.length - 1)] ?? 'agent_working';
}

const STAGE_DETAIL: Record<BridgeStage, (leaseHours: number) => string> = {
  claimed: (leaseHours) =>
    `This task is yours for the next ${leaseHours} hours. Get your agent on it whenever you're ready.`,
  agent_working: () => "Your agent is working on it. We'll show its progress here.",
  ready_to_submit: () => 'Your agent says the work is ready. Its pull request comes next.',
  in_checks: () => `${CHECKS_PASSED} of ${CHECKS_TOTAL} checks passed. Two need another look.`,
  in_review: () => 'All checks passed. A maintainer is reading your contribution now.',
  shipping: () => 'A maintainer approved your contribution. It ships to beta on the next release.',
  shipped: () => 'Your contribution shipped. Your reward unlocks once it survives 14 days in production.',
};

/** What the practice agent "reports" as each stage arrives. */
const AGENT_LINES: ReadonlyArray<{ stage: BridgeStage; progress: BridgeEvent['stage']; message: string }> = [
  { stage: 'agent_working', progress: 'started', message: 'Practice: started on the task.' },
  { stage: 'ready_to_submit', progress: 'pushed', message: 'Practice: pushed the first changes to the task branch.' },
  { stage: 'in_checks', progress: 'pr_opened', message: 'Practice: opened the pull request.' },
];

function agentEvents(practice: PracticeTask, nowMs: number): BridgeEvent[] {
  if (practice.handedOffAtMs === undefined) {
    return [];
  }
  const reached = BRIDGE_STAGES.indexOf(stageFor(practice, nowMs));
  return AGENT_LINES.filter((line) => BRIDGE_STAGES.indexOf(line.stage) <= reached).map((line) => ({
    at: isoOf((practice.handedOffAtMs ?? nowMs) + (BRIDGE_STAGES.indexOf(line.stage) - 1) * SECONDS_PER_STAGE * 1000),
    kind: 'progress',
    source: 'agent',
    message: line.message,
    ...(line.progress === undefined ? {} : { stage: line.progress }),
    ...(practice.rail === undefined ? {} : { rail: practice.rail }),
  }));
}

/** GET /api/bridge/status/{id}. */
export function localStatus(taskId: number, practice: PracticeTask | undefined, nowMs = Date.now()): BridgeStatus {
  const stage = stageFor(practice, nowMs);
  const leaseHours = practice?.leaseHours ?? 48;
  const events = practice === undefined ? [] : [...practice.events, ...agentEvents(practice, nowMs)];
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    taskId,
    stage,
    detail: STAGE_DETAIL[stage](leaseHours),
    events,
    ...(practice === undefined
      ? {}
      : {
          holder: DEMO_IDENTITY,
          leaseEndsAt: isoOf(practice.claimedAtMs + practice.leaseHours * 60 * 60 * 1000),
        }),
    ...(practice?.rail === undefined ? {} : { rail: practice.rail }),
    ...(stage === 'in_checks' ? { checksPassed: CHECKS_PASSED, checksTotal: CHECKS_TOTAL } : {}),
  };
}

function practiceNotes(task: TaskFixture): string {
  return [
    `2 of ${CHECKS_TOTAL} checks failed on the pull request for FORGE task #${task.id}.`,
    '',
    `- Acceptance tests: ${SAMPLE_FAILURE}`,
    '- Lint: apps/web/src/lib/export.ts:14 — unused variable "rows".',
    '',
    `Fix both in the branch ${branchName(task.id, task.title)}, keep every change inside this task, ` +
      "don't change the acceptance tests, and push again once make lint and make test pass.",
  ].join('\n');
}

/** GET /api/bridge/checks/{id}: nothing until the practice pull request "opens", then two failures. */
export function localChecks(task: TaskFixture, practice: PracticeTask | undefined, nowMs = Date.now()): CheckResults {
  const reached = BRIDGE_STAGES.indexOf(stageFor(practice, nowMs));
  if (reached < BRIDGE_STAGES.indexOf('in_checks')) {
    return { taskId: task.id, state: 'no_pr', checks: [], notes: '' };
  }
  const passed = reached > BRIDGE_STAGES.indexOf('in_checks');
  const ok = (name: string) => ({ name, status: 'completed' as const, conclusion: 'success' });
  return {
    taskId: task.id,
    state: passed ? 'passed' : 'failed',
    checks: [
      ok('Protocol'),
      ok('Build'),
      ok('Security scans'),
      passed ? ok('Acceptance tests') : { name: 'Acceptance tests', status: 'completed', conclusion: 'failure', summary: SAMPLE_FAILURE },
      passed ? ok('Lint') : { name: 'Lint', status: 'completed', conclusion: 'failure', summary: 'One unused variable.' },
    ],
    notes: passed ? '' : practiceNotes(task),
  };
}

/**
 * POST /api/bridge/feedback/{id}: a start rail whose vendor takes follow-ups
 * (Jules, Cursor, Devin) would get the notes; anything else reads them itself.
 */
export function localFeedback(
  task: TaskFixture,
  practice: PracticeTask,
  nowMs = Date.now(),
): { result: FeedbackResponse; practice: PracticeTask } {
  const notes = practiceNotes(task);
  const rail = practice.rail;
  if (rail === undefined || !isStartRail(rail) || !canRelayNotes(rail)) {
    return { result: { relayed: false, notes }, practice };
  }
  const label = railMeta(rail).label;
  return {
    result: { relayed: true, notes, relayedTo: rail },
    practice: {
      ...practice,
      events: [...practice.events, forgeEvent(nowMs, 'relayed', `Practice: the notes would go to ${label}. Nothing was sent.`, rail)],
    },
  };
}

/** POST /api/bridge/release/{id}: the task is nobody's again. */
export function localRelease(taskId: number, practice: PracticeTask | undefined, nowMs = Date.now()): BridgeStatus {
  const events = [...(practice?.events ?? []), forgeEvent(nowMs, 'released', 'You released this task. It is back on the board.')];
  return {
    taskId,
    stage: 'claimed',
    detail: 'Nobody holds this task right now.',
    events,
  };
}
