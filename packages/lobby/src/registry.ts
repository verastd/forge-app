/**
 * The app registry: every app on the wall, and the rules that make an entry
 * safe to show, to link to and to frame.
 *
 * Two kinds of app:
 * - native: a FORGE route under /apps/<slug>, such as the Data app;
 * - framed: an https page on ANOTHER registrable domain, shown at
 *   /apps/<slug> in an iframe sandboxed with `allow-scripts allow-same-origin
 *   allow-forms`. `allow-same-origin` is safe ONLY because validateRegistry
 *   refuses any framed host that could share a registrable domain with FORGE.
 *   Same-site, the framed page could reach FORGE's cookies and storage.
 *
 * Nothing framed ships yet. The rules exist so the first framed app has to
 * pass them.
 */

import { WALL, isGridSlot, sameSlot } from './layout.js';
import type { SlotRef } from './layout.js';

/**
 * What a lit panel shows. Every source is a root-relative path on FORGE's own
 * origin (`/…`), because the scene samples the pixels for the room's light,
 * and a cross-origin image or video would taint that canvas and fail the
 * WebGL upload. Media on a CDN would need `crossOrigin = 'anonymous'` on the
 * element and CORS headers from the CDN before this rule could allow it.
 *
 * A video's `srcLow` is an optional lighter encode (the lobby screen's is
 * 640×360), shown instead of `src` on phones, low-end machines and Save-Data
 * connections.
 */
export type AppMedia =
  | { kind: 'generated' }
  | { kind: 'image'; src: string }
  | { kind: 'video'; src: string; srcLow?: string; poster: string };

export interface AppEntry {
  slug: string;
  title: string;
  description: string;
  /** native: `route` is '/apps/<slug>' or a path under it. framed: `route` is the https page to frame. */
  hosting: 'native' | 'framed';
  route: string;
  slot: SlotRef;
  media: AppMedia;
  /** Lit panels show their media and open their app. Dark ones share the placeholder. */
  lit: boolean;
  /** Framed apps only: sandbox capabilities on top of the default three. */
  sandbox?: { allowPopups?: boolean; allowDownloads?: boolean };
}

/**
 * Everything on the wall today: the Data app, lit, in slot 0 (the bottom
 * panel straight ahead of where the lobby opens), showing the lobby screen
 * video (1280×720, with a 640×360 encode for light clients) until it has
 * media of its own.
 */
export const APPS: readonly AppEntry[] = deepFreeze<readonly AppEntry[]>([
  {
    slug: 'data',
    title: 'Data',
    description: 'Upland blockchain data',
    hosting: 'native',
    route: '/apps/data',
    slot: { col: 0, row: 0 },
    media: {
      kind: 'video',
      src: '/lobby/lobby-screen.mp4',
      srcLow: '/lobby/lobby-screen-360.mp4',
      poster: '/lobby/lobby-screen-poster.jpg',
    },
    lit: true,
  },
]);

/** 1–32 characters of lowercase letters, digits and hyphens, with no hyphen at either end. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A path segment a native route may add under /apps/<slug>. */
const NATIVE_SEGMENT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** Framed paths and media paths: only RFC 3986 unreserved characters between slashes. */
const URL_PATH = /^(?:\/[A-Za-z0-9._~-]*)*$/;
const SANDBOX_BASE = 'allow-scripts allow-same-origin allow-forms';
/** What every media source must be, for validateRegistry's messages. */
const MEDIA_RULE = "must be a root-relative path on FORGE's own origin ('/' then unreserved characters)";

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG.test(slug);
}

/** A lowercase DNS name: dot-separated labels, no trailing dot, no port. */
export function isHostName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 253 &&
    value.split('.').every((label) => HOST_LABEL.test(label))
  );
}

export type ParsedRoute = { ok: true; host: string } | { ok: false; reason: string };

/**
 * Strict parse of an absolute https URL: `https://<lowercase host>` plus an
 * optional path of unreserved characters. No credentials, no port (not even
 * :443), no query and no fragment. Deliberately stricter than the WHATWG URL
 * parser, which silently strips tabs and newlines, reads backslashes as
 * slashes and drops default ports. Anything that parses here means the same
 * thing to a browser.
 */
