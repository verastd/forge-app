'use client';

/**
 * Draft vs applied filters, with the applied set in the URL. Typing edits
 * the draft; Apply (or Enter) writes the URL, which is what the page's
 * queries read. Reset clears both.
 *
 * The URL is written with history.replaceState, which Next 15 syncs into
 * useSearchParams without a server round trip, so the new query (and its
 * skeleton) starts in the same frame as the click (PRD 5.9: feedback within
 * 100 ms, even on Slow 3G). router.replace would wait on the network first.
 */
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { hrefWith } from './filters';

export type FilterValues<K extends string> = Record<K, string>;

export function useFilters<K extends string>(keys: readonly K[], extra: Record<string, string | undefined> = {}) {
  const params = useSearchParams();
  const pathname = usePathname() ?? '';

  const applied = useMemo(() => {
    const out = {} as FilterValues<K>;
    for (const k of keys) out[k] = params?.get(k) ?? '';
    return out;
  }, [keys, params]);

  const appliedSig = JSON.stringify(applied);
  const [draftState, setDraftState] = useState<{ sig: string; values: FilterValues<K> }>({ sig: appliedSig, values: applied });
  // When the URL changes underneath (back button, a link), the draft follows it.
  const draft = draftState.sig === appliedSig ? draftState.values : applied;

  const set = useCallback(
    (key: K, value: string) => {
      setDraftState({ sig: appliedSig, values: { ...draft, [key]: value } });
    },
    [appliedSig, draft],
  );

  const dirty = keys.some((k) => draft[k].trim() !== applied[k]);

  // `extra` is usually a fresh literal each render; its contents are what matter.
  const extraSig = JSON.stringify(extra);
  const navigate = useCallback(
    (values: Partial<Record<string, string>>) => {
      const base = JSON.parse(extraSig) as Record<string, string | undefined>;
      const trimmed = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v?.trim()]));
      window.history.replaceState(null, '', hrefWith(pathname, { ...base, ...trimmed }));
    },
    [pathname, extraSig],
  );

  const apply = useCallback(() => navigate(draft), [navigate, draft]);
  /** Apply a change right away on top of what's applied (a sortable header click), keeping any unapplied draft. */
  const applyNow = useCallback(
    (patch: Partial<FilterValues<K>>) => {
      const next = { ...applied, ...patch } as FilterValues<K>;
      setDraftState({ sig: JSON.stringify(next), values: { ...draft, ...patch } as FilterValues<K> });
      navigate(next);
    },
    [applied, draft, navigate],
  );
  const reset = useCallback(() => {
    const empty = Object.fromEntries(keys.map((k) => [k, ''])) as FilterValues<K>;
    setDraftState({ sig: appliedSig, values: empty });
    navigate({});
  }, [keys, navigate, appliedSig]);

  return { applied, draft, set, dirty, apply, applyNow, reset };
}
