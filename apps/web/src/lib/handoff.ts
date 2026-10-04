/**
 * Pure helpers for the Contribute hand-off screens: the plain sentence for
 * every API error code (Phase 4 contract §5), the real links behind each
 * rail's one-time setup steps, the fields each kind of credential needs, and
 * the guards for anything the API relays from an agent or a vendor (links,
 * agent-written text).
 *
 * No React, no fetch: everything here is unit-tested on its own
 * (tests/e2e/launch.spec.ts).
 */
import { RAIL_REGISTRY, START_RAILS, UPSTREAM_REPO, isStartRail } from '@forge/shared';
import type { BridgeStatus, CredentialKind, Rail, RailMeta, StartRail } from '@forge/shared';

/** GitHub's "create a fork" page for the upstream repository. */
export const FORK_URL = `https://github.com/${UPSTREAM_REPO}/fork`;

/** Where people connect their agent to FORGE once (unit W2's page). */
export const CONNECT_PATH = '/connect';

/* --- the Copilot rail's GitHub app ------------------------------------------ */

/** A GitHub App slug: lowercase letters, digits and inner dashes. */
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

/** `value` if it is a usable GitHub App slug (GITHUB_APP_SLUG), else null. */
export function githubAppSlug(value: unknown): string | null {
  return typeof value === 'string' && APP_SLUG.test(value) ? value : null;
}

/** Where to install FORGE's GitHub app, or null when the server has no slug configured. */
export function githubAppInstallUrl(slug: string | null): string | null {
  return slug === null ? null : `https://github.com/apps/${slug}/installations/new`;
}

/* --- setup steps -------------------------------------------------------------- */

export interface StepLink {
  href: string;
  /** Leaves FORGE (opens in a new tab) rather than moving within it. */
  external: boolean;
}

const FORK_STEP = /^Fork forge-app on GitHub\.$/;
const APP_STEP = /FORGE's GitHub app/;
const CONNECT_STEP = /^Connect your agent to FORGE once/;
/** The step that says where the key, or the routine, comes from. */
const KEY_STEP = /API key|routine for your fork/;

/**
 * The page where a rail's key is made, as the API described the rail
 * (`RailInfo.keyUrl`), or null unless it is an https link on the same host as
 * this build's own registry entry for that rail: the API can't send people
 * to a look-alike key page.
 */
function keyPage(meta: Pick<RailMeta, 'id' | 'keyUrl'>): string | null {
  const known = RAIL_REGISTRY.find((rail) => rail.id === meta.id)?.keyUrl;
  if (known === undefined || meta.keyUrl === undefined) return null;
  return safeHttpsUrl(meta.keyUrl, [new URL(known).hostname]);
}

/**
 * The link behind one of a rail's setup steps (RAIL_REGISTRY copy), or null
 * for a step that is only words. The Copilot app step has no link while the
 * server has no GITHUB_APP_SLUG, rather than one that leads nowhere, and the
 * key step has none unless its page passes `keyPage`.
 */
export function setupStepLink(
  meta: Pick<RailMeta, 'id' | 'keyUrl'>,
  step: string,
  appSlug: string | null,
): StepLink | null {
  if (FORK_STEP.test(step)) return { href: FORK_URL, external: true };
  if (APP_STEP.test(step)) {
    const install = githubAppInstallUrl(appSlug);
    return install === null ? null : { href: install, external: true };
  }
  if (CONNECT_STEP.test(step)) return { href: CONNECT_PATH, external: false };
  if (KEY_STEP.test(step)) {
    const page = keyPage(meta);
    return page === null ? null : { href: page, external: true };
  }
  return null;
}

/**
 * A rail's one-time setup steps as this server can honour them. The routine's
 * last step promises FORGE keeps the URL and token, which is only true while
 * FORGE can save keys (`vault`), and "Connect your agent to FORGE once" is
 * left out while the FORGE connector is switched off (`connector`).
 */
