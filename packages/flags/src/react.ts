'use client';

/**
 * @forge/flags/react — React hooks for the flag client.
 *
 * Kept out of the main entry point so `@forge/flags` itself stays
 * server-safe (no react import there). Import this subpath only from
 * client components.
 *
 * Imports come from `./core.js`, never `./index.js`: the index owns
 * `loadFlags` and therefore the `node:` built-ins, and pulling it in here
 * would drag them into every browser bundle.
 */
import { useEffect, useState } from 'react';
import type { FlagConfig, FlagName } from '@forge/shared';

import { DEFAULT_FLAGS, fetchFlags } from './core.js';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

export interface UseFlagsResult {
  flags: FlagConfig;
  loading: boolean;
}

/**
 * Fetch `${NEXT_PUBLIC_API_URL}/api/flags` on mount and return the
 * resolved flag config. Falls back to `initial ?? DEFAULT_FLAGS` — both
 * as the initial render state and on any network/parse error — and never
 * throws into the caller. A flag service that hasn't answered within
 * `FLAGS_TIMEOUT_MS` (8 s) counts as no answer: the fallback applies and
 * `loading` ends, so no page waits on its flags for longer than that.
 *
 * That fallback IS this hook's fail-closed behavior: `DEFAULT_FLAGS` is
 * all false, so an API that's unreachable, slow, or returning garbage
 * renders as every flag off rather than quietly falling back to "on". Do
 * not give this hook a masking fallback (e.g. treating a fetch error as
 * "assume enabled") — an unreachable flags endpoint must read the same as
 * a deliberately-disabled kill switch.
 */
export function useFlags(initial?: FlagConfig): UseFlagsResult {
  const [flags, setFlags] = useState<FlagConfig>(initial ?? DEFAULT_FLAGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // fetchFlags never throws, and gives up (null) after FLAGS_TIMEOUT_MS.
    void fetchFlags(`${API_BASE}/api/flags`).then((answer) => {
      if (!cancelled) {
        setFlags(answer ?? initial ?? DEFAULT_FLAGS);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
    // `initial` is intentionally read only as the mount-time fallback, so
    // it is deliberately not listed as an effect dependency.
  }, []);

  return { flags, loading };
}

/** Convenience wrapper around {@link useFlags} for a single flag. */
export function useFlag(name: FlagName, initial?: FlagConfig): boolean {
  const { flags } = useFlags(initial);
  return flags[name];
}
