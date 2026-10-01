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
import { isValidLogin, OPEN_RAILS, UPSTREAM_REPO } from '@forge/shared';
import type { OpenRail } from '@forge/shared';

/** Forks keep the upstream's name: <login>/forge-app. */
const FORK_NAME = UPSTREAM_REPO.slice(UPSTREAM_REPO.indexOf('/') + 1);

/** Claude Code on the web: past this, the URL carries `prompt_url` instead of the brief. */
export const CLAUDE_CODE_URL_CAP = 7000;
/** Claude Code on your computer: the documented limit on `q` itself. */
export const CLAUDE_CLI_PROMPT_CAP = 5000;
/** Cursor: the documented limit on the whole deeplink. */
export const CURSOR_URL_CAP = 10_000;

/** A lone UTF-16 surrogate, which `encodeURIComponent` refuses with a URIError. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export interface LaunchInput {
  taskId: number;
  /** The brief from `compileBrief`, personalized with `login` when there is one. */
  brief: string;
  /** The signed-in GitHub login. Null, undefined or anything that isn't a login means "no login". */
  login: string | null | undefined;
  /** The public API origin (`NEXT_PUBLIC_API_URL`) that serves `/api/bridge/tasks/<id>/brief`. */
  apiBase: string;
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

/** `owner/forge-app` for a valid login, else null: anything that isn't a login is no login at all. */
function forkSlug(login: string | null | undefined): string | null {
  return isValidLogin(login) ? `${login}/${FORK_NAME}` : null;
}

function claudeCode({ taskId, brief, login, apiBase }: LaunchInput): Launch {
  const slug = forkSlug(login);
  // `owner/repo` is letters, digits, dashes and one slash: written as the docs write it.
  const repositories = slug === null ? '' : `&repositories=${slug}`;
  const full = `https://claude.ai/code?prompt=${encode(brief)}${repositories}`;
  if (full.length <= CLAUDE_CODE_URL_CAP) {
    return { rail: 'claude-code', href: full, kind: 'web', shortened: false };
  }
  const base = apiBase.replace(/\/+$/, '');
  if (!/^https?:\/\/[^/?#]+/i.test(base)) {
    // No public API to fetch the brief from: open Claude Code with the fork
    // selected, and let the connector fetch the task.
    return {
      rail: 'claude-code',
      href: `https://claude.ai/code?prompt=${encode(startTaskAsk(taskId))}${repositories}`,
      kind: 'web',
      shortened: true,
      note: 'This task is too long for a link, so it opens with a short request. Claude needs the FORGE connector to read the rest.',
    };
  }
  const promptUrl = `${base}/api/bridge/tasks/${taskId}/brief${slug === null ? '' : `?login=${login}`}`;
  return {
    rail: 'claude-code',
    href: `https://claude.ai/code?prompt_url=${encode(promptUrl)}${repositories}`,
    kind: 'web',
    shortened: true,
  };
}

function claudeCli({ taskId, brief, login }: LaunchInput): Launch {
  const slug = forkSlug(login);
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

function codex({ brief, login }: LaunchInput): Launch {
  const slug = forkSlug(login);
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

function antigravity({ taskId }: LaunchInput): Launch {
  return {
    rail: 'antigravity',
    href: null,
    kind: 'steps',
    shortened: false,
    steps: [
      'Open your fork in Antigravity.',
      'The FORGE connector is already set up in the repo.',
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