export function setupSteps(meta: Pick<RailMeta, 'id' | 'setup'>, vault: boolean, connector = true): readonly string[] {
  const steps = connector ? meta.setup : meta.setup.filter((step) => !CONNECT_STEP.test(step));
  if (meta.id !== 'claude-routine' || vault) return steps;
  return steps.map((step) =>
    step === 'Paste its URL and token here once.' ? 'Paste its URL and token here each time you start it.' : step,
  );
}

/* --- credentials ---------------------------------------------------------------- */

export type CredentialFieldName = 'key' | 'orgId' | 'routineUrl';

export interface CredentialField {
  name: CredentialFieldName;
  label: string;
  /** The schema's limit for this field (CredentialSchema in @forge/shared). */
  maxLength: number;
}

/** Product names people know their keys by (the vendor's name is not always it). */
const KEY_NAMES: Readonly<Record<string, string>> = {
  jules: 'Jules',
  cursor: 'Cursor',
  devin: 'Devin',
  openhands: 'OpenHands',
};

/** "Jules" for a Jules key, and so on; the vendor's name for anything else. */
export function keyName(meta: Pick<RailMeta, 'id' | 'vendor'>): string {
  return KEY_NAMES[meta.id] ?? meta.vendor;
}

/**
 * The fields a start rail needs pasted, in order. Copilot (`github`) needs
 * none: it uses a one-time GitHub authorization instead. `name` is the
 * product the key belongs to (`keyName`).
 */
export function credentialFields(kind: CredentialKind | undefined, name: string): CredentialField[] {
  switch (kind) {
    case 'api_key':
      return [{ name: 'key', label: `Your ${name} API key`, maxLength: 4096 }];
    case 'devin':
      return [
        { name: 'key', label: 'Your Devin API key', maxLength: 4096 },
        { name: 'orgId', label: 'Your Devin organization ID', maxLength: 200 },
      ];
    case 'routine':
      return [
        { name: 'routineUrl', label: "Your routine's URL", maxLength: 500 },
        { name: 'key', label: "Your routine's token", maxLength: 4096 },
      ];
    default:
      return [];
  }
}

/* --- what went wrong, in plain words ------------------------------------------- */

export interface Failure {
  /** The API's (or the web's own) error code. */
  code: string;
  /** `rail_setup_needed`: the API's own sentence, written to be shown as it is. */
  detail?: string;
  /** `rail_failed`: the vendor's HTTP status. */
  upstreamStatus?: number;
  /** `credential_invalid` / `invalid_request`: the field or fields the API found wrong. */
  fields?: readonly string[];
  /** `dispatch_limit`: how many starts an hour FORGE allows. */
  limit?: number;
  /** The wait the API asked for (`Retry-After`, or `retryAfter` in the body), in seconds. */
  retryAfterSeconds?: number;
  /** `already_started`: the session that start opened, unchecked (see `sessionLink`). */
  sessionUrl?: string;
  /** The start used a key FORGE had saved, rather than one pasted just now. */
  usedSavedKey?: boolean;
}

/**
 * Codes the Copilot callback may put in `?start_error=`: the web's own,
 * beside the API's. (`github_not_configured` is this server lacking its
 * GitHub App settings, not the API's `github_unavailable`, which is GitHub
 * not answering the API.)
 */
export const WEB_START_ERRORS = [
  'github_denied',
  'github_failed',
  'github_not_configured',
  'wrong_account',
  'signed_out',
] as const;

/** Every code the task page explains when it comes back in `?start_error=`. */
export const START_ERROR_CODES: ReadonlySet<string> = new Set([
  ...WEB_START_ERRORS,
  'rail_disabled',
  'credential_required',
  'credential_invalid',
  'credential_rejected',
  'rail_setup_needed',
  'rail_failed',
  'dispatch_limit',
  'already_started',
  'not_holder',
  'not_claimed',
  'unauthenticated',
  'practice_session',
  'bad_origin',
  'bridge-disabled',
  'service_unreachable',
  'not_configured',
  'upstream_timeout',
  'github_unavailable',
  'body_too_large',
  'invalid_request',
]);

