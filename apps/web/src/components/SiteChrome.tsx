'use client';

/**
 * Picks the page shell from the URL (Phase 2 addendum's cross-unit
 * contract):
 *
 * - "site" — the normal site nav plus footer. Everything not under /apps.
 * - "lobby" — /apps exactly. The same site nav, but no footer, so the list
 *   page (and, from Phase 3, the full-bleed 3D lobby) owns the rest of the
 *   viewport.
 * - "app" — any /apps/<slug> route. No site nav, no footer: the app renders
 *   its own AppBar instead (see AppBar.tsx), so there is never more than one
 *   top bar on screen.
 *
 * `chromeModeFor` is kept pure and exported separately so Phase 3 can move
 * it into a package without touching how it decides.
 */

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { Nav } from './Nav';

export type ChromeMode = 'site' | 'lobby' | 'app';

export function chromeModeFor(pathname: string): ChromeMode {
  // usePathname() carries no query or hash, but a caller passing a full href
  // (`/apps?from=data`) must get the same answer. split() always returns a
  // first element; `?? ''` is only for the type checker.
  const path = pathname.split(/[?#]/, 1)[0] ?? '';
  if (path === '/apps' || path === '/apps/') {
    return 'lobby';
  }
  if (path.startsWith('/apps/')) {
    return 'app';
  }
  return 'site';
}

export function SiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const mode = chromeModeFor(pathname);

  if (mode === 'app') {
    return <>{children}</>;
  }

  return (
    <>
      <Nav />
      {children}
      {mode === 'site' && <footer className="footer">beta · testnet</footer>}
    </>
  );
}
