'use client';

/**
 * The ledger's app frame, assembled the way the Embers kit assembles its
 * shell (ui_kits/embers/index.html + ShellScreen): AppShell with the TopBar
 * (search, UTC/LA clocks, theme), the SidebarNav (one group, favorites,
 * Live badge) and the same nav in the <dialog> drawer below 1024px.
 *
 * Search follows the TopBar contract: 3-character minimum (or a property
 * id), 250 ms debounce, recent history, loading / results / empty / error
 * with Retry. Results come from the ledger's `/search`.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AppShell, Icon, SidebarNav, TopBar, useEmbersTheme } from '@forge/ui';
import type { NavGroup, NavItem, NavLinkRenderProps, TopBarSearchRow, TopBarSearchStatus } from '@forge/ui';
import type { SearchResult, Status } from '@forge/upland-ledger';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { HostAccountControls, LOBBY_HREF, PRODUCT_NAME } from '../_lib/forge-adapter';
import { hrefWith, isPropertyId } from '../_lib/filters';
import { formatUpx } from '../_lib/format';
import { chainFreshness } from '../_lib/market';
import { useDebouncedValue, useLedgerQuery } from '../_lib/hooks';
import { queryKey } from '../_lib/query-core';
import { routes } from './links';
import { ToastProvider } from './toasts';

const STORE = { recent: 'upland-ledger:recent-search', favorites: 'upland-ledger:favorites', groups: 'upland-ledger:open-groups' };
const MIN_QUERY = 3;
const PER_KIND = 5;

/** The Overview item carries the Live badge only while the chain feed really is live. */
const navGroups = (live: boolean): NavGroup[] => [
  {
    id: 'ledger',
    label: 'Upland Ledger',
    icon: 'chart-line',
    items: [
      { label: 'Overview', href: routes.overview, icon: 'house', live },
      { label: 'Properties', href: routes.properties, icon: 'building-2' },
      { label: 'Market', href: routes.market, icon: 'chart-line' },
      { label: 'Opportunities', href: routes.opportunities, icon: 'sparkles' },
    ],
  },
];

function readStored<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Blocked storage: the preference lasts for this visit only.
  }
}

const isRows = (v: unknown): v is TopBarSearchRow[] =>
  Array.isArray(v) && v.every((r) => typeof r === 'object' && r !== null && typeof (r as TopBarSearchRow).label === 'string' && typeof (r as TopBarSearchRow).href === 'string' && (r as TopBarSearchRow).href!.startsWith('/'));
const isItems = (v: unknown): v is NavItem[] =>
  Array.isArray(v) && v.every((r) => typeof r === 'object' && r !== null && typeof (r as NavItem).label === 'string' && typeof (r as NavItem).href === 'string' && (r as NavItem).href.startsWith('/'));
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** Nav items as Next links (client navigation), same look. */
function renderLink({ href, className, style, children, ...rest }: NavLinkRenderProps) {
  return (
    <Link href={href} className={className} style={style} aria-current={(rest as { 'aria-current'?: 'page' })['aria-current']}>
      {children}
    </Link>
  );
}

