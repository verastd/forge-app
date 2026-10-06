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
/** A GitHub repository name (the part after `owner/`). `.` and `..` are refused apart. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

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
 * True for a string shaped like a repository's full name, `owner/name`: a
 * GitHub login, one slash, a repository name. What FORGE accepts as the
 * contributor's copy (`TaskDetail.copy.fullName`); anything else is no copy.
 */
export function isValidCopy(fullName: unknown): fullName is string {
  if (typeof fullName !== 'string') return false;
  const slash = fullName.indexOf('/');
  if (slash === -1) return false;
  const name = fullName.slice(slash + 1);
  return isValidLogin(fullName.slice(0, slash)) && REPO_NAME.test(name) && name !== '.' && name !== '..';
}

/**
 * The repository the agent works in: the copy's full name when it is a valid
 * one, else `<login>/forge-app` for a valid login, else null. What the Open my
 * agent links and the start rails name.
 */
export function workRepo(login: string | null | undefined, copy?: string | null): string | null {
  if (isValidCopy(copy)) return copy;
  return isValidLogin(login) ? `${login}/${FORK_NAME}` : null;
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
 * login, and for the contributor's copy (`owner/name`) when `copy` is a valid
 * full name: then the agent works in the copy, on the branch FORGE made there,
 * and the person sends the work for review from the task page. An invalid
 * login is treated as no login, an invalid copy as no copy. The "Done when"
 * block is left out when there are no criteria. No trailing newline.
 */
export function compileBrief(
  task: BriefTask,
  criteria: readonly string[],
  login: string | null | undefined,
  copy?: string | null,
): string {
  const branch = branchName(task.id, task.title);

  const sections = [`FORGE task #${task.id}: ${task.title}`, `Why: ${task.civilianSummary}`];
  if (criteria.length > 0) {
    sections.push(`Done when:\n${criteria.map((item) => `- ${item}`).join('\n')}`);
  }
  // The pull request title is AGENTS.md rule 8's `[#<issue>] <goal>`. Inside its quotes
  // a `"` in the title becomes `'`, so the title can't close the quote early.
  const quotedTitle = task.title.replaceAll('"', "'");
  const titled = `titled "[#${task.id}] ${quotedTitle}", with "Closes #${task.id}" in the description.`;
  let work: string;
  let finish: string;
  if (isValidCopy(copy)) {
    const owner = copy.slice(0, copy.indexOf('/'));
    work =
      `- Work in your copy, ${copy} (a fork of ${UPSTREAM_REPO}), on the branch ${branch}. FORGE made ` +
      `that branch from the latest main; if it's missing, create it from ${UPSTREAM_REPO}'s main. ` +
      'Push your commits to it.\n';
    finish =
      "- When it's done, tell FORGE (report_progress, if you have the FORGE tools): the person " +
      'sends it for review from the task page. If you can open pull requests yourself, you may ' +
      `open one instead, from ${owner}:${branch} to ${UPSTREAM_REPO} main, ${titled}`;
  } else {
    const personal = isValidLogin(login);
    const yours = personal
      ? `your copy, ${login}/${FORK_NAME} (a fork of ${UPSTREAM_REPO})`
      : `your copy of ${UPSTREAM_REPO} (a fork of it)`;
    const head = personal ? `${login}:${branch}` : `your copy's ${branch} branch`;
    work =
      `- Work in ${yours}, on the branch ${branch}. Create it from main if it doesn't exist.\n` +
      '- No copy yet? Ask the person to press Get started on the task page first: FORGE makes ' +
      `one. If you can fork repositories, you may fork ${UPSTREAM_REPO} yourself.\n`;
    finish = `- When it's ready, open a pull request from ${head} to ${UPSTREAM_REPO} main, ${titled}`;
  }
  sections.push(
    'Rules:\n' +
      '- Read AGENTS.md at the repo root before you start.\n' +
      work +
      "- Don't edit or delete existing tests (add new test files instead). Don't change .github/, " +
      'AGENTS.md, CLAUDE.md, the files listed under protectedPaths in .github/forge-protocol.json, ' +
      'or anything outside this task.\n' +
      '- Run make lint and make test before you push.\n' +
      finish,
  );
  sections.push(CONNECTOR_LINE);
  sections.push(`Task: ${task.url}`);
  return sections.join('\n\n');
}
