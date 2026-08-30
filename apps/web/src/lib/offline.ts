/**
 * The Bridge, simulated locally.
 *
 * When the API is unreachable the Contribute flow still has to work end to end
 * — that is the whole point of an offline demo, and the Playwright suite runs
 * with nothing else up. Every function here mirrors
 * `apps/api/src/forge_api/services/bridge.py` so the preview a contributor sees
 * offline is the same text the server would have produced.
 */

import type { BridgeStage, BridgeStatus, ClaimResponse, DispatchResult, Rail } from '@forge/shared';
import { BRIDGE_STAGES } from '@forge/shared';

import { DEMO_IDENTITY, LEASE_HOURS_BY_SIZE, type TaskFixture } from './fixtures';
import { RAIL_INFO } from './rails';

/** One stage every 45 seconds from the moment of claim — the API's SECONDS_PER_STAGE. */
export const SECONDS_PER_STAGE = 45;

const CHECKS_TOTAL = 5;
const CHECKS_PASSED = 3;

const SAMPLE_GAUNTLET_FAILURE =
  'gauntlet: FAIL G2.3 — acceptance test issue-1/test_csv_export.py::test_headers';

function isoOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Mirrors the API's `slugify`: lowercase, non-alphanumerics collapsed to dashes. */
export function slugify(text: string, maxLength = 48): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) {
    return slug;
  }
  const clipped = slug.slice(0, maxLength);
  const lastDash = clipped.lastIndexOf('-');
  return (lastDash === -1 ? clipped : clipped.slice(0, lastDash)).replace(/^-+|-+$/g, '');
}

/** The one branch the agent is allowed to touch (PRD I.2, Dispatch row). */
export function branchName(taskId: number, title: string): string {
  return `task/${taskId}-${slugify(title)}`;
}

/** The compiled prompt — byte-identical on every rail (PRD I.3). */
export function compilePrompt(task: TaskFixture): string {
  const criteria = task.acceptanceCriteria
    .map((criterion, index) => `${index + 1}. ${criterion}`)
    .join('\n');
  return (
    `Task #${task.id}: ${task.title}\n\n` +
    `What this means in plain language: ${task.civilianSummary}\n\n` +
    `Acceptance criteria (each one is checked by a test):\n${criteria}\n\n` +
    'Read AGENTS.md at repo root first. ' +
    `Work ONLY in branch ${branchName(task.id, task.title)} of your fork of forge-app. ` +
    'Do not modify .github/, acceptance tests, or files outside the task scope.'
  );
}

const API_RAIL_NOTES: Record<string, string> = {
  copilot:
    'GitHub Copilot picks this up under the same account you signed in with — nothing else to connect.',
  jules: 'Jules runs this with the key you connected (its free tier covers 15 tasks a day).',
  cursor: "Cursor's cloud agent runs this on your own plan, using the key you connected.",
  devin: 'Devin starts a session on your own plan, using the key you connected.',
  openhands: 'OpenHands Cloud starts a session using the key you connected.',
};

/** Civilian voice only: no fork/branch/PR/CI vocabulary reaches this list (PRD §4.9). */
function apiInstructions(rail: Rail, task: TaskFixture): string[] {
  void task;
  return [
    API_RAIL_NOTES[rail] ?? `${RAIL_INFO[rail].label} runs this on your own plan.`,
    'We set up your own copy of the app and a private workspace for this task inside it — your agent works there and nowhere else.',
    "You can close this screen. We'll watch your agent's progress and tell you the moment it's ready to submit.",
  ];
}

/** Civilian voice only — the instructions are about the agent app, not about git (PRD I.2). */
function handoffInstructions(rail: Rail, task: TaskFixture): string[] {
  const { label, deepLink } = RAIL_INFO[rail];
  void task;
  return [
    'Tap Copy to put the whole task prompt on your clipboard.',
    `Tap Open ${label} — it opens ${deepLink} and already has access to your copy of the app.`,
    `Paste the prompt and send it. ${label} does the work and sends your contribution in for checks automatically; come back here to watch how it goes.`,
  ];
}

/** What the server would have returned for this dispatch. */
export function localDispatch(task: TaskFixture, rail: Rail): DispatchResult {
  const info = RAIL_INFO[rail];
  const compiledPrompt = compilePrompt(task);
  if (info.mode === 'api') {
    return {
      mode: 'api',
      compiledPrompt,
      sessionRef: `stub-${rail}-${task.id}`,
      instructions: apiInstructions(rail, task),
    };
  }
  return {
    mode: 'handoff',
    compiledPrompt,
    ...(info.deepLink === undefined ? {} : { deepLink: info.deepLink }),
    instructions: handoffInstructions(rail, task),
  };
}

/** What the server would have returned for this claim. */
export function localClaim(task: TaskFixture, claimedAtMs = Date.now()): ClaimResponse {
  const leaseHours = LEASE_HOURS_BY_SIZE[task.size];
  return {
    taskId: task.id,
    claimedBy: DEMO_IDENTITY,
    leaseEndsAt: isoOf(claimedAtMs + leaseHours * 60 * 60 * 1000),
    leaseHours,
  };
}

export function stageFor(elapsedSeconds: number): BridgeStage {
  const index = Math.floor(Math.max(0, elapsedSeconds) / SECONDS_PER_STAGE);
  return BRIDGE_STAGES[Math.min(index, BRIDGE_STAGES.length - 1)] ?? 'claimed';
}

const STAGE_DETAIL: Record<BridgeStage, (leaseHours: number) => string> = {
  claimed: (leaseHours) =>
    `This task is yours for the next ${leaseHours} hours. Hand it to your agent whenever you're ready.`,
  agent_working: () => "Your agent has started. We'll let you know when there's something to see.",
  ready_to_submit: () =>
    "Your agent says it's done. Have a look at its summary, then submit it for checks.",
  in_checks: () => `${CHECKS_PASSED} of ${CHECKS_TOTAL} checks passed. The rest are still running.`,
  in_review: () => 'All checks passed. A maintainer is reading your contribution now.',
  shipping: () =>
    'A maintainer approved your contribution. It ships to beta on the next release.',
  shipped: () =>
    'Your contribution shipped. Your reward unlocks once it survives 14 days in production.',
};

/** What the server would have returned for this status poll. */
export function localStatus(
  taskId: number,
  claimedAtMs: number,
  leaseHours: number,
  nowMs = Date.now(),
): BridgeStatus {
  const stage = stageFor((nowMs - claimedAtMs) / 1000);
  return {
    taskId,
    stage,
    detail: STAGE_DETAIL[stage](leaseHours),
    ...(stage === 'in_checks' ? { checksPassed: CHECKS_PASSED, checksTotal: CHECKS_TOTAL } : {}),
  };
}

/** What the server would have relayed back to the agent (PRD I.2, Iterate row). */
export function localFeedbackPrompt(task: TaskFixture): string {
  return (
    'The automated checks came back with a failure on your last push. ' +
    'Here is the report exactly as the checks produced it:\n\n' +
    `${SAMPLE_GAUNTLET_FAILURE}\n\n` +
    `Please fix the cause of that failure in branch ${branchName(task.id, task.title)}, ` +
    "keep every change inside this task's scope, do not modify the acceptance tests, " +
    'and push again once the checks pass locally.'
  );
}
