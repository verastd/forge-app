/**
 * AppShell (handoff layout/AppShell.jsx, CM-01). CSS grid: top bar, sidebar,
 * ONE scrolling <main>, footer disclaimer. Route-change progress bar via
 * `routing`. Slots: topBar, sidebar, banner (ad / Discord per tier), children
 * (main), footer.
 *
 * Adaptations: the root carries `em-root` (the token stylesheet is scoped to
 * it). Below 1024px the inline sidebar is hidden (AppShell.css) and `drawer`
 * is shown in a native modal <dialog>, controlled by `drawerOpen` +
 * `onDrawerClose` (README: "Below 1024px the sidebar becomes a native <dialog>
 * drawer with 44px targets"). Crossing back to >= 1024px with the drawer open
 * asks the host to close it, so an invisible modal never traps the page.
 */
import { useEffect, useRef } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, Ref } from 'react';

import { Button } from '../core/Button';
import './AppShell.css';

export interface AppShellProps {
  topBar?: ReactNode;
  sidebar?: ReactNode;
  banner?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  routing?: boolean;
  mainRef?: Ref<HTMLElement>;
  /** Navigation shown in a native <dialog> drawer below 1024px (usually the same SidebarNav). */
  drawer?: ReactNode;
  drawerOpen?: boolean;
  /** Called on Escape, backdrop click, the close button, or when the viewport grows to >= 1024px. */
  onDrawerClose?: () => void;
  /** Heading in the drawer's header row. */
  drawerTitle?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const DESKTOP = '(min-width: 1024px)';

export function AppShell({
  topBar,
  sidebar,
  banner,
  children,
  footer = 'Embers is an independent analytics tool and is not affiliated with Upland. Synthetic data shown.',
  routing,
  mainRef,
  drawer,
  drawerOpen = false,
  onDrawerClose,
  drawerTitle = 'Embers',
  className,
  style,
}: AppShellProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openRef = useRef(drawerOpen);
  const closeRef = useRef(onDrawerClose);
  openRef.current = drawerOpen;
  closeRef.current = onDrawerClose;

  // Sync the native dialog with the controlled prop. jsdom (and very old
  // browsers) lack showModal/close: fall back to toggling the attribute.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (drawerOpen && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!drawerOpen && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [drawerOpen, drawer]);

  // The drawer only exists below 1024px.
  useEffect(() => {
    if (!drawer || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(DESKTOP);
    const onChange = (): void => {
      if (mq.matches && openRef.current) closeRef.current?.();
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [drawer]);

  const requestClose = (): void => {
    if (openRef.current) closeRef.current?.();
  };

  return (
    <div
      className={className ? `em-root em-shell ${className}` : 'em-root em-shell'}
      style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%', minHeight: 0, background: 'var(--surface-page)', color: 'var(--text-primary)', font: 'var(--type-body)', position: 'relative', ...style }}
    >
      {routing && (
        <div aria-hidden="true" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, overflow: 'hidden', zIndex: 'var(--z-toast)' as unknown as number }}>
          <div className="em-motion" style={{ position: 'absolute', top: 0, width: '40%', height: '100%', background: 'var(--accent)', animation: 'em-progress-indeterminate 1.2s var(--ease-in-out) infinite' }} />
        </div>
      )}
      {topBar}
      <div className="em-shell__body" style={{ display: 'grid', gridTemplateColumns: sidebar ? 'auto minmax(0, 1fr)' : 'minmax(0, 1fr)', minHeight: 0 }}>
        {sidebar && (
          <div className="em-shell__sidebar" style={{ display: 'contents' }}>
            {sidebar}
          </div>
        )}
        <main ref={mainRef} style={{ overflowY: 'auto', minWidth: 0, display: 'grid', gridTemplateRows: 'auto 1fr auto', alignContent: 'start' }}>
          {banner}
          <div style={{ padding: 'var(--gutter)', maxWidth: 'var(--content-max)', width: '100%', boxSizing: 'border-box', display: 'grid', gap: 20, alignContent: 'start' }}>{children}</div>
          <footer style={{ padding: '12px var(--gutter)', borderTop: '1px solid var(--border-subtle)', font: 'var(--type-caption)', color: 'var(--text-muted)' }}>{footer}</footer>
        </main>
      </div>
      {drawer && (
        // No inline `display` on the <dialog>: the UA hides it while closed.
        <dialog
          ref={dialogRef}
          className="em-shell__drawer"
          aria-label="Navigation"
          onClose={requestClose}
          onCancel={(e) => {
            e.preventDefault();
            requestClose();
          }}
          onClick={(e: MouseEvent<HTMLDialogElement>) => {
            if (e.target === e.currentTarget) requestClose();
          }}
          style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none', margin: 0, padding: 0, border: 0, background: 'var(--surface-overlay)', color: 'var(--text-primary)' }}
        >
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 300, maxWidth: '100%', background: 'var(--surface-card)', boxShadow: 'var(--elevation-3)', display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
              <span style={{ font: 'var(--type-title)' }}>{drawerTitle}</span>
              <Button variant="ghost" size="dense" icon="x" aria-label="Close navigation" onClick={requestClose} style={{ width: 44, height: 44 }} />
            </div>
            <div style={{ minHeight: 0, overflowY: 'auto', display: 'grid' }}>{drawer}</div>
          </div>
        </dialog>
      )}
    </div>
  );
}
