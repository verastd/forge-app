'use client';

/**
 * Top-bar search over `/search`: 3-character minimum, 250 ms debounce, so
 * it is never one query per keystroke. States: idle, too short, searching
 * (spinner in the field), results grouped by kind, no matches, error with
 * Retry, and the sign-in prompt on 401.
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { SearchResult } from '@forge/upland-ledger';

import { formatUpx } from '../_lib/format';
import { hrefWith, isPropertyId } from '../_lib/filters';
import { SIGN_IN_HREF } from '../_lib/forge-adapter';
import { useDebouncedValue, useLedgerQuery } from '../_lib/hooks';
import { describeError, queryKey } from '../_lib/query-core';
import { routes } from './links';
import { AsyncButton, Icon, Spinner } from './primitives';
import type { IconName } from './primitives';

const MIN_CHARS = 3;
const PER_KIND = 5;
const RECENT_KEY = 'upland-ledger:recent-search';
const RECENT_MAX = 5;

interface Recent {
  label: string;
  href: string;
}

function readRecent(): Recent[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed
          .filter((r): r is Recent => typeof r === 'object' && r !== null && typeof r.label === 'string' && typeof r.href === 'string' && r.href.startsWith('/'))
          .slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

function rememberRecent(entry: Recent): void {
  try {
    const next = [entry, ...readRecent().filter((r) => r.href !== entry.href)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: recent searches just aren't remembered.
  }
}

export function GlobalSearch({ onNavigate }: { onNavigate?: () => void }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const settled = useDebouncedValue(text.trim(), 250);
  const ready = settled.length >= MIN_CHARS || (isPropertyId(settled) && settled.length > 0);
  const query = useLedgerQuery<SearchResult>(
    ready ? queryKey('/search', { q: settled, limit: PER_KIND }) : null,
    (client, signal) => client.search({ q: settled, limit: PER_KIND }, { signal }),
  );

  useEffect(() => {
    if (!open) return undefined;
    const away = (e: PointerEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const typing = text.trim() !== settled;
  const searching = ready && (query.fetching || typing);
  const pick = (entry: Recent): void => {
    rememberRecent(entry);
    setOpen(false);
    setText('');
    onNavigate?.();
  };
  const showRecent = text.trim() === '' && recent.length > 0;

  return (
    <div className="em-topbar-search" ref={root}>
      <span className="em-search-icon">
        <Icon name="search" size={14} />
      </span>
      <input
        type="search"
        className="em-search-input"
        placeholder="Search properties, accounts, cities…"
        aria-label="Search the ledger"
        aria-expanded={open && text.trim() !== ''}
        aria-controls="ledger-search-results"
        value={text}
        maxLength={120}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setRecent(readRecent());
          setOpen(true);
        }}
      />
      {searching && (
        <span className="em-search-status">
          <Spinner size={14} label="Searching" />
        </span>
      )}
      {open && (text.trim() !== '' || showRecent) && (
        <div id="ledger-search-results" className="em-popover" role="region" aria-label="Search results" aria-live="polite">
          {showRecent ? (
            <>
              <div className="em-popover-group">Recent</div>
              {recent.map((r) => (
                <Link key={r.href} href={r.href} className="em-popover-item" onClick={() => pick(r)}>
                  <span className="em-row" style={{ gap: 8 }}>
                    <Icon name="history" size={14} />
                    {r.label}
                  </span>
                </Link>
              ))}
            </>
          ) : (
            <Results text={text.trim()} ready={ready} typing={typing} query={query} onPick={pick} />
          )}
        </div>
      )}
    </div>
  );
}

function Results({
  text,
  ready,
  typing,
  query,
  onPick,
}: {
  text: string;
  ready: boolean;
  typing: boolean;
  query: ReturnType<typeof useLedgerQuery<SearchResult>>;
  onPick: (entry: Recent) => void;
}) {
  if (text.length < MIN_CHARS && !isPropertyId(text)) {
    return <p className="em-popover-note">Type at least {MIN_CHARS} characters, or a property id.</p>;
  }
  if (!ready || typing || query.view === 'loading') {
    return (
      <p className="em-popover-note">
        <Spinner size={14} label="" /> Searching…
      </p>
    );
  }
  if (query.view === 'unauthenticated') {
    return (
      <p className="em-popover-note">
        Sign in to search the ledger. <Link href={SIGN_IN_HREF}>Sign in</Link>
      </p>
    );
  }
  if (query.view === 'error' && query.error) {
    const copy = describeError(query.error);
    return (
      <div className="em-popover-note" role="alert" style={{ display: 'grid', gap: 6 }}>
        <span>{copy.title}</span>
        {copy.retryable && <AsyncButton size="dense" variant="secondary" label="Retry" pendingLabel="Retrying…" onAction={query.refetch} />}
      </div>
    );
  }
  const r = query.data;
  if (r === undefined) return null;
  const properties = r.properties ?? [];
  const accounts = r.accounts ?? [];
  const cities = r.cities ?? [];
  const neighborhoods = r.neighborhoods ?? [];
  if (properties.length + accounts.length + cities.length + neighborhoods.length === 0) {
    return <p className="em-popover-note">No results for “{text}”.</p>;
  }
  const rows: Array<{ key: string; label: string; detail?: string; href: string; icon: IconName; kind: string }> = [
    ...properties.map((p) => ({
      key: `p:${p.property_id}`,
      label: p.address || `#${p.property_id}`,
      detail: [p.city, p.mint_price_upx > 0 ? `mint ${formatUpx(p.mint_price_upx, { compact: true })}` : ''].filter(Boolean).join(' · '),
      href: routes.property(p.property_id),
      icon: 'building-2' as const,
      kind: 'Property',
    })),
    ...accounts.map((a) => ({
      key: `a:${a.account}`,
      label: a.username && a.username !== a.account ? `${a.account} · ${a.username}` : a.account,
      detail: `${a.buys} buys · ${a.sells} sells`,
      href: routes.account(a.account),
      icon: 'user' as const,
      kind: 'Account',
    })),
    ...cities.map((c) => ({
      key: `c:${c.city_id}`,
      label: c.name,
      detail: [c.state_name, c.country_name].filter(Boolean).join(', '),
      href: hrefWith(routes.market, { city: c.name }),
      icon: 'map-pin' as const,
      kind: 'City',
    })),
    ...neighborhoods.map((n) => ({
      key: `n:${n.neighborhood_id}`,
      label: n.name,
      href: hrefWith(routes.market, { neighborhood: n.name }),
      icon: 'map-pin' as const,
      kind: 'Neighborhood',
    })),
  ];
  return (
    <>
      {rows.map((r) => (
        <Link key={r.key} href={r.href} className="em-popover-item" onClick={() => onPick({ label: r.label, href: r.href })}>
          <span className="em-row" style={{ gap: 8, minWidth: 0, flexWrap: 'nowrap' }}>
            <Icon name={r.icon} size={14} />
            <span style={{ minWidth: 0 }}>
              {r.label}
              {r.detail && <span className="em-caption"> {r.detail}</span>}
            </span>
          </span>
          <span className="em-caption">{r.kind}</span>
        </Link>
      ))}
    </>
  );
}
