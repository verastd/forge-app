/**
 * "Open my agent": one link per open rail that opens the contributor's agent
 * with the task already typed in (Phase 4 contract §2). They press send.
 *
 * Pure on purpose: no React, no fetch, no `window`. The task page computes
 * these at render time so each one is a real `<a href>` — a custom scheme
 * opened after an `await` is blocked as a popup by most browsers.
 *
 * Each vendor's URL format, as documented on 2026-10-01:
 * - Claude Code on the web: https://code.claude.com/docs/en/web-quickstart
 *   ("Pre-fill sessions": `prompt`, `prompt_url` (must allow cross-origin
 *   requests; ignored when `prompt` is set), `repositories`).
 * - Claude Code on your computer: https://code.claude.com/docs/en/deep-links
 *   (`claude-cli://open?repo=owner/name&q=…`, `q` at most 5,000 characters).
 * - Codex app: https://learn.chatgpt.com/docs/reference/commands#deep-links
 *   (`codex://new?prompt=…&originUrl=<git remote>`).
 * - VS Code: https://code.visualstudio.com/docs/configure/command-line
 *   (`vscode://agents/new?prompt=…`).
 * - Cursor: https://cursor.com/docs/reference/deeplinks
 *   (`cursor://anysphere.cursor-deeplink/prompt?text=…`, whole URL at most
 *   10,000 characters).
 * - Google Antigravity has no link or URL scheme, so it gets steps instead.
 */
import { isValidCopy, isValidLogin, OPEN_RAILS, workRepo } from '@forge/shared';
import type { OpenRail } from '@forge/shared';

/** Claude Code on the web: past this, the URL carries `prompt_url` instead of the brief. */
export const CLAUDE_CODE_URL_CAP = 7000;
/** Claude Code on your computer: the documented limit on `q` itself. */
export const CLAUDE_CLI_PROMPT_CAP = 5000;
/** Cursor: the documented limit on the whole deeplink. */
export const CURSOR_URL_CAP = 10_000;

/** A lone UTF-16 surrogate, which `encodeURIComponent` refuses with a URIError. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * What the task page's step 1 offers right now: nothing (no OAuth App here),
 * "Get started" (no copy yet) or "Refresh your copy". The Antigravity steps
 * point at it, so nobody is sent to GitHub to bring a copy up to date.
 */
export type CopyStep = 'none' | 'get-started' | 'refresh';

export interface LaunchInput {
  taskId: number;
  /** The brief from `compileBrief`, personalized with `login` when there is one. */
  brief: string;
  /** The signed-in GitHub login. Null, undefined or anything that isn't a login means "no login". */
  login: string | null | undefined;
  /** The public API origin (`NEXT_PUBLIC_API_URL`) that serves `/api/bridge/tasks/<id>/brief`. */
  apiBase: string;
  /**
   * The contributor's copy of forge-app (`TaskDetail.copy.fullName`, `owner/name`),
   * once FORGE has set it up. The links name it in place of `<login>/forge-app`;
   * anything that isn't a repository's full name means "no copy".
   */
  copy?: string | null;
  /** What the page's step 1 offers (`none` when left out). */
  copyStep?: CopyStep;
}

export interface Launch {
  rail: OpenRail;
  /** The link, or null for a rail that has none (Antigravity). */
  href: string | null;
  /** `web` opens in a new tab; `app` hands the link to an app on the computer. */
  kind: 'web' | 'app' | 'steps';
  /** True when the brief didn't fit in the link, so the link carries less than the whole text. */
  shortened: boolean;
  /** One plain sentence to show next to the link, when the person has something to do. */
  note?: string;
  /** Steps to follow instead of a link (Antigravity). */
  steps?: readonly string[];
}

/** What to say to an agent that has the FORGE connector and only needs the task number. */
export function startTaskAsk(taskId: number): string {
  return `Start FORGE task #${taskId}`;
}

/** `encodeURIComponent` that cannot throw on a malformed string. */
function encode(text: string): string {
  return encodeURIComponent(text.replace(LONE_SURROGATE, '\uFFFD'));
}

/**
 * The repository the agent works in, `owner/name`: the copy when there is a
 * valid one, else `<login>/forge-app` for a valid login, else null
 * (`workRepo`). Letters, digits, `.`, `_`, `-` and one slash, so it goes into
 * a link as it is.
 */
function repoSlug({ login, copy }: Pick<LaunchInput, 'login' | 'copy'>): string | null {
  return workRepo(login, copy);
}

/**
 * The query for the API's copy of the brief (`/api/bridge/tasks/<id>/brief`):
 * `login`, plus `copy` when it is the login's own (the API ignores any other).
 */
function briefQuery({ login, copy }: Pick<LaunchInput, 'login' | 'copy'>): string {
  if (!isValidLogin(login)) return '';
  const own = isValidCopy(copy) && copy.slice(0, copy.indexOf('/')).toLowerCase() === login.toLowerCase();
  return own ? `?login=${login}&copy=${encode(copy)}` : `?login=${login}`;
}

