/**
 * Dialog (handoff feedback/Dialog.jsx). Modal surface on --surface-overlay.
 * Escape and the backdrop close it (unless `blocking`), focus stays inside,
 * `footer` slot for actions.
 *
 * Port notes: the .jsx renders a <div role="dialog" aria-modal> (not a native
 * <dialog>), so this keeps that. Bug fixes: the .jsx promised "focus stays
 * inside" but never moved or trapped focus, and never returned it; this port
 * focuses the first control on open, wraps Tab/Shift+Tab inside the panel and
 * returns focus to the opener on close.
 */
import { useEffect, useRef } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

import { Button } from '../core/Button';

export interface DialogProps {
  open?: boolean;
  title: string;
  description?: string;
  footer?: ReactNode;
  onClose?: () => void;
  width?: number;
  blocking?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('disabled') && !el.closest('[hidden], [inert]'));

export function Dialog({ open = true, title, description, children, footer, onClose, width = 480, blocking, style }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || blocking) return undefined;
    const k = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, blocking, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = panel.current;
    if (el && !el.contains(document.activeElement)) (focusables(el)[0] ?? el).focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  const trap = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = panel.current;
    if (e.key !== 'Tab' || !el) return;
    const list = focusables(el);
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) {
      e.preventDefault();
      el.focus();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && !blocking) onClose?.();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-dialog)',
        background: 'var(--surface-overlay)',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={trap}
        style={{
          width,
          maxWidth: '100%',
          maxHeight: 'calc(100vh - 32px)',
          overflow: 'auto',
          background: 'var(--surface-popover)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--elevation-3)',
          color: 'var(--text-primary)',
          display: 'grid',
          ...style,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '16px 16px 0' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h2 style={{ margin: 0, font: 'var(--type-h3)' }}>{title}</h2>
            {description && <p style={{ margin: 0, font: 'var(--type-body-sm)', color: 'var(--text-secondary)' }}>{description}</p>}
          </div>
          {onClose && !blocking && <Button variant="ghost" size="dense" icon="x" aria-label="Close" onClick={onClose} />}
        </div>
        <div style={{ padding: 16, display: 'grid', gap: 14 }}>{children}</div>
        {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0 16px 16px' }}>{footer}</div>}
      </div>
    </div>
  );
}
