'use client';

/**
 * Search-backed filter fields (COMPONENT_MAP CM-09: "City, neighborhood …
 * autocomplete" on the Embers SearchableSelect). Typing waits for 3
 * characters, settles for 250 ms, then asks the ledger's `/search` for that
 * one kind; the field shows the hint, its in-field spinner, no-results and
 * error-with-Retry states itself.
 */
import { SearchableSelect } from '@forge/ui';
import type { SSOption, SearchableSelectStatus } from '@forge/ui';
import type { SearchResult } from '@forge/upland-ledger';
import { useState } from 'react';

import { useDebouncedValue, useLedgerQuery } from '../_lib/hooks';
import { queryKey } from '../_lib/query-core';

type Kind = 'city' | 'neighborhood';

function options(kind: Kind, r: SearchResult | undefined): SSOption[] {
  if (!r) return [];
  if (kind === 'city') {
    return (r.cities ?? []).map((c) => ({ value: c.name, label: c.name, meta: [c.state_name, c.country_name].filter(Boolean).join(', ') }));
  }
  return (r.neighborhoods ?? []).map((n) => ({ value: n.name, label: n.name }));
}

export function SearchFilterField({
  kind,
  label,
  value,
  onChange,
  width = 220,
}: {
  kind: Kind;
  label: string;
  /** The applied/draft value (a name), '' for none. */
  value: string;
  onChange: (value: string) => void;
  width?: number;
}) {
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query.trim(), 250);
  const ready = settled.length >= 3;
  const search = useLedgerQuery<SearchResult>(ready ? queryKey('/search', { q: settled, kind, limit: 20 }) : null, (c, signal) =>
    c.search({ q: settled, kind, limit: 20 }, { signal }),
  );
  const opts = options(kind, search.data);
  const typing = query.trim() !== settled;
  const status: SearchableSelectStatus = !ready
    ? 'idle'
    : typing || search.view === 'loading' || search.fetching
      ? 'loading'
      : search.view === 'error' || search.view === 'unauthenticated'
        ? 'error'
        : opts.length === 0
          ? 'empty'
          : 'results';
  return (
    <SearchableSelect
      label={label}
      placeholder={`Any ${kind}`}
      size="dense"
      width={width}
      minChars={3}
      query={query}
      onQueryChange={setQuery}
      status={status}
      options={opts}
      error={search.view === 'error' ? 'Search failed' : undefined}
      onRetry={() => void search.refetch()}
      value={value ? { value, label: value } : null}
      onChange={(opt) => {
        onChange(opt?.value ?? '');
        setQuery('');
      }}
    />
  );
}