function claudeCode(input: LaunchInput): Launch {
  const { taskId, brief, apiBase } = input;
  const slug = repoSlug(input);
  // `owner/repo` is letters, digits, dashes and one slash: written as the docs write it.
  const repositories = slug === null ? '' : `&repositories=${slug}`;
  const full = `https://claude.ai/code?prompt=${encode(brief)}${repositories}`;
  if (full.length <= CLAUDE_CODE_URL_CAP) {
    return { rail: 'claude-code', href: full, kind: 'web', shortened: false };
  }
  const base = apiBase.replace(/\/+$/, '');
  if (!/^https?:\/\/[^/?#]+/i.test(base)) {
    // No public API to fetch the brief from: open Claude Code with the copy
    // selected, and let the connector fetch the task.
    return {
      rail: 'claude-code',
      href: `https://claude.ai/code?prompt=${encode(startTaskAsk(taskId))}${repositories}`,
      kind: 'web',
      shortened: true,
      note: 'This task is too long for a link, so it opens with a short request. Claude needs the FORGE connector to read the rest.',
    };
  }
  const promptUrl = `${base}/api/bridge/tasks/${taskId}/brief${briefQuery(input)}`;
  return {
    rail: 'claude-code',
    href: `https://claude.ai/code?prompt_url=${encode(promptUrl)}${repositories}`,
    kind: 'web',
    shortened: true,
  };
}

function claudeCli(input: LaunchInput): Launch {
  const { taskId, brief } = input;
  const slug = repoSlug(input);
  const params: string[] = [];
  if (slug !== null) params.push(`repo=${slug}`);
  const fits = brief.length <= CLAUDE_CLI_PROMPT_CAP;
  if (fits) params.push(`q=${encode(brief)}`);
  return {
    rail: 'claude-cli',
    href: `claude-cli://open${params.length === 0 ? '' : `?${params.join('&')}`}`,
    kind: 'app',
    shortened: !fits,
    ...(fits ? {} : { note: `This task is too long for a link. Once Claude Code opens, ask it: ${startTaskAsk(taskId)}` }),
  };
}

function codex(input: LaunchInput): Launch {
  const { brief } = input;
  const slug = repoSlug(input);
  const origin = slug === null ? '' : `&originUrl=${encode(`https://github.com/${slug}.git`)}`;
  return { rail: 'codex', href: `codex://new?prompt=${encode(brief)}${origin}`, kind: 'app', shortened: false };
}

function vscode({ brief }: LaunchInput): Launch {
  return { rail: 'vscode', href: `vscode://agents/new?prompt=${encode(brief)}`, kind: 'app', shortened: false };
}

function cursorApp({ taskId, brief }: LaunchInput): Launch {
  const base = 'cursor://anysphere.cursor-deeplink/prompt?text=';
  const full = `${base}${encode(brief)}`;
  if (full.length <= CURSOR_URL_CAP) {
    return { rail: 'cursor-app', href: full, kind: 'app', shortened: false };
  }
  return {
    rail: 'cursor-app',
    href: `${base}${encode(startTaskAsk(taskId))}`,
    kind: 'app',
    shortened: true,
    note: 'This task is too long for a link, so Cursor opens with a short request. It needs the FORGE connector to read the rest.',
  };
}

/** The first Antigravity step: getting the copy in step with forge-app, the way this page can. */
function upToDateStep(copyStep: CopyStep | undefined): string {
  switch (copyStep) {
    case 'refresh':
      return "If your copy is older than October 2026, press Refresh your copy on this page first so it has FORGE's connector settings.";
    case 'get-started':
      return "Press Get started on this page first, so your copy has FORGE's connector settings.";
    default:
      return "If your copy is older than October 2026, bring it up to date on GitHub first so it has FORGE's connector settings.";
  }
}

/**
 * Antigravity reads the task through the FORGE connector, which the
 * contributor's copy has in `.agents/mcp_config.json` only once it is in step
 * with forge-app (October 2026 on), and which asks for a one-time sign-in
 * (/connect). The copy is named once FORGE knows it.
 */
function antigravity({ taskId, copy, copyStep }: LaunchInput): Launch {
  return {
    rail: 'antigravity',
    href: null,
    kind: 'steps',
    shortened: false,
    steps: [
      upToDateStep(copyStep),
      isValidCopy(copy)
        ? `Open your copy, ${copy}, in Antigravity. The FORGE connector is already set up in it.`
        : 'Open your copy in Antigravity. The FORGE connector is already set up in it.',
      'The first time, sign in to FORGE: in Settings → Customizations, press Authenticate next to forge, then paste the code your browser shows and press Submit.',
      `Ask it: ${startTaskAsk(taskId)}`,
    ],
  };
}

/** One builder per open rail: the Record type makes sure none is missing. */
const BUILDERS: Readonly<Record<OpenRail, (input: LaunchInput) => Launch>> = {
  'claude-code': claudeCode,
  'claude-cli': claudeCli,
  codex,
  vscode,
  'cursor-app': cursorApp,
  antigravity,
};

/** The launch for one open rail. */
export function launchFor(rail: OpenRail, input: LaunchInput): Launch {
  return BUILDERS[rail](input);
}

/** Every open rail's launch, in display order (`OPEN_RAILS`). */
export function launchLinks(input: LaunchInput): Launch[] {
  return OPEN_RAILS.map((rail) => launchFor(rail, input));
}
