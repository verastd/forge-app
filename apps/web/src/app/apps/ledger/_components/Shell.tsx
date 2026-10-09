'use client';

/**
 * Embers AppShell for the ledger: top bar (way back to the host, wordmark,
 * search, theme, the host's account controls), a sidebar of sections, and
 * one content column. Below 1024px the sidebar becomes a native <dialog>
 * drawer with 44px targets; below 640px the theme switch moves into it.
 *
 * Theme is light / dark / system, kept per browser (localStorage, best
 * effort) and applied as `data-theme` on the shell root only, so the rest of
 * the site is untouched.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { HostAccountControls, LOBBY_HREF, PRODUCT_NAME } from '../_lib/forge-adapter';
import { GlobalSearch } from './GlobalSearch';
import { routes } from './links';
import { Badge, Button, Icon, Segment } from './primitives';

export type ThemeChoice = 'light' | 'dark' | 'system';
const THEME_KEY = 'upland-ledger:theme';
const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
] as const;

const NAV: ReadonlyArray<{ href: string; label: string; live?: boolean; match: (path: string) => boolean }> = [
  { href: routes.overview, label: 'Overview', live: true, match: (p) => p === routes.overview },
  { href: routes.properties, label: 'Properties', match: (p) => p.startsWith(routes.properties) },
  { href: routes.market, label: 'Market', match: (p) => p.startsWith(routes.market) },
  { href: routes.opportunities, label: 'Opportunities', match: (p) => p.startsWith(routes.opportunities) },
];

function readTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

function useTheme(): { choice: ThemeChoice; resolved: 'light' | 'dark'; setChoice: (c: ThemeChoice) => void } {
  // Server render and first paint are dark, like the rest of the site; the stored choice applies on mount.
  const [choice, setChoiceState] = useState<ThemeChoice>('dark');
  const [systemDark, setSystemDark] = useState(true);

  useEffect(() => {
    setChoiceState(readTheme());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    const on = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c);
    try {
      window.localStorage.setItem(THEME_KEY, c);
    } catch {
      // Private mode or blocked storage: the choice holds for this visit only.
    }
  }, []);

  return { choice, resolved: choice === 'system' ? (systemDark ? 'dark' : 'light') : choice, setChoice };
}

/** Embers SidebarNav: one collapsible group (this app has four screens), active item marked, Live badge on the chain view. */
function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? '';
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <nav aria-label="Ledger sections" className="em-sidebar">
      <button type="button" className="em-nav-group" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <Icon name="chart-line" size={15} />
        <span>Upland Ledger</span>
        <span className="em-chev">
          <Icon name="chevron-down" size={13} />
        </span>
      </button>
      <ul id={bodyId} className="em-nav-items" hidden={!open}>
        {NAV.map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="em-nav-link" aria-current={item.match(pathname) ? 'page' : undefined} onClick={onNavigate}>
              <span style={{ flex: 1, minWidth: 0 }}>{item.label}</span>
              {item.live && (
                <Badge tone="live" dot>
                  Live
                </Badge>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <p className="em-caption" style={{ padding: '12px 8px 0 14px' }}>
        Account pages open from any account name.
      </p>
    </nav>
  );
}

export function LedgerShell({ children }: { children: ReactNode }) {
  const { choice, resolved, setChoice } = useTheme();
  const drawer = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();

  const openDrawer = (): void => drawer.current?.showModal();
  const closeDrawer = useCallback((): void => drawer.current?.close(), []);
  useEffect(() => closeDrawer(), [pathname, closeDrawer]);

  return (
    <div className="em-root" data-theme={resolved}>
      <header className="em-topbar">
        <Button variant="ghost" icon="menu" aria-label="Open sections" className="em-menu-button" onClick={openDrawer} />
        <Link href={LOBBY_HREF} className="em-topbar-back" aria-label="Back to the lobby">
          <Icon name="arrow-left" size={14} /> <span className="em-topbar-back-label">Lobby</span>
        </Link>
        <Link href={routes.overview} className="em-wordmark" style={{ textDecoration: 'none' }}>
          <span className="em-wordmark-long">{PRODUCT_NAME}</span>
        </Link>
        <GlobalSearch />
        <div className="em-topbar-end">
          <Segment options={THEME_OPTIONS} value={choice} onChange={setChoice} label="Theme" size="dense" className="em-theme-switch" />
          <HostAccountControls />
        </div>
      </header>

      <dialog ref={drawer} className="em-drawer" aria-label="Ledger sections">
        <div className="em-drawer-head">
          <span className="em-wordmark">{PRODUCT_NAME}</span>
          <Button variant="ghost" icon="x" aria-label="Close sections" onClick={closeDrawer} />
        </div>
        <SideNav onNavigate={closeDrawer} />
        <div style={{ padding: '8px 16px 16px', display: 'grid', gap: 6 }}>
          <span className="em-caption">Theme</span>
          <Segment options={THEME_OPTIONS} value={choice} onChange={setChoice} label="Theme" className="em-theme-switch" />
        </div>
      </dialog>

      <div className="em-frame">
        <div className="em-side">
          <SideNav />
        </div>
        <div className="em-main">
          <div className="em-content">{children}</div>
          <footer className="em-footer">
            Upland chain and market data from the Upland Ledger. Not affiliated with Upland. Market figures and signals are
            advisory.
          </footer>
        </div>
      </div>
    </div>
  );
}

/** The same frame, for the flag check and the "not enabled" page (no search, no nav). */
export function LedgerFrame({ children }: { children: ReactNode }) {
  return (
    <div className="em-root" data-theme="dark">
      <header className="em-topbar">
        <Link href={LOBBY_HREF} className="em-topbar-back" aria-label="Back to the lobby">
          <Icon name="arrow-left" size={14} /> <span className="em-topbar-back-label">Lobby</span>
        </Link>
        <span className="em-wordmark">{PRODUCT_NAME}</span>
        <div className="em-topbar-end">
          <HostAccountControls />
        </div>
      </header>
      <div className="em-content" style={{ margin: '0 auto' }}>
        {children}
      </div>
    </div>
  );
}