/** Sentences shared by every kind of request. */
function common(code: string): string | null {
  switch (code) {
    case 'unauthenticated':
      return 'Your sign-in has ended. Sign in again, then try once more.';
    case 'practice_session':
      return "Practice accounts can't do that. Sign in with GitHub to do it for real.";
    case 'bad_origin':
      return "FORGE refused that because it didn't come from this page. Reload the page and try again.";
    case 'service_unreachable':
    case 'not_configured':
      return "FORGE couldn't reach its service just now, so nothing changed. Try again in a minute.";
    case 'upstream_timeout':
      // The API had the request and may still have done it.
      return "FORGE didn't hear back in time, so it may have gone through. Reload the page to see where things stand.";
    case 'bridge-disabled':
      return 'Contributing is switched off just now, so nothing changed.';
    case 'not_holder':
    case 'not_claimed':
      return "This task isn't yours any more, so nothing changed. Claim it again first.";
    case 'too_large':
    case 'body_too_large':
      return "That's too long to send. Check what you pasted.";
    case 'github_unavailable':
      return "GitHub isn't answering FORGE just now, so nothing changed. Try again in a minute.";
    default:
      return null;
  }
}

type DescribedRail = Pick<RailMeta, 'id' | 'label' | 'vendor' | 'credential'>;

function credentialWords(meta: DescribedRail): string {
  switch (meta.credential) {
    case 'devin':
      return 'your Devin API key and organization ID';
    case 'routine':
      return "your routine's URL and token";
    default:
      return `your ${keyName(meta)} API key`;
  }
}

/**
 * The credential fields the API named (`key`, `orgId`, `routineUrl`, or a
 * schema path ending in one, like `credential.orgId`), in words, or null
 * when it named none we know.
 */
function fieldWords(fields: readonly string[] | undefined, meta: DescribedRail): string | null {
  if (fields === undefined) return null;
  const words = new Set<string>();
  for (const field of fields) {
    const name = field.split(/[./]/).pop();
    if (name === 'key') {
      words.add(meta.credential === 'routine' ? "your routine's token" : `your ${keyName(meta)} API key`);
    } else if (name === 'orgId') {
      words.add(`your ${keyName(meta)} organization ID`);
    } else if (name === 'routineUrl') {
      words.add("your routine's URL");
    }
  }
  return words.size === 0 ? null : [...words].join(' or ');
}

/** Whether `fields` (from `invalid_request`) point at the credential at all. */
function aboutCredential(fields: readonly string[] | undefined): boolean {
  return fields?.some((field) => /^(credential|key|orgId|routineUrl)\b/.test(field)) === true;
}

/** The rails whose vendors take follow-up notes on a running session (with a saved key). */
const RELAY_RAILS: ReadonlySet<string> = new Set(['jules', 'cursor', 'devin']);

/**
 * True for a rail whose vendor takes follow-up notes at all. Whether FORGE
 * will pass this task's notes on is the status's own `canRelay`: the same
 * saved key has to be there as the one that started the session.
 */
export function canRelayNotes(rail: string): boolean {
  return RELAY_RAILS.has(rail);
}

