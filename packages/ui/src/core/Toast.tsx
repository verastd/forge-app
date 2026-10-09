/**
 * Toast card (handoff core/Toast.jsx, adapted SwipeToast SEL-21) and
 * ToastStack. variant: success | error | info. Success and info auto-dismiss
 * after `duration` (4 s) through `onClose`, paused while hovered or focused.
 * Errors persist (duration 0) with close + Retry and route to the assertive
 * region. Dismissal never cancels work. The stack owns two pre-mounted live
 * regions (polite + assertive).
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Button } from './Button';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export type ToastVariant = 'success' | 'error' | 'info';

export const TOAST_DURATION = 4000;

export interface ToastProps {
  variant?: ToastVariant;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
  /** Auto-dismiss delay in ms (calls `onClose`); 0 persists. Errors always persist. Defaults to 4000. */
  duration?: number;
  style?: CSSProperties;
}

export interface ToastStackItem extends Omit<ToastProps, 'onAction' | 'onClose' | 'style'> {
  id: string;
}

export interface ToastStackProps {
  toasts?: ToastStackItem[];
  onClose?: (id: string) => void;
  onAction?: (id: string) => void;
  position?: 'bottom-right' | 'top-right';
}

const VARIANTS: Record<ToastVariant, [string, IconName]> = {
  success: ['var(--state-success)', 'circle-check'],
  error: ['var(--state-error)', 'circle-alert'],
  info: ['var(--state-info)', 'info'],
};

export function Toast({ variant = 'info', title, description, actionLabel, onAction, onClose, duration = TOAST_DURATION, style }: ToastProps) {
  const c = VARIANTS[variant];
  const ms = variant === 'error' ? 0 : duration;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remaining = useRef(ms);
  const close = useRef(onClose);
  close.current = onClose;
  const autoDismiss = ms > 0 && !!onClose;
  useEffect(() => {
    if (!autoDismiss || paused) return undefined;
    const started = Date.now();
    const id = setTimeout(() => close.current?.(), remaining.current);
    return () => {
      clearTimeout(id);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [autoDismiss, paused]);
  return (
    <div
      className="em-motion"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        width: 340,
        maxWidth: 'calc(100vw - 32px)',
        padding: '10px 12px',
        background: 'var(--surface-popover)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--elevation-3)',
        color: 'var(--text-primary)',
        animation: 'em-toast-in var(--dur-slow) var(--ease-out)',
        ...style,
      }}
    >
      <Icon name={c[1]} size={18} style={{ color: c[0], marginTop: 1 }} />
      <div style={{ flex: 1, display: 'grid', gap: 2, minWidth: 0 }}>
        <span style={{ font: 'var(--type-label)' }}>{title}</span>
        {description && <span style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>{description}</span>}
        {actionLabel && (
          <button
            type="button"
            onClick={onAction}
            style={{
              all: 'unset',
              cursor: 'pointer',
              marginTop: 4,
              font: 'var(--type-label)',
              color: 'var(--text-link)',
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            {actionLabel}
          </button>
        )}
      </div>
      {onClose && <Button variant="ghost" size="dense" icon="x" aria-label="Close" onClick={onClose} style={{ height: 24, width: 24, margin: -4 }} />}
    </div>
  );
}

export function ToastStack({ toasts = [], onClose, onAction, position = 'bottom-right' }: ToastStackProps) {
  const errs = toasts.filter((t) => t.variant === 'error');
  const others = toasts.filter((t) => t.variant !== 'error');
  const pos: CSSProperties = position === 'bottom-right' ? { right: 16, bottom: 16 } : { right: 16, top: 16 };
  const render = ({ id, ...t }: ToastStackItem) => <Toast key={id} {...t} onClose={() => onClose?.(id)} onAction={() => onAction?.(id)} />;
  return (
    <div style={{ position: 'fixed', zIndex: 'var(--z-toast)' as unknown as number, display: 'grid', gap: 8, ...pos }}>
      <div role="status" aria-live="polite" style={{ display: 'grid', gap: 8 }}>
        {others.map(render)}
      </div>
      <div role="alert" aria-live="assertive" style={{ display: 'grid', gap: 8 }}>
        {errs.map(render)}
      </div>
    </div>
  );
}
