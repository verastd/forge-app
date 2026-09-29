/**
 * Local demo data — the app's parachute.
 *
 * Every fetcher in `./api` falls back to these when the API is unreachable or
 * answers with something the shared zod schemas reject, so `next build`, the
 * Playwright suite and a plain `pnpm dev` all work with nothing else running.
 *
 * The task list is a field-for-field mirror of
 * `apps/api/src/forge_api/fixtures/tasks.json`. Keep them identical: they are
 * the same eight self-hosting starter tasks from PRD Appendix H.3, and a drift
 * between them would make the offline demo lie about the product.
 */

import type { ContributorProfile, Size, TaskCard } from '@forge/shared';

/** A task card plus the acceptance criteria the detail page renders. */
export interface TaskFixture extends TaskCard {
  acceptanceCriteria: string[];
}

/**
 * Mirror of the API fixtures. `rewardUsd` is omitted (never null) for the
 * unpaid tasks, exactly as the API serialises them.
 */
export const TASK_FIXTURES: readonly TaskFixture[] = [
  {
    id: 1,
    title: 'Polish the CSV export in the Data app',
    civilianSummary: 'Let people download the Upland data they are looking at as a spreadsheet file.',
    size: 'S',
    rewardClass: 'none',
    tierFloor: 'T0',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/1',
    labels: ['agent-ready', 'status:open', 'size:S'],
    acceptanceCriteria: [
      'GET /api/upland/export returns text/csv whose first line is the 13-column action header',
      'Export CSV button visible on /apps/data for signed-in users (flag: csv_export)',
      '10k-row export completes < 3s in CI fixture data',
    ],
  },
  {
    id: 2,
    title: 'Build the contributor leaderboard page',
    civilianSummary:
      'Add a page that shows who has helped build the app and how much they have shipped.',
    size: 'S',
    rewardClass: 'R2',
    rewardUsd: 200,
    tierFloor: 'T1',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/2',
    labels: ['agent-ready', 'status:open', 'size:S', 'bounty:R2'],
    acceptanceCriteria: [
      '/leaderboard renders contributors sorted by merged-and-surviving contributions',
      'Each row shows login, tier, merged count and survival rate from the ledger API',
      'Page renders with an empty-state message when the ledger returns no contributors',
    ],
  },
  {
    id: 3,
    title: 'Polish the forge CLI output and error messages',
    civilianSummary:
      "Make the project's helper tool explain itself clearly when something goes wrong.",
    size: 'XS',
    rewardClass: 'R1',
    rewardUsd: 50,
    tierFloor: 'T0',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/3',
    labels: ['agent-ready', 'status:open', 'size:XS', 'bounty:R1'],
    acceptanceCriteria: [
      '`forge --help` lists every subcommand with a one-line description',
      'Unknown subcommands exit non-zero with a suggestion instead of a stack trace',
      'Existing forge shell scripts keep their current exit codes',
    ],
  },
  {
    id: 4,
    title: 'Improve AGENTS.md build and scope instructions',
    civilianSummary:
      'Sharpen the instructions file that every helper agent reads before it starts work.',
    size: 'XS',
    rewardClass: 'R1',
    rewardUsd: 50,
    tierFloor: 'T0',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/4',
    labels: ['agent-ready', 'status:open', 'size:XS', 'bounty:R1'],
    acceptanceCriteria: [
      'Every command listed in AGENTS.md runs green from a clean checkout',
      'The scope rules name the directories that are always out of bounds',
      'The AGENTS.md lint workflow passes on the branch',
    ],
  },
  {
    id: 5,
    title: 'Format the daily triage digest',
    civilianSummary: 'Turn the daily project summary into something a human can read over coffee.',
    size: 'S',
    rewardClass: 'R2',
    rewardUsd: 200,
    tierFloor: 'T1',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/5',
    labels: ['agent-ready', 'status:open', 'size:S', 'bounty:R2'],
    acceptanceCriteria: [
      'The digest groups items by stalled, needs-review and shipped',
      'Output is deterministic for a fixed input fixture (snapshot test)',
      "An empty day produces a short 'nothing to report' digest, not an empty file",
    ],
  },
  {
    id: 6,
    title: 'Copy pass on the in-app bug wizard',
    civilianSummary: 'Reword the report-a-problem flow so it never uses developer jargon.',
    size: 'XS',
    rewardClass: 'none',
    tierFloor: 'T0',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/6',
    labels: ['agent-ready', 'status:open', 'size:XS'],
    acceptanceCriteria: [
      "Every wizard step's copy is jargon-free and under 140 characters",
      'The submitted issue body keeps its existing machine-readable sections',
      'Copy lives in the externalized strings file, not inline in components',
    ],
  },
  {
    id: 7,
    title: 'Build the feature-flags admin page',
    civilianSummary: 'Give the team a simple screen to switch app features on and off.',
    size: 'M',
    rewardClass: 'R3',
    rewardUsd: 600,
    tierFloor: 'T1',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/7',
    labels: ['agent-ready', 'status:open', 'size:M', 'bounty:R3'],
    acceptanceCriteria: [
      '/admin/flags lists every flag with its current value and source of truth',
      'Toggling a flag writes through the flags service and is reflected on reload',
      'The page is unreachable for users without the admin role',
    ],
  },
  {
    id: 8,
    title: 'Extract hardcoded UI strings for translation',
    civilianSummary:
      "Pull the app's wording into one place so it can be translated into other languages.",
    size: 'S',
    rewardClass: 'R2',
    rewardUsd: 200,
    tierFloor: 'T0',
    status: 'open',
    url: 'https://github.com/verastd/forge-app/issues/8',
    labels: ['agent-ready', 'status:open', 'size:S', 'bounty:R2'],
    acceptanceCriteria: [
      'No user-visible string literals remain in apps/web components',
      'Every extracted key exists in the English strings file with the same text',
      'A lint rule fails the build when a new hardcoded string is added',
    ],
  },
];

/** Lease length by size class — mirrors `LEASE_HOURS_BY_SIZE` in the API. */
export const LEASE_HOURS_BY_SIZE: Record<Size, number> = { XS: 48, S: 48, M: 96 };

/** The demo identity. The real Bridge acts as the signed-in GitHub user (PRD I.5). */
export const DEMO_IDENTITY = 'you';

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
        usdEquivalent: 50,
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