/** "Try again in about 12 minutes" (or hours, for a long wait), from a Retry-After in seconds. */
function retryWords(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return 'Wait a little, then try again.';
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes <= 90) return `Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  return `Try again in about ${Math.ceil(seconds / 3600)} hours.`;
}

export interface DescribeOptions {
  /** Where the rail's setup steps are on screen, for `rail_setup_needed` with no sentence of the API's own. */
  steps?: 'above' | 'below';
}

/** The sentence for a start ("Start it for me") that did not happen. */
export function describeStartError(failure: Failure, meta: DescribedRail, options: DescribeOptions = {}): string {
  const { label, vendor } = meta;
  switch (failure.code) {
    case 'credential_rejected':
      if (meta.credential === 'github') {
        return `GitHub didn't accept FORGE's one-time approval for ${label}. Start it again to approve it afresh.`;
      }
      return failure.usedSavedKey === true
        ? `${vendor} didn't accept your saved key, so FORGE removed it. Add it again and try once more.`
        : `${vendor} didn't accept that key. Check it and try again.`;
    case 'credential_required':
      return `${label} needs ${credentialWords(meta)}. Add it and try again.`;
    case 'credential_invalid':
      return `That doesn't look like ${fieldWords(failure.fields, meta) ?? credentialWords(meta)}. Check you copied all of it and try again.`;
    case 'invalid_request':
      return aboutCredential(failure.fields)
        ? `That doesn't look like ${fieldWords(failure.fields, meta) ?? credentialWords(meta)}. Check you copied all of it and try again.`
        : "FORGE couldn't read that request, so nothing was started. Reload the page and try again.";
    case 'rail_setup_needed': {
      // The API writes these to be shown as they are; only control characters go.
      const detail = failure.detail === undefined ? '' : plainText(failure.detail, 600);
      return detail !== ''
        ? detail
        : `${label} isn't connected to your fork yet. Finish the setup steps ${options.steps ?? 'above'}, then try again.`;
    }
    case 'already_started':
      // The API's answer to a second press: the first start went through.
      return `${label} already started on this task a moment ago, so FORGE didn't start it twice.`;
    case 'upstream_timeout':
      return `FORGE didn't hear back in time, so ${label} may have started. Check “Where it is” below before you start it again.`;
    case 'rail_failed':
      return failure.upstreamStatus === undefined
        ? `${vendor} didn't answer properly. Try again in a minute.`
        : `${vendor} didn't answer properly (error ${failure.upstreamStatus}). Try again in a minute.`;
    case 'rail_disabled':
      return `FORGE can't start ${label} right now. Use "Open my agent" below instead.`;
    case 'dispatch_limit':
      return failure.limit === undefined
        ? `You've started agents too many times in the last hour. ${retryWords(failure.retryAfterSeconds)}`
        : `You've started agents ${failure.limit} times in the last hour, the most FORGE allows. ${retryWords(failure.retryAfterSeconds)}`;
    case 'github_denied':
      return `You didn't approve ${label} on GitHub, so nothing was started.`;
    case 'github_failed':
      return "GitHub didn't finish the authorization, so nothing was started. Please try again.";
    case 'github_not_configured':
      return `Starting ${label} isn't available on this server right now. Use "Open my agent" below instead.`;
    case 'wrong_account':
      return "You approved it on GitHub with a different account from the one you're signed in with here, so nothing was started.";
    case 'signed_out':
      return 'Your FORGE sign-in ended before GitHub sent you back, so nothing was started. Sign in and try again.';
    default:
      return common(failure.code) ?? "That didn't work, and nothing was started. Please try again.";
  }
}

function asFailure(failure: string | Failure): Failure {
  return typeof failure === 'string' ? { code: failure } : failure;
}

/** The sentence for a claim that did not happen. */
export function describeClaimError(failure: string | Failure): string {
  const { code, retryAfterSeconds } = asFailure(failure);
  switch (code) {
    case 'already_claimed':
      return 'Someone claimed this one first. Have a look at the others.';
    case 'claim_limit':
      return 'You already hold as many tasks as FORGE allows at once. Finish or release one, then claim this.';
    case 'tier_too_low':
      return 'This task needs a contributor tier above T0; it opens up as you ship work.';
    case 'claim_cooldown':
      return `This task was yours less than a day ago, so you can't claim it again just yet; someone else can take it meanwhile. ${retryWords(retryAfterSeconds)}`;
    case 'claim_rate_limit':
      return `You've claimed as many tasks as FORGE allows in a day. ${retryWords(retryAfterSeconds)}`;
    default:
      return common(code) ?? "That didn't save, so nothing was changed. Please try again.";
  }
}

/**
 * The sentence for anything else on a task you hold: release, the notes,
 * handing in a pull request. `taskId` names the task where the words need it.
 */
