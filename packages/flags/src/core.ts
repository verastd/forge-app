/**
 * @forge/flags core — the browser-safe half of the flag client.
 *
 * Nothing in this module may import a node built-in, statically or otherwise:
 * it is what `@forge/flags/react` (and therefore every client bundle) pulls in.
 * File-system loading lives in `./index.ts`, which imports `node:*` lazily.
 */
import { FLAG_NAMES, FlagConfigSchema } from '@forge/shared';
import type { FlagConfig, FlagName } from '@forge/shared';

export type { FlagConfig, FlagName } from '@forge/shared';

/**
 * Default state for every known flag — OFF. Flags in this system are a
 * deploy-safety kill switch, not a convenience toggle: an unconfigured or
 * misconfigured deploy must never silently come up "enabled" (an
 * independent assessment found the prior all-true defaults let flags fail
 * open). `config/flags.json` is checked into the repo and stays all-true;
 * that file — not this constant — is what keeps local/demo behavior
 * enabled.
 */
export const DEFAULT_FLAGS: FlagConfig = {
  csv_export: false,
  contribute_bridge: false,
  upland_data: false,
};

/**
 * Validate `input` against {@link FlagConfigSchema}. Never throws, and is
 * fail-closed: there is no path back to "on" for a value this function
 * cannot positively confirm is `true`.
 *
 * - A fully valid config (every known flag present as a boolean; unknown
 *   extra keys are silently stripped by the schema) parses to its exact
 *   values.
 * - A known flag key present with a non-boolean value fails the *whole*
 *   parse closed to {@link DEFAULT_FLAGS} (all false) — no partial salvage
 *   of the other, validly-typed keys. A typo on one kill switch must not
 *   leave a sibling kill switch silently on.
 * - Anything else that fails the schema (non-object input, or an object
 *   whose only problem is missing/unknown keys) merges the known-boolean
 *   keys it does have over {@link DEFAULT_FLAGS} — which, since the
 *   defaults are all false, is equivalent to "false unless a key
 *   affirmatively says true".
 */
export function parseFlags(input: unknown): FlagConfig {
  const parsed = FlagConfigSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_FLAGS };
  }

  const record = input as Record<string, unknown>;
  const merged: FlagConfig = { ...DEFAULT_FLAGS };
  for (const name of FLAG_NAMES) {
    if (!(name in record)) {
      continue;
    }
    const value = record[name];
    if (typeof value === 'boolean') {
      merged[name] = value;
    } else {
      // A known flag key holding a non-boolean is a corrupt/typo'd source,
      // not a partial one — fail the whole thing closed rather than trust
      // the keys that happened to parse.
      return { ...DEFAULT_FLAGS };
    }
  }
  return merged;
}

/** Read a single flag's value out of a resolved {@link FlagConfig}. */
export function isEnabled(flags: FlagConfig, flag: FlagName): boolean {
  return flags[flag];
}
