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
import { UPSTREAM_REPO } from '@forge/shared';
import type { CredentialKind, RailMeta, StartRail } from '@forge/shared';

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
 * The link behind one of a rail's setup steps (RAIL_REGISTRY copy), or null
 * for a step that is only words. The Copilot app step has no link while the
 * server has no GITHUB_APP_SLUG, rather than one that leads nowhere.
 */
export function setupStepLink(meta: Pick<RailMeta, 'keyUrl'>, step: string, appSlug: string | null): StepLink | null {
  if (FORK_STEP.test(step)) return { href: FORK_URL, external: true };
  if (APP_STEP.test(step)) {
    const install = githubAppInstallUrl(appSlug);
    return install === null ? null : { href: install, external: true };
  }
  if (CONNECT_STEP.test(step)) return { href: CONNECT_PATH, external: false };
  if (meta.keyUrl !== undefined && KEY_STEP.test(step)) return { href: meta.keyUrl, external: true };
  return null;
}

/**
 * A rail's one-time setup steps as this server can honour them. The routine's
 * last step promises FORGE keeps the URL and token, which is only true while
 * FORGE can save keys (`vault`).
 */
export function setupSteps(meta: Pick<RailMeta, 'id' | 'setup'>, vault: boolean): readonly string[] {
  if (meta.id !== 'claude-routine' || vault) return meta.setup;
  return meta.setup.map((step) =>
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
  /** `dispatch_limit`: the API's Retry-After, in seconds. */
  retryAfterSeconds?: number;
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
  'not_holder',
  'not_claimed',
  'unauthenticated',
  'practice_session',
  'bad_origin',
  'bridge-disabled',
  'service_unreachable',
  'not_configured',
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

/** True for a rail FORGE can pass the checks' notes on to. */
export function canRelayNotes(rail: string): boolean {
  return RELAY_RAILS.has(rail);
}

/** "Try again in about 12 minutes", from a Retry-After in seconds. */
function retryWords(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return 'Wait a little, then try again.';
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/** The sentence for a start ("Start it for me") that did not happen. */
export function describeStartError(failure: Failure, meta: DescribedRail): string {
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
        : `${label} isn't connected to your fork yet. Finish the setup steps above, then try again.`;
    }
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

/** The sentence for a claim that did not happen. */
export function describeClaimError(code: string): string {
  switch (code) {
    case 'already_claimed':
      return 'Someone claimed this one first. Have a look at the others.';
    case 'claim_limit':
      return 'You already hold as many tasks as FORGE allows at once. Finish or release one, then claim this.';
    default:
      return common(code) ?? "That didn't save, so nothing was changed. Please try again.";
  }
}

/** The sentence for anything else on a task you hold: release, notes, submit. */
export function describeTaskError(code: string): string {
  switch (code) {
    case 'invalid_pr_url':
      return "That isn't a link to a pull request on verastd/forge-app.";
    case 'pr_not_found':
      return 'GitHub has no pull request at that link.';
    case 'not_your_pr':
      return "That pull request comes from someone else's fork.";
    default:
      return common(code) ?? "That didn't work, so nothing changed. Please try again.";
  }
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
 * `value` if it is an https URL with no credentials in it (and, when `hosts`
 * is given, on one of those hosts), else null. Every link the progress view
 * renders from an API answer goes through this.
 */
export function safeHttpsUrl(value: string | undefined, hosts?: readonly string[]): string | null {
  if (value === undefined || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  if (hosts !== undefined && !hosts.includes(url.hostname)) return null;
  return url.toString();
}