export function describeTaskError(failure: string | Failure, taskId?: number): string {
  const { code, retryAfterSeconds } = asFailure(failure);
  switch (code) {
    case 'invalid_pr_url':
      return "That isn't a link to a pull request on verastd/forge-app.";
    case 'pr_not_found':
      return 'GitHub has no pull request at that link.';
    case 'not_your_pr':
      return "That pull request comes from someone else's fork.";
    case 'pr_not_for_task':
      return taskId === undefined
        ? "That pull request isn't for this task. FORGE takes one from your fork, opened after you claimed the task, on the task's branch or naming the task in its title or description."
        : `That pull request isn't for this task. FORGE takes one from your fork, opened after you claimed the task, on the task's branch or with “[#${taskId}]” in its title or “Closes #${taskId}” in its description.`;
    case 'submit_limit':
      return `You've handed in links too often just now. ${retryWords(retryAfterSeconds)}`;
    default:
      return common(code) ?? "That didn't work, so nothing changed. Please try again.";
  }
}

/**
 * Why the checks' notes didn't reach the agent FORGE started, from a refusal.
 * Never "a key you saved" unless that is the reason.
 */
export function describeRelayError(failure: Failure, meta: DescribedRail): string {
  switch (failure.code) {
    case 'dispatch_limit':
      return failure.limit === undefined
        ? `FORGE has called agents for you as often as it allows in an hour, so nothing was sent. ${retryWords(failure.retryAfterSeconds)}`
        : `FORGE has called agents for you ${failure.limit} times in the last hour, the most it allows, so nothing was sent. ${retryWords(failure.retryAfterSeconds)}`;
    case 'credential_rejected':
      return `${meta.vendor} didn't accept your saved key, so nothing was sent. Start ${meta.label} again with your key to send notes later.`;
    case 'rail_failed':
      return failure.upstreamStatus === undefined
        ? `${meta.vendor} didn't take the notes, so nothing was sent. Try again in a minute.`
        : `${meta.vendor} didn't take the notes (error ${failure.upstreamStatus}), so nothing was sent. Try again in a minute.`;
    default:
      return common(failure.code) ?? "That didn't work, so nothing was sent. Please try again.";
  }
}

/**
 * The words for `relayed: false` from a rail the status said FORGE could
 * relay to (`canRelay`): the key was there, so the vendor or the hour's
 * limit stopped it.
 */
export function notRelayedSentence(label: string): string {
  return `Nothing was sent: ${label} didn't take the notes just now. Try again in a few minutes. If your agent has the FORGE connector, it can read these itself.`;
}

/** Plain words for "it started". */
export function startedSentence(label: string): string {
  return `${label} is working on it.`;
}

/* --- the outcome the Copilot callback sends back ------------------------------- */

export type StartOutcome =
  | { kind: 'started'; rail: StartRail }
  | { kind: 'error'; rail: StartRail; failure: Failure };

const STARTABLE_BY_REDIRECT: ReadonlySet<string> = new Set(['copilot']);

/**
 * What `?started=` / `?start_error=` (and `&status=`) on the task page say,
 * or null. Unknown codes read as a generic failure; nothing from the query
 * string is ever shown as text.
 */
export function readStartOutcome(params: {
  started?: string | null;
  startError?: string | null;
  status?: string | null;
}): StartOutcome | null {
  if (typeof params.started === 'string' && STARTABLE_BY_REDIRECT.has(params.started)) {
    return { kind: 'started', rail: params.started as StartRail };
  }
  if (typeof params.startError === 'string' && params.startError !== '') {
    const code = START_ERROR_CODES.has(params.startError) ? params.startError : 'unknown';
    const status = typeof params.status === 'string' && /^[1-5][0-9]{2}$/.test(params.status) ? Number(params.status) : undefined;
    return {
      kind: 'error',
      rail: 'copilot',
      failure: { code, ...(code === 'rail_failed' && status !== undefined ? { upstreamStatus: status } : {}) },
    };
  }
  return null;
}

/* --- untrusted text and links ---------------------------------------------------- */

/** Control characters, line and paragraph separators, and bidirectional overrides. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Agent-written (or vendor-written) text made safe to show: control and
 * bidirectional characters become spaces, whitespace collapses, and anything
 * past `max` characters is cut with an ellipsis. React renders the result as
 * text; this is about what the text can pretend to be.
 */
