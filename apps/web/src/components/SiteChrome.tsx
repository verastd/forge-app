'use client';

/**
 * Picks the page shell from the URL (Phase 2 addendum's cross-unit
 * contract), with `chromeModeFor` from @forge/lobby:
 *
 * - "site" — the normal site nav plus footer. Everything not under /apps.
 * - "lobby" — /apps exactly. The same site nav, but no footer, so the
 *   full-bleed 3D lobby owns the rest of the viewport.
 * - "app" — any /apps/<slug> route. No site nav, no footer: the app renders
 *   its own AppBar instead (see AppBar.tsx), so there is never more than one
 *   top bar on screen.
 *
 * When a navigation swaps one shell for another, the element that had focus
 * (a nav link, the AppBar's "← Lobby", a panel in the lobby) is usually gone,
 * which would drop keyboard and screen-reader users back at the top of the
 * document. So focus moves to the new page's `main h1` instead, or to the
 * element the page marks `data-arrival-focus` (the lobby marks the directory
 * link of the app you came back from), retrying for a few frames while the
 * page is still rendering it.
 */

import { chromeModeFor } from '@forge/lobby';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { Nav } from './Nav';

/** How long to keep looking for the new page's heading (or marked element). */
const FOCUS_WINDOW_MS = 1000;

function focusArrival(): () => void {
  const started = performance.now();
  let frame = 0;
  const attempt = (): void => {
    const target =
      document.querySelector<HTMLElement>('main [data-arrival-focus]') ?? document.querySelector<HTMLElement>('main h1');
    if (target) {
      // A heading takes focus only with a tabindex; a marked link already can.
      if (target.tagName === 'H1' && !target.hasAttribute('tabindex')) {
        target.setAttribute('tabindex', '-1');
      }
      target.focus({ preventScroll: true });
      if (document.activeElement === target) {
        return;
      }
    }
    if (performance.now() - started < FOCUS_WINDOW_MS) {
      frame = requestAnimationFrame(attempt);
    }
  };
  frame = requestAnimationFrame(attempt);
  return () => cancelAnimationFrame(frame);
}

export function SiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const mode = chromeModeFor(pathname);
  const previous = useRef(mode);

  useEffect(() => {
    if (previous.current === mode) {
      return undefined;
    }
    previous.current = mode;
    return focusArrival();
  }, [mode]);

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