export function parseHttpsUrl(url: string): ParsedRoute {
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    return { ok: false, reason: 'must be an https: URL' };
  }
  for (let i = 0; i < url.length; i += 1) {
    const code = url.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f || code === 0x5c) {
      return { ok: false, reason: 'must be printable ASCII with no spaces or backslashes' };
    }
  }
  if (url.includes('?')) {
    return { ok: false, reason: 'must not carry a query' };
  }
  if (url.includes('#')) {
    return { ok: false, reason: 'must not carry a fragment' };
  }
  const rest = url.slice('https://'.length);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  if (authority.includes('@')) {
    return { ok: false, reason: 'must not carry credentials' };
  }
  if (authority.includes(':')) {
    return { ok: false, reason: 'must not name a port' };
  }
  if (!isHostName(authority)) {
    return { ok: false, reason: 'must name a lowercase DNS host' };
  }
  if (!URL_PATH.test(path)) {
    return { ok: false, reason: 'may only use unreserved characters (A-Z a-z 0-9 . _ ~ -) in its path' };
  }
  return { ok: true, host: authority };
}

interface RegistryOptions {
  forgeHost?: string;
  allowedSuffixes?: readonly string[];
}

/**
 * Throws, listing every problem, unless `apps` is safe to render, link and
 * frame. It fails closed:
 * - slugs are unique and match /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
 * - slots are unique and inside the 32 × 90 grid (layout.ts), written
 *   canonically;
 * - titles and descriptions are non-empty, `lit` is a boolean, and media
 *   sources (a video's optional `srcLow` included) are root-relative paths
 *   on FORGE's own origin, never a URL with a scheme (see AppMedia);
 * - a native route is internal: '/apps/<slug>' or lowercase segments under
 *   it, which also stops one app claiming another's route;
 * - a framed route is an https URL with no credentials, port, query or
 *   fragment;
 * - framed apps are rejected outright unless BOTH `opts.forgeHost` and
 *   `opts.allowedSuffixes` are supplied;
 * - a framed host must be an allowlisted suffix or sit under one, must not
 *   be `forgeHost` or sit under it, and `forgeHost` must not sit under the
 *   matched suffix's domain (its last two labels). Without the Public Suffix
 *   List that last test is the conservative stand-in for "different
 *   registrable domain". Two hosts that share a registrable domain always
 *   share their last two labels, so it can refuse a safe pair but never
 *   pass an unsafe one.
 * - sandbox opt-ins appear only on framed apps, as booleans.
 */
export function validateRegistry(
  apps: readonly AppEntry[],
  opts?: { forgeHost?: string; allowedSuffixes?: readonly string[] },
): void {
  if (!Array.isArray(apps)) {
    throw new Error('App registry is invalid: it is not an array');
  }
  const options: RegistryOptions = opts ?? {};
  const problems: string[] = [];

  const forgeHost = options.forgeHost;
  if (forgeHost !== undefined && !isHostName(forgeHost)) {
    problems.push(`opts.forgeHost must be a lowercase host name (got ${show(forgeHost)})`);
  }
  const suffixes: string[] = [];
  for (const suffix of options.allowedSuffixes ?? []) {
    const normal = normalizeSuffix(suffix);
    if (normal === null) {
      problems.push(`opts.allowedSuffixes: ${show(suffix)} is not a domain of at least two labels`);
    } else {
      suffixes.push(normal);
    }
  }
  const framing: FramingContext =
    forgeHost !== undefined && options.allowedSuffixes !== undefined
      ? { forgeHost: isHostName(forgeHost) ? forgeHost : null, suffixes }
      : null;

  const slugs = new Set<string>();
  const slots = new Set<string>();
  apps.forEach((app: unknown, index) => {
    const entry = isRecord(app) ? app : null;
    const label = entry && typeof entry.slug === 'string' ? ` (${entry.slug})` : '';
    for (const problem of entryProblems(entry, framing, slugs, slots)) {
      problems.push(`apps[${index}]${label}: ${problem}`);
    }
  });

  if (problems.length > 0) {
    throw new Error(`App registry is invalid:\n- ${problems.join('\n- ')}`);
  }
}

