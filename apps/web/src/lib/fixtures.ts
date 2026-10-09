/**
 * Local demo data — the app's parachute.
 *
 * Every fetcher in `./api` falls back to these when the API is unreachable or
 * answers with something the shared zod schemas reject, so `next build`, the
 * Playwright suite and a plain `pnpm dev` all work with nothing else running.
 *
 * The task list is a field-for-field mirror of
 * `apps/api/src/forge_api/fixtures/tasks.json`. Keep them identical: they are
 * the Task Specs posted as issues on verastd/forge-app (the reviewed copies
 * live in `docs/tasks/`), and a drift between them would make the offline
 * demo lie about the product.
 */

import type { ContributorProfile, Size, TaskCard } from '@forge/shared';

/** A task card plus the acceptance criteria the detail page renders. */
export interface TaskFixture extends TaskCard {
  acceptanceCriteria: string[];
}

/** Mirror of the API fixtures (apps/api/src/forge_api/fixtures/tasks.json). */
export const TASK_FIXTURES: readonly TaskFixture[] = [
  {
    id: 48,
    title: 'Register catch, throw and wave in the behaviour catalog',
    civilianSummary:
      'Give the lobby one list of everything a robot can do, so each new trick comes with its own speed limit and its own on-screen feedback.',
    size: 'S',
    rewardClass: 'R2',
    tierFloor: 'T1',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/48',
    labels: ['agent-ready', 'status:open', 'size:S', 'tier-floor:T1', 'bounty:R2'],
    acceptanceCriteria: [
      'Every action kind the lobby sends (wave, ball, throw, catch) is an intent of exactly one BEHAVIORS entry, validateBehaviors passes, and each entry\'s intentsPerSecond equals MAX_ACTIONS_PER_SECOND',
      'Both presence feeds drop an action with no catalog entry and one over its entry\'s rate via createBehaviorMeter, with a lobby unit test and an e2e spec showing a flooded sender is ignored',
      'make lint, make test and make test-coverage pass with the behaviours folder at or above 80% changed-line coverage',
    ],
  },
  {
    id: 49,
    title: 'Every behaviour\'s declared states, on screen',
    civilianSummary:
      'When you throw or wave, the lobby always shows what happened to it: sent, done, didn\'t reach, or why not.',
    size: 'S',
    rewardClass: 'R1',
    tierFloor: 'T0',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/49',
    labels: ['agent-ready', 'status:open', 'size:S', 'tier-floor:T0', 'bounty:R1'],
    acceptanceCriteria: [
      'PlayControls renders each state\'s copy from the catalog entry, shows a spinner while requested, and replaces it within confirmWithinMs',
      'The lobby root carries data-behavior-state=<kind>:<state> and the people panel\'s live region announces a rejected state\'s reason',
      'tests/e2e/lobby-behavior-states.spec.ts proves outOfRange, requested then confirmed, and rejected with the catalog\'s copy in the practice build',
    ],
  },
  {
    id: 50,
    title: 'A swarm of scripted members, and the lobby\'s first baselines',
    civilianSummary:
      'A way to fill the lobby with pretend people so we can see what breaks before real people do.',
    size: 'M',
    rewardClass: 'R3',
    tierFloor: 'T1',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/50',
    labels: ['agent-ready', 'status:open', 'size:M', 'tier-floor:T1', 'bounty:R3'],
    acceptanceCriteria: [
      'tools/lobby-swarm/swarm.mjs joins N scripted members sending real position packets and actions at the real send policy, and exits non-zero on any failed join',
      'tools/lobby-swarm/measure.mjs reports per minute, as JSON: packets per second, drops per sender, frame time p50 and p95, voice subscription changes and heap, from a development-only window.__forgePresence view',
      'docs/lobby-baselines.md records runs at 25, 50, 100 and 150 members with the commands used, and ADR-009 links to it',
    ],
  },
  {
    id: 51,
    title: 'The world participant, owning nothing at first',
    civilianSummary:
      'Give the lobby a referee: one program that decides who caught the ball when two people grab at once, and can switch off a misbehaving trick for everyone.',
    size: 'M',
    rewardClass: 'R3',
    tierFloor: 'T2',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/51',
    labels: ['agent-ready', 'status:open', 'size:M', 'tier-floor:T2', 'bounty:R3'],
    acceptanceCriteria: [
      'apps/world starts with pnpm --filter @forge/world start, joins LOBBY_ROOM as identity world, publishes nothing until a world-authority entity exists, and exits non-zero in one line without its settings',
      'It steps the behaviour kernel at 20 Hz under each entry\'s msPerTick budget and exposes GET /healthz and a bearer-guarded POST /behaviors/<id>/pause',
      'Behind the new lobby_world flag the ball\'s flight moves to the world, and two browsers see the same holder after a contested catch',
    ],
  },
  {
    id: 52,
    title: 'Object state per cell, on data tracks, subscribed by distance',
    civilianSummary:
      'Make the lobby send you only what is happening near you, so it stays smooth when the room is full.',
    size: 'M',
    rewardClass: 'R3',
    tierFloor: 'T2',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/52',
    labels: ['agent-ready', 'status:open', 'size:M', 'tier-floor:T2', 'bounty:R3'],
    acceptanceCriteria: [
      'The world publishes obj frames on data tracks named obj:<cell> via cellOf, one per changed entity per tick, each under 1200 bytes',
      'The LiveKit feed subscribes to the member\'s cell and its neighbours at 2 Hz with voice\'s hysteresis, and reports the set in the debug view',
      'At 100 swarm members, packets handled per second on the measuring browser fall by at least half against the broadcast baseline, recorded in docs/lobby-baselines.md',
    ],
  },
];

/** Lease length by size class — mirrors `LEASE_HOURS_BY_SIZE` in the API. */
export const LEASE_HOURS_BY_SIZE: Record<Size, number> = { XS: 48, S: 48, M: 96 };

/**
 * Who holds a task the practice account claimed, and whose sample record /me
 * shows. The real Bridge acts as the signed-in GitHub user (PRD I.5); this is
 * deliberately no GitHub login (it has a space), so a task some real account
 * holds, read from a live API, can never pass for the practice account's. The
 * practice account has no fork either, so its brief and links name none.
 */
export const DEMO_IDENTITY = 'Practice account';

export function findTaskFixture(taskId: number): TaskFixture | undefined {
  return TASK_FIXTURES.find((task) => task.id === taskId);
}

/** Cards only — acceptance criteria are a detail-page concern, not a card field. */
export function taskCardFixtures(): TaskCard[] {
  return TASK_FIXTURES.map(({ acceptanceCriteria: _criteria, ...card }) => ({ ...card }));
}

/* --- profile --------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Mirrors the API's demo profile, with the countdowns anchored to right now. */
export function profileFixture(): ContributorProfile {
  return {
    login: DEMO_IDENTITY,
    tier: 'T0',
    merged: 1,
    survivalRate: 1,
    pendingRewards: [
      {
        pr: 1,
        rewardClass: 'R1',
        survivalEndsAt: isoDaysFromNow(12),
      },
    ],
    ledger: [
      { kind: 'claim', refIssue: 3, points: 0, at: isoDaysFromNow(-5) },
      { kind: 'merge', refPr: 1, refIssue: 3, points: 1, at: isoDaysFromNow(-2) },
      { kind: 'reward_pending', refPr: 1, refIssue: 3, points: 0, at: isoDaysFromNow(-2) },
    ],
  };
}