export function plainText(text: string, max = 500): string {
  const flat = text.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Backslashes, whitespace and control characters: a browser reads `\` as `/`
 * in an https URL, so `https://evil.example\@vendor.example/` opens
 * evil.example while a lax parser sees the vendor's host. None of them
 * belongs in a link FORGE shows.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
const UNSAFE_URL = /[\s\\\u0000-\u001F\u007F-\u009F]/;

/**
 * `value` if it is an https URL with no credentials in it (and, when `hosts`
 * is given, on one of those hosts or a host under one: `devin.ai` takes
 * `app.devin.ai`), else null. The host is the one the browser itself would
 * go to (`new URL`), and anything with a backslash, whitespace or a control
 * character is refused outright. Every link the progress view renders from an
 * API answer goes through this.
 */
export function safeHttpsUrl(value: string | undefined, hosts?: readonly string[]): string | null {
  if (value === undefined || value.length > 2048 || UNSAFE_URL.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const host = url.hostname;
  if (hosts !== undefined && !hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
  return url.href;
}

/**
 * Where each vendor's sessions live: the same hosts the API accepts a
 * session link on (`https_url` in the rail adapters), so "Watch it work"
 * only ever opens the vendor.
 */
export const SESSION_HOSTS: Readonly<Record<StartRail, readonly string[]>> = {
  copilot: ['github.com'],
  jules: ['jules.google.com', 'jules.google'],
  cursor: ['cursor.com'],
  devin: ['devin.ai'],
  openhands: ['app.all-hands.dev'],
  'claude-routine': ['claude.ai'],
};

const ANY_SESSION_HOST: readonly string[] = START_RAILS.flatMap((rail) => SESSION_HOSTS[rail]);

/**
 * A session link ("Watch it work") the API sent for `rail`, if it is an https
 * link to that rail's vendor, else null. With no start rail to go by, any
 * start rail's vendor will do.
 */
export function sessionLink(value: string | undefined, rail: Rail | null | undefined): string | null {
  return safeHttpsUrl(value, rail != null && isStartRail(rail) ? SESSION_HOSTS[rail] : ANY_SESSION_HOST);
}

/* --- reading the status ------------------------------------------------------------ */

type StatusEvents = Pick<BridgeStatus, 'events'>;

function at(event: { at: string }): number {
  const ms = Date.parse(event.at);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * Whether the status records a start of `rail` (a `dispatched` event) at or
 * after `sinceMs`: how the page checks a start it didn't hear back from, and
 * a `?started=copilot` that any link could carry.
 */
export function startedSince(status: StatusEvents, rail: StartRail, sinceMs: number): boolean {
  return status.events.some((event) => event.kind === 'dispatched' && event.rail === rail && at(event) >= sinceMs);
}

/** Whether the status records notes relayed to `rail` at or after `sinceMs`. */
export function relayedSince(status: StatusEvents, rail: StartRail, sinceMs: number): boolean {
  return status.events.some((event) => event.kind === 'relayed' && event.rail === rail && at(event) >= sinceMs);
}

/**
 * The rail FORGE last started for this task (its newest `dispatched` event),
 * or the status's own rail when that is a start rail, or null. The session
 * link and the notes belong to it, whatever was opened since.
 */
export function lastStartRail(status: Pick<BridgeStatus, 'events' | 'rail'>): StartRail | null {
  let newest: StartRail | null = null;
  let newestAt = -Infinity;
  for (const event of status.events) {
    if (event.kind === 'dispatched' && event.rail !== undefined && isStartRail(event.rail) && at(event) >= newestAt) {
      newest = event.rail;
      newestAt = at(event);
    }
  }
  if (newest !== null) return newest;
  return status.rail !== undefined && isStartRail(status.rail) ? status.rail : null;
}

/**
 * Whether the compare link ("open the pull request") can lead anywhere yet:
 * only once the task went to an agent (a start, or an agent opened with it)
 * or an agent said it pushed. Before that there is no branch to compare.
 */
export function showsCompareLink(status: StatusEvents): boolean {
  return status.events.some(
    (event) =>
      event.kind === 'dispatched' ||
      event.kind === 'opened' ||
      (event.source === 'agent' && event.kind === 'progress' && event.stage === 'pushed'),
  );
}
