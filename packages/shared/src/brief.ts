/**
 * The brief: the one text every rail hands to a contributor's agent (Phase 4
 * contract §4).
 *
 * Open-rail links, start-rail API calls, the connector's get_task, the
 * prompt_url endpoint and the hidden copy fallback all send exactly this text.
 * It is byte-identical to `compile_brief` in
 * apps/api/src/forge_api/services/brief.py; both sides are held to
 * tests/fixtures/brief-golden.json, so change them together or not at all.
 */

/** The repository every contribution lands in. Forks keep its name: <login>/forge-app. */
export const UPSTREAM_REPO = 'verastd/forge-app';
const FORK_NAME = 'forge-app';

/** A GitHub login. No `m` flag, so `$` is the end of the string. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const CONNECTOR_LINE =
  'If you have the FORGE tools (the FORGE connector), call claim_task first, ' +
  'report_progress as you go, get_check_results when checks fail, and submit_task ' +
  'with the pull request link.';

/** What the brief reads from a task. A TaskCard fits. */
export interface BriefTask {
  readonly id: number;
  readonly title: string;
  readonly civilianSummary: string;
  readonly url: string;
}

/** True for a string shaped like a GitHub login; anything else is no login at all. */
export function isValidLogin(login: unknown): login is string {
  return typeof login === 'string' && LOGIN.test(login);
}

/**
 * Lowercase, runs of anything but a-z/0-9 collapsed to one dash, cut back to a
 * whole word when longer than `maxLength`. The pre-v2 Bridge's rule, unchanged
 * (it was `slugify` in apps/web/src/lib/offline.ts and services/bridge.py).
 */
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

/**
 * The brief for `task`, personalized for `login` when it is a valid GitHub
 * login. An invalid login is treated as no login. The "Done when" block is
 * left out when there are no criteria. No trailing newline.
 */
export function compileBrief(
  task: BriefTask,
  criteria: readonly string[],
  login: string | null | undefined,
): string {
  const branch = branchName(task.id, task.title);
  const personal = isValidLogin(login);
  const fork = personal ? `your fork, ${login}/${FORK_NAME}` : `your fork of ${UPSTREAM_REPO}`;
  const head = personal ? `${login}:${branch}` : `your fork's ${branch} branch`;

  const sections = [`FORGE task #${task.id}: ${task.title}`, `Why: ${task.civilianSummary}`];
  if (criteria.length > 0) {
    sections.push(`Done when:\n${criteria.map((item) => `- ${item}`).join('\n')}`);
  }
  // The pull request title is AGENTS.md rule 8's `[#<issue>] <goal>`. Inside its quotes
  // a `"` in the title becomes `'`, so the title can't close the quote early.
  const quotedTitle = task.title.replaceAll('"', "'");
  sections.push(
    'Rules:\n' +
      '- Read AGENTS.md at the repo root before you start.\n' +
      `- Work in ${fork}, on the branch ${branch}. Create it from main if it doesn't exist.\n` +
      "- Don't change .github/, the acceptance tests, or anything outside this task.\n" +
      '- Run make lint and make test before you push.\n' +
      `- When it's ready, open a pull request from ${head} to ${UPSTREAM_REPO} main, ` +
      `titled "[#${task.id}] ${quotedTitle}", with "Closes #${task.id}" in the description.`,
  );
  sections.push(CONNECTOR_LINE);
  sections.push(`Task: ${task.url}`);
  return sections.join('\n\n');
}