/** The registered app with this slug, if any. Safe to call with untrusted input such as a URL segment. */
export function appBySlug(slug: string): AppEntry | undefined {
  return APPS.find((app) => app.slug === slug);
}

/** The app occupying a slot, if any (the column wraps around the ring). */
export function appAt(slot: SlotRef, apps: readonly AppEntry[] = APPS): AppEntry | undefined {
  return apps.find((app) => sameSlot(app.slot, slot));
}

/**
 * The iframe `sandbox` attribute for a framed app: 'allow-scripts
 * allow-same-origin allow-forms', plus 'allow-popups' and 'allow-downloads'
 * only when the entry opts in with a literal `true`. Never top navigation or
 * modals. Throws for anything that isn't framed: a native app is never put
 * in an iframe.
 */
export function sandboxFor(app: AppEntry): string {
  if (app.hosting !== 'framed') {
    throw new Error(`sandboxFor: ${show(app.slug)} is not a framed app`);
  }
  const tokens = [SANDBOX_BASE];
  if (app.sandbox?.allowPopups === true) {
    tokens.push('allow-popups');
  }
  if (app.sandbox?.allowDownloads === true) {
    tokens.push('allow-downloads');
  }
  return tokens.join(' ');
}

/**
 * The origin a framed app's iframe loads, e.g. 'https://cards.example', or
 * null for a native app. The same value `new URL(route).origin` gives for any
 * route validateRegistry accepts. A framed route this module can't parse
 * strictly throws rather than yield an origin to trust.
 */
export function frameOrigin(app: AppEntry): string | null {
  if (app.hosting !== 'framed') {
    return null;
  }
  const parsed = parseHttpsUrl(app.route);
  if (!parsed.ok) {
    throw new Error(`frameOrigin: ${show(app.slug)}: the route ${parsed.reason}`);
  }
  return `https://${parsed.host}`;
}

type FramingContext = { forgeHost: string | null; suffixes: readonly string[] } | null;

function entryProblems(
  app: Record<string, unknown> | null,
  framing: FramingContext,
  slugs: Set<string>,
  slots: Set<string>,
): string[] {
  if (app === null) {
    return ['is not an object'];
  }
  const problems: string[] = [];

  if (!isValidSlug(app.slug)) {
    problems.push(`slug must match ${SLUG} (got ${show(app.slug)})`);
  } else if (slugs.has(app.slug)) {
    problems.push(`slug "${app.slug}" is already taken`);
  } else {
    slugs.add(app.slug);
  }

  for (const field of ['title', 'description'] as const) {
    const value = app[field];
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${field} must be a non-empty string`);
    }
  }
  if (typeof app.lit !== 'boolean') {
    problems.push('lit must be a boolean');
  }

  const slot = app.slot;
  if (!isRecord(slot) || !isGridSlot(slot as unknown as SlotRef)) {
    problems.push(
      `slot must be whole numbers inside the ${WALL.columns}×${WALL.rows} grid ` +
        `(col 0..${WALL.columns - 1}, row 0..${WALL.rows - 1})`,
    );
  } else {
    const where = `${String(slot.col)},${String(slot.row)}`;
    if (slots.has(where)) {
      problems.push(`slot col ${String(slot.col)}, row ${String(slot.row)} is already taken`);
    } else {
      slots.add(where);
    }
  }

  problems.push(...mediaProblems(app.media));

  const route = typeof app.route === 'string' ? app.route : null;
  if (app.hosting === 'native') {
    if (route === null || !isValidSlug(app.slug) || !isNativeRoute(route, app.slug)) {
      problems.push(
        'a native route must be /apps/<slug> or lowercase segments under it, with no query, fragment ' +
          `or trailing slash (got ${show(app.route)})`,
      );
    }
    if (app.sandbox !== undefined) {
      problems.push('sandbox opt-ins apply only to framed apps');
    }
  } else if (app.hosting === 'framed') {
    problems.push(...framedProblems(app.route, app.sandbox, framing));
  } else {
    problems.push(`hosting must be "native" or "framed" (got ${show(app.hosting)})`);
  }
  return problems;
}

function framedProblems(route: unknown, sandbox: unknown, framing: FramingContext): string[] {
  const problems: string[] = [];
  if (sandbox !== undefined) {
    const valid =
      isRecord(sandbox) &&
      Object.keys(sandbox).every((name) => name === 'allowPopups' || name === 'allowDownloads') &&
      Object.values(sandbox).every((value) => typeof value === 'boolean');
    if (!valid) {
      problems.push('sandbox may only hold allowPopups and allowDownloads, as booleans');
    }
  }
  const parsed = typeof route === 'string' ? parseHttpsUrl(route) : null;
  if (parsed === null || !parsed.ok) {
    problems.push(`a framed route ${parsed?.reason ?? 'must be a string'} (got ${show(route)})`);
    return problems;
  }
  if (framing === null) {
    problems.push(
      'a framed app needs opts.forgeHost and opts.allowedSuffixes to be checked against, so without both it is refused',
    );
    return problems;
  }
  if (framing.forgeHost === null) {
    // The bad forgeHost itself is already reported once, at the top.
    return problems;
  }
  const host = parsed.host;
  const suffix = framing.suffixes.find((candidate) => isUnder(host, candidate));
  if (suffix === undefined) {
    problems.push(`host ${host} is not under any allowlisted suffix`);
  } else if (isUnder(host, framing.forgeHost)) {
    problems.push(`host ${host} is FORGE's own host (${framing.forgeHost}) or sits under it`);
  } else if (isUnder(framing.forgeHost, registrableStandIn(suffix))) {
    problems.push(
      `FORGE's host ${framing.forgeHost} sits under ${registrableStandIn(suffix)}, the domain of the matched ` +
        `suffix ${suffix}, so it could share a registrable domain with ${host}`,
    );
  }
  return problems;
}

