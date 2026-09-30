/**
 * The Content-Security-Policy for framed apps' routes, built for
 * next.config.mjs `headers()`.
 *
 * Why a whole policy and not just a `frame-src` rule: the site-wide policy
 * today is "frame-ancestors 'none'", and when several Next.js header rules
 * match a path and set the same key, the LAST one wins. A per-route rule
 * holding only `frame-src` would silently drop `frame-ancestors 'none'` on
 * exactly the pages that embed third-party content. So each rule carries
 * the base policy with `frame-src` added.
 */

import { frameOrigin, isHostName, isValidSlug } from './registry.js';
import type { AppEntry } from './registry.js';

/**
 * `baseCsp` with its `frame-src` directive added, or replaced, allowing
 * exactly `origin`. Every other directive is kept as written and in order.
 *
 * Throws unless `origin` is a bare `https://<lowercase host>` origin: no
 * path, port, wildcard, quote, semicolon, comma or whitespace. That is the
 * guard against directive injection ('https://a.example; script-src *').
 * Also throws on a `baseCsp` holding a comma (several policies in one
 * value, which one `frame-src` can't cover) or a control character (a
 * header-splitting attempt).
 */
export function cspWithFrameSrc(baseCsp: string, origin: string): string {
  if (typeof origin !== 'string' || !origin.startsWith('https://') || !isHostName(origin.slice('https://'.length))) {
    throw new Error(`cspWithFrameSrc: ${JSON.stringify(String(origin))} is not a bare https://host origin`);
  }
  if (typeof baseCsp !== 'string' || baseCsp.includes(',') || hasControlCharacter(baseCsp)) {
    throw new Error('cspWithFrameSrc: the base policy must be one policy with no commas or control characters');
  }
  const frameSrc = `frame-src ${origin}`;
  const directives: string[] = [];
  let placed = false;
  for (const raw of baseCsp.split(';')) {
    const directive = raw.trim();
    if (directive === '') {
      continue;
    }
    const name = directive.split(/\s+/, 1)[0]?.toLowerCase();
    if (name !== 'frame-src') {
      directives.push(directive);
    } else if (!placed) {
      // Replace in place. Browsers ignore any repeat of a directive, so
      // repeats are dropped rather than left to mislead a reader.
      directives.push(frameSrc);
      placed = true;
    }
  }
  if (!placed) {
    directives.push(frameSrc);
  }
  return directives.join('; ');
}

/**
 * One header rule per framed app, `{ source: '/apps/<slug>', headers: [CSP] }`,
 * where the CSP is `baseCsp` plus `frame-src <that app's origin>`. The shipped
 * APPS frame nothing, so this returns [] today.
 *
 * ORDER MATTERS: put these rules AFTER the site-wide rule in `headers()`. The
 * last matching rule wins for a given key, so an app's rule has to come later
 * to replace the site-wide policy on its route. Each rule still carries the
 * whole base policy, so nothing in it is lost.
 *
 * Throws for a framed entry whose slug or route is invalid, rather than emit
 * a broad `source` pattern or an origin nobody checked. Run validateRegistry
 * as well: this checks only what the header needs.
 */
export function framedAppHeaderRules(
  apps: readonly AppEntry[],
  baseCsp: string,
): Array<{ source: string; headers: Array<{ key: string; value: string }> }> {
  const rules: Array<{ source: string; headers: Array<{ key: string; value: string }> }> = [];
  for (const app of apps) {
    if (app.hosting !== 'framed') {
      continue;
    }
    if (!isValidSlug(app.slug)) {
      throw new Error(`framedAppHeaderRules: ${JSON.stringify(String(app.slug))} is not a valid slug`);
    }
    // Non-null: frameOrigin returns null only for apps that aren't framed, and throws on a bad route.
    const origin = frameOrigin(app) as string;
    rules.push({
      source: `/apps/${app.slug}`,
      headers: [{ key: 'Content-Security-Policy', value: cspWithFrameSrc(baseCsp, origin) }],
    });
  }
  return rules;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}
