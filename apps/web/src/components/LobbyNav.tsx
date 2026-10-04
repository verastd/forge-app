'use client';

/**
 * The site nav in SiteChrome's "lobby" mode, on /apps only: the same nav as
 * every other page (NavContents), stepping out of the cave's way.
 *
 * - A desktop (a fine pointer, wider than 640 px): the usual bar on arrival,
 *   which slides up out of view once the 3D wall is up (`ready`). It comes
 *   back down while the pointer is in a thin strip along the top edge or
 *   over the bar, while keyboard focus is in it, and while the account menu
 *   or the bell's panel is open, and slides away again HIDE_DELAY_MS after
 *   none of that holds. Once the wall is up the bar floats, so it no longer
 *   pushes the page down; while it is away it is `inert`, out of the tab
 *   order and the accessibility tree. The strip is a button too, and the
 *   page's first tab stop while the bar is away, so Tab from the top (or
 *   Shift+Tab back out of the page) still lands in the nav: it brings the
 *   bar down and hands focus to its first (or last) item. A screen reader
 *   finds it as "Show the site menu".
 * - A touch screen, or 640 px and under: a 44 px "Menu" button in the top
 *   left corner instead, which opens the nav as a panel. A link, Escape
 *   (focus back to the button) or a tap outside closes it, and that tap goes
 *   no further: it never reaches the 3D view.
 * - No wall (the lobby switched off, no WebGL2, or the view lost): the page
 *   is a normal page, so this is the normal bar, on every screen.
 *
 * With reduced motion it appears and disappears without sliding
 * (LobbyNav.module.css). The header carries `data-nav-mode` (arrival, slide,
 * menu or bar) and `data-nav` (shown or hidden) for e2e.
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { FocusEvent as ReactFocusEvent } from 'react';

import { NavContents } from './Nav';
import { isFallback, useLobbyState } from './lobby/lobbyState';
import styles from './LobbyNav.module.css';

/** A touch screen or a narrow one: the nav is a menu button. Lobby.module.css's Exit makes room for it under the same query. */
const COMPACT_QUERY = '(pointer: coarse), (max-width: 640px)';
/** How long the bar stays down once nothing holds it. */
const HIDE_DELAY_MS = 600;

function subscribeCompact(onChange: () => void): () => void {
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const compactNow = (): boolean => window.matchMedia(COMPACT_QUERY).matches;
/** A bar on the server. A phone shows the button from the first paint anyway: the CSS turns `arrival` into it. */
const compactOnServer = (): boolean => false;

/**
 * - arrival: the wall is still coming. The bar, in the page's flow (a
 *   phone's CSS makes it the button).
 * - slide: the wall is up, on a desktop. The bar floats and slides away.
 * - menu: the wall is the page, on a phone or a narrow window.
 * - bar: no wall. The normal bar.
 */
type NavMode = 'arrival' | 'slide' | 'menu' | 'bar';

/** What Tab can reach in `root`, in order: enabled, rendered, and not in a closed panel. */
function tabStops(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  ].filter((element) => element.closest('[hidden]') === null && element.getClientRects().length > 0);
}

export function LobbyNav() {
  const lobby = useLobbyState();
  const compact = useSyncExternalStore(subscribeCompact, compactNow, compactOnServer);
  const mode: NavMode = isFallback(lobby) ? 'bar' : compact ? 'menu' : lobby === 'ready' ? 'slide' : 'arrival';

  const headerRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // ---- the desktop bar: what holds it down ----
  const [overStrip, setOverStrip] = useState(false);
  const [overBar, setOverBar] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  /** Down on arrival, and for HIDE_DELAY_MS after the last hold lets go. */
  const [linger, setLinger] = useState(true);
  const held = (mode === 'slide' && overStrip) || overBar || focusIn || panelOpen;

  useEffect(() => {
    if (held) {
      setLinger(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setLinger(false), HIDE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [held]);

  // The account menu's and the bell's own panels hold it down while their buttons say they are open.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return undefined;
    }
    const read = (): void => setPanelOpen(panel.querySelector('[aria-expanded="true"]') !== null);
    read();
    const observer = new MutationObserver(read);
    observer.observe(panel, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded'] });
    return () => observer.disconnect();
  }, []);

  // ---- the phone's menu ----
  const [menuOpen, setMenuOpen] = useState(false);
  const open = mode === 'menu' && menuOpen;

  useEffect(() => {
    if (mode !== 'menu') {
      setMenuOpen(false);
    }
    if (mode !== 'slide') {
      setOverStrip(false);
    }
  }, [mode]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // An account menu or bell panel open inside closes first, on its own Escape.
      if (event.key !== 'Escape' || panelRef.current?.querySelector('[aria-expanded="true"]')) {
        return;
      }
      setMenuOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      // A tap outside only closes the menu: it never reaches the 3D view (a tap there opens panels).
      event.stopPropagation();
      setMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  const shown = mode === 'slide' ? held || linger : mode === 'menu' ? open : true;

  /**
   * The keyboard (or a screen reader) asked for the bar through the strip:
   * bring it down now, not on React's next render, since focus can't go
   * into a bar that is inert or hidden, and put focus on its first or last
   * stop. React's own render agrees a moment later (focus inside holds it).
   */
  const reveal = (which: 'first' | 'last'): void => {
    const header = headerRef.current;
    const panel = panelRef.current;
    if (!header || !panel) {
      return;
    }
    header.dataset.nav = 'shown';
    panel.inert = false;
    setFocusIn(true);
    const stops = tabStops(panel);
    (which === 'first' ? stops[0] : stops[stops.length - 1])?.focus();
  };

  /** Focus came into the strip from later in the page: Shift+Tab, going backwards. */
  const fromAfter = (event: ReactFocusEvent<HTMLElement>): boolean => {
    const from = event.relatedTarget;
    const header = headerRef.current;
    return (
      from instanceof Node &&
      header !== null &&
      !header.contains(from) &&
      (header.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    );
  };

  return (
    <>
      <header
        ref={headerRef}
        className={`nav ${styles.lobby}`}
        data-chrome="lobby"
        data-nav-mode={mode}
        data-nav={shown ? 'shown' : 'hidden'}
        onPointerEnter={() => setOverBar(true)}
        onPointerLeave={() => setOverBar(false)}
        onFocus={() => setFocusIn(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocusIn(false);
          }
        }}
      >
        <button
          ref={buttonRef}
          type="button"
          className={styles.menuButton}
          aria-label="Menu"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <div
          ref={panelRef}
          id={panelId}
          className={`nav-inner ${styles.panel}`}
          inert={!shown}
          onClick={(event) => {
            // Any link in the menu closes it, one to this very page included.
            if (open && event.target instanceof Element && event.target.closest('a[href]')) {
              setMenuOpen(false);
            }
          }}
        >
          <NavContents layout={mode === 'menu' ? 'panel' : 'bar'} />
        </div>
      </header>
      {mode === 'slide' && (
        <button
          type="button"
          className={styles.strip}
          tabIndex={shown ? -1 : 0}
          aria-label="Show the site menu"
          aria-expanded={shown}
          aria-controls={panelId}
          onPointerEnter={() => setOverStrip(true)}
          onPointerLeave={() => setOverStrip(false)}
          onFocus={(event) => reveal(fromAfter(event) ? 'last' : 'first')}
          onClick={() => reveal('first')}
        />
      )}
    </>
  );
}
