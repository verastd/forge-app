/**
 * @forge/flags — feature-flag client (PRD Appendix A.1, H.2).
 *
 * Server-safe entry point: re-exports the browser-safe core (`./core`) and
 * adds {@link loadFlags}, the only function that touches the filesystem. The
 * `node:` built-ins it needs are imported *inside* that function so bundlers
 * targeting the browser never have to resolve them — that is what keeps
 * `@forge/flags/react` (which imports only from `./core`) client-safe without
 * any webpack aliasing in apps/web. No React import here either (see
 * `./react` for the hooks subpath). Feature work lands behind a flag from this
 * package unless a spec says otherwise (AGENTS.md Style).
 */
export { DEFAULT_FLAGS, isEnabled, parseFlags } from './core.js';
export type { FlagConfig, FlagName } from './core.js';

import { FLAG_NAMES } from '@forge/shared';

import { DEFAULT_FLAGS } from './core.js';
import type { FlagConfig } from './core.js';

const MAX_WALK_UP_LEVELS = 5;

export interface LoadFlagsOptions {
  /** Explicit path to a flags JSON file. Stands in for FORGE_FLAGS_PATH. */
  configPath?: string;
  /** Environment to read FORGE_FLAGS_JSON / FORGE_FLAGS_PATH from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** One layer's contribution: either the known-flag keys it validly set, or
 * why it was rejected. `ok: false` is what drives the fail-closed path in
 * {@link loadFlags} — it is never used to silently skip the layer. */
type LayerOutcome =
  | { readonly ok: true; readonly partial: Partial<FlagConfig> }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the effective {@link FlagConfig}, never throwing. Every layer
 * below is attempted, in order, regardless of whether an earlier one was
 * present — later layers merge over earlier ones, stating only what they
 * change (mirrors `apps/api/src/forge_api/services/flags.py::get_flags`,
 * kept in lockstep on purpose):
 *
 * 1. {@link DEFAULT_FLAGS} (all false) — the base.
 * 2. The nearest `config/flags.json`, found by walking up from
 *    `process.cwd()` (max {@link MAX_WALK_UP_LEVELS} levels) so it works
 *    from `apps/web`, `packages/*`, or the repo root.
 * 3. `configPath ?? env.FORGE_FLAGS_PATH` — an explicit file path.
 * 4. `env.FORGE_FLAGS_JSON` — a JSON object as a string.
 *
 * A layer that is simply ABSENT (no file found by the walk-up, an unset
 * env var) is skipped — that is normal, not an error. A layer that is
 * PRESENT but INVALID — unparseable JSON, an explicit path that can't be
 * read, a top-level value that isn't a JSON object, or a *known* flag key
 * holding a non-boolean value — fails the entire resolution closed: this
 * function returns all-false immediately, without consulting any later
 * layer and without keeping whatever earlier layers had already
 * contributed, and logs the reason once via `console.warn`. A flag lookup
 * silently defaulting to "on" because of a typo'd override is exactly the
 * failure mode this module exists to prevent. Unknown keys in an
 * otherwise-valid object are ignored (forward compat).
 *
 * Server-only: calling this in a browser bundle would try to import
 * `node:fs/promises` at runtime.
 */
export async function loadFlags(opts: LoadFlagsOptions = {}): Promise<FlagConfig> {
  const env = opts.env ?? process.env;
  const resolved: FlagConfig = { ...DEFAULT_FLAGS };

  const repoConfigPath = await findNearestFlagsConfig(process.cwd());
  if (repoConfigPath) {
    const layer = await readJsonFileLayer(repoConfigPath);
    if (!layer.ok) {
      return failClosed(`config/flags.json ${layer.reason}`);
    }
    // layer.partial is coerceLayer()'s output: only keys in FLAG_NAMES
    // survive, each already checked boolean — no arbitrary/prototype key
    // (__proto__, constructor, ...) can reach this call.
    Object.assign(resolved, layer.partial); // nosemgrep: javascript.lang.security.insecure-object-assign.insecure-object-assign
  }

  const explicitPath = opts.configPath ?? env.FORGE_FLAGS_PATH;
  if (explicitPath) {
    const layer = await readJsonFileLayer(explicitPath);
    if (!layer.ok) {
      return failClosed(`FORGE_FLAGS_PATH ${layer.reason}`);
    }
    // layer.partial is coerceLayer()'s output: only keys in FLAG_NAMES
    // survive, each already checked boolean — no arbitrary/prototype key
    // (__proto__, constructor, ...) can reach this call.
    Object.assign(resolved, layer.partial); // nosemgrep: javascript.lang.security.insecure-object-assign.insecure-object-assign
  }

  const rawJson = env.FORGE_FLAGS_JSON;
  if (rawJson) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(rawJson);
    } catch {
      return failClosed('FORGE_FLAGS_JSON is not valid JSON');
    }
    const layer = coerceLayer(candidate);
    if (!layer.ok) {
      return failClosed(`FORGE_FLAGS_JSON ${layer.reason}`);
    }
    // layer.partial is coerceLayer()'s output: only keys in FLAG_NAMES
    // survive, each already checked boolean — no arbitrary/prototype key
    // (__proto__, constructor, ...) can reach this call.
    Object.assign(resolved, layer.partial); // nosemgrep: javascript.lang.security.insecure-object-assign.insecure-object-assign
  }

  return resolved;
}

/** Log the fail-closed reason once and return all flags off. */
function failClosed(reason: string): FlagConfig {
  console.warn(`@forge/flags: ${reason} — failing closed (all flags disabled)`);
  return { ...DEFAULT_FLAGS };
}

/**
 * Validate a single already-JSON-parsed layer value. Unlike {@link parseFlags},
 * this never substitutes defaults for a bad value — a known flag key holding
 * a non-boolean, or a non-object top level, is always reported as `ok: false`
 * so the caller can fail the *whole* resolution closed instead of merging a
 * partially-salvaged layer.
 */
function coerceLayer(candidate: unknown): LayerOutcome {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'top-level value is not a JSON object' };
  }
  const record = candidate as Record<string, unknown>;
  const partial: Partial<FlagConfig> = {};
  for (const name of FLAG_NAMES) {
    if (!(name in record)) {
      continue;
    }
    const value = record[name];
    if (typeof value === 'boolean') {
      partial[name] = value;
    } else {
      return { ok: false, reason: `flag "${name}" is not a boolean` };
    }
  }
  return { ok: true, partial };
}

/** Read + parse + validate one JSON file as a flags layer. A missing or
 * unreadable file is reported the same as malformed JSON — for a path a
 * caller pointed at deliberately (repo config or FORGE_FLAGS_PATH), "the
 * file isn't there" is a configuration failure, not an absent source. */
async function readJsonFileLayer(path: string): Promise<LayerOutcome> {
  const { readFile } = await import('node:fs/promises');
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return { ok: false, reason: `could not be read: ${path}` };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(contents);
  } catch {
    return { ok: false, reason: `is not valid JSON: ${path}` };
  }
  return coerceLayer(candidate);
}

/**
 * Walk up from `startDir` (inclusive) looking for `config/flags.json`, up
 * to {@link MAX_WALK_UP_LEVELS} directories above it. Returns the first
 * match, or `undefined` if none is found before the filesystem root.
 */
async function findNearestFlagsConfig(startDir: string): Promise<string | undefined> {
  const { access } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');

  let dir = startDir;
  for (let level = 0; level <= MAX_WALK_UP_LEVELS; level += 1) {
    const candidate = join(dir, 'config', 'flags.json');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not here — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}