function mediaProblems(media: unknown): string[] {
  if (!isRecord(media)) {
    return ['media must be an object'];
  }
  switch (media.kind) {
    case 'generated':
      return [];
    case 'image':
      return isMediaSource(media.src) ? [] : [`media.src ${MEDIA_RULE}`];
    case 'video': {
      const problems: string[] = [];
      if (!isMediaSource(media.src)) {
        problems.push(`media.src ${MEDIA_RULE}`);
      }
      if (media.srcLow !== undefined && !isMediaSource(media.srcLow)) {
        problems.push(`media.srcLow ${MEDIA_RULE}`);
      }
      if (!isMediaSource(media.poster)) {
        problems.push(`media.poster ${MEDIA_RULE}`);
      }
      return problems;
    }
    default:
      return [`media.kind must be "generated", "image" or "video" (got ${show(media.kind)})`];
  }
}

/** '/…' on FORGE's own origin: never '//' (another host), and never a scheme (see AppMedia). */
function isMediaSource(src: unknown): boolean {
  return typeof src === 'string' && src.startsWith('/') && !src.startsWith('//') && URL_PATH.test(src);
}

function isNativeRoute(route: string, slug: string): boolean {
  const prefix = `/apps/${slug}`;
  if (route === prefix) {
    return true;
  }
  if (!route.startsWith(`${prefix}/`)) {
    return false;
  }
  return route
    .slice(prefix.length + 1)
    .split('/')
    .every((segment) => NATIVE_SEGMENT.test(segment));
}

/** An allowlist entry as a bare domain ('.apps.example' and 'apps.example' are the same), or null if unusable. */
function normalizeSuffix(suffix: unknown): string | null {
  if (typeof suffix !== 'string') {
    return null;
  }
  const bare = suffix.startsWith('.') ? suffix.slice(1) : suffix;
  if (!isHostName(bare)) {
    return null;
  }
  const labels = bare.split('.');
  // A bare TLD would allowlist half the internet, and an all-digit last label
  // is an IP address, not a domain. (split() always returns at least one label.)
  if (labels.length < 2 || /^\d+$/.test(labels[labels.length - 1]!)) {
    return null;
  }
  return bare;
}

/** `host` is `domain` itself or a subdomain of it, matched on whole labels. */
function isUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The last two labels: never narrower than the real registrable domain (see validateRegistry). */
function registrableStandIn(name: string): string {
  return name.split('.').slice(-2).join('.');
}

/** A value for an error message. JSON.stringify would throw on a BigInt and say nothing useful for a symbol. */
function show(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