function activeHref(pathname: string): string | undefined {
  const items = navGroups(false).flatMap((g) => g.items);
  const exact = items.find((i) => i.href === pathname);
  if (exact) return exact.href;
  return items.filter((i) => i.href !== routes.overview && pathname.startsWith(i.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

function searchRows(r: SearchResult): TopBarSearchRow[] {
  return [
    ...(r.properties ?? []).map((p) => ({
      label: [p.address || `#${p.property_id}`, p.city].filter(Boolean).join(', ') + (p.mint_price_upx > 0 ? ` · mint ${formatUpx(p.mint_price_upx, { compact: true })}` : ''),
      kind: 'Property',
      icon: 'building-2' as const,
      href: routes.property(p.property_id),
    })),
    ...(r.accounts ?? []).map((a) => ({
      label: a.username && a.username !== a.account ? `${a.account} · ${a.username}` : a.account,
      kind: 'Account',
      icon: 'user' as const,
      href: routes.account(a.account),
    })),
    ...(r.cities ?? []).map((c) => ({
      label: [c.name, c.state_name, c.country_name].filter(Boolean).join(', '),
      kind: 'City',
      icon: 'map-pin' as const,
      href: hrefWith(routes.market, { city: c.name }),
    })),
    ...(r.neighborhoods ?? []).map((n) => ({
      label: n.name,
      kind: 'Neighborhood',
      icon: 'map' as const,
      href: hrefWith(routes.market, { neighborhood: n.name }),
    })),
  ];
}

export function LedgerShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const { theme, setTheme } = useEmbersTheme();
  // Same key as the Overview's read, so the two share one request and cache.
  const chain = useLedgerQuery<Status>('/status', (c, signal) => c.status(undefined, { signal }));
  const live = chain.data !== undefined && chainFreshness(chain.data).health === 'live';
  const groups = useMemo(() => navGroups(live), [live]);

  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<TopBarSearchRow[]>([]);
  const [favorites, setFavorites] = useState<NavItem[]>([]);
  const [openGroups, setOpenGroups] = useState<string[]>(['fav', 'ledger']);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setRecent(readStored(STORE.recent, [], isRows));
    setFavorites(readStored(STORE.favorites, [], isItems));
    setOpenGroups(readStored(STORE.groups, ['fav', 'ledger'], isStrings));
  }, []);
  useEffect(() => setDrawerOpen(false), [pathname]);

  const settled = useDebouncedValue(query.trim(), 250);
  const ready = settled.length >= MIN_QUERY || (isPropertyId(settled) && settled.length > 0);
  const search = useLedgerQuery<SearchResult>(ready ? queryKey('/search', { q: settled, limit: PER_KIND }) : null, (c, signal) =>
    c.search({ q: settled, limit: PER_KIND }, { signal }),
  );
  const results = useMemo(() => (search.data ? searchRows(search.data) : []), [search.data]);
  const typing = query.trim() !== settled;
  const status: TopBarSearchStatus =
    query.trim().length === 0
      ? 'idle'
      : typing || search.view === 'loading' || search.fetching
        ? 'loading'
        : search.view === 'error' || search.view === 'unauthenticated'
          ? 'error'
          : results.length === 0
            ? 'empty'
            : 'results';

  const pick = useCallback(
    (row: TopBarSearchRow) => {
      if (!row.href) return;
      const next = [{ label: row.label, href: row.href, kind: row.kind, icon: row.icon }, ...recent.filter((r) => r.href !== row.href)].slice(0, 5);
      setRecent(next);
      writeStored(STORE.recent, next);
      setQuery('');
      router.push(row.href);
    },
    [recent, router],
  );

  const toggleGroup = useCallback((id: string) => {
    setOpenGroups((list) => {
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      writeStored(STORE.groups, next);
      return next;
    });
  }, []);
  const toggleFavorite = useCallback((item: NavItem) => {
    setFavorites((list) => {
      const next = list.some((f) => f.href === item.href) ? list.filter((f) => f.href !== item.href) : [...list, { label: item.label, href: item.href }];
      writeStored(STORE.favorites, next);
      return next;
    });
  }, []);

  const nav = (
    <SidebarNav
      groups={groups}
      activeHref={activeHref(pathname)}
      openGroups={openGroups}
      onToggleGroup={toggleGroup}
      favorites={favorites}
      onToggleFavorite={toggleFavorite}
      renderLink={renderLink}
    />
  );

  return (
    <AppShell
      style={{ minHeight: '100dvh' }}
      topBar={
        <TopBar
          query={query}
          onQueryChange={setQuery}
          searchStatus={status}
          results={results}
          recent={recent}
          onPick={pick}
          onSearchRetry={() => void search.refetch()}
          theme={theme}
          onTheme={setTheme}
          onMenu={() => setDrawerOpen(true)}
          leading={
            <Link
              href={LOBBY_HREF}
              aria-label="Back to the lobby"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, font: 'var(--type-label)', color: 'var(--text-secondary)', textDecoration: 'none' }}
            >
              <Icon name="arrow-left" size={14} />
              Lobby
            </Link>
          }
          brand={
            <Link href={routes.overview} style={{ font: 'var(--type-title)', color: 'var(--text-primary)', textDecoration: 'none', marginRight: 8, whiteSpace: 'nowrap' }}>
              {PRODUCT_NAME}
            </Link>
          }
          trailing={<HostAccountControls />}
        />
      }
      sidebar={nav}
      drawer={nav}
      drawerOpen={drawerOpen}
      onDrawerClose={() => setDrawerOpen(false)}
      drawerTitle={PRODUCT_NAME}
      footer="Upland chain and market data from the Upland Ledger. An independent tool, not affiliated with Upland. Market figures and signals are advisory."
    >
      <ToastProvider>{children}</ToastProvider>
    </AppShell>
  );
}
