/**
 * SlideToConfirm (handoff controls/SlideToConfirm.jsx, adapted SlideCommit
 * SEL-25). Money commit inside StepFlow. Phases: idle | pending | success |
 * error (persistent until Retry). Success never returns to idle, so it can't
 * submit twice; success only after `onConfirm` resolves. Enter/Space/End
 * commit; arrows nudge; Home/Esc reset.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';

import { Icon } from '../core/Icon';
import { Spinner } from '../core/Spinner';

export type SlideToConfirmPhase = 'idle' | 'pending' | 'success' | 'error';

export interface SlideToConfirmProps {
  label?: string;
  pendingLabel?: string;
  successLabel?: string;
  onConfirm?: () => Promise<unknown>;
  phase?: SlideToConfirmPhase;
  error?: string;
  onRetry?: () => void;
  disabledReason?: string;
  width?: number | string;
  style?: CSSProperties;
}

const H = 44;
const K = 38;

export function SlideToConfirm({
  label = 'Slide to confirm',
  pendingLabel = 'Sending…',
  successLabel = 'Sent',
  onConfirm,
  phase: controlled,
  error: controlledError,
  onRetry,
  disabledReason,
  width = '100%',
  style,
}: SlideToConfirmProps) {
  const [inner, setInner] = useState<SlideToConfirmPhase>('idle');
  const [x, setX] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ sx: number; x0: number } | null>(null);
  // Synchronous guard: two commits in the same frame (e.g. pointer-up then
  // Enter before a re-render) must not call onConfirm twice.
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reasonId = useId();
  const phase = controlled || inner;
  const error = controlledError ?? err;
  const max = (): number => (track.current?.offsetWidth || 280) - K - 6;
  const commit = async (): Promise<void> => {
    if ((phase !== 'idle' && phase !== 'error') || inFlight.current) return;
    inFlight.current = true;
    setX(max());
    setInner('pending');
    try {
      await onConfirm?.();
      // phase 'success' now blocks further commits.
      inFlight.current = false;
      if (alive.current) setInner('success');
    } catch (e) {
      inFlight.current = false;
      if (!alive.current) return;
      setErr(e instanceof Error && e.message ? e.message : 'Failed');
      setInner('error');
      setX(0);
    }
  };
  const onDown = (e: PointerEvent<HTMLSpanElement>): void => {
    if (disabledReason || (phase !== 'idle' && phase !== 'error')) return;
    drag.current = { sx: e.clientX, x0: x };
    const el = e.currentTarget;
    if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLSpanElement>): void => {
    const d = drag.current;
    if (!d) return;
    setX(Math.max(0, Math.min(max(), d.x0 + e.clientX - d.sx)));
  };
  const onUp = (): void => {
    if (!drag.current) return;
    drag.current = null;
    if (x >= max() * 0.92) void commit();
    else setX(0);
  };
  const c = phase === 'success' ? 'var(--state-success)' : phase === 'error' ? 'var(--state-error)' : 'var(--accent)';
  const inert = !!disabledReason || phase === 'pending' || phase === 'success';
  return (
    <div style={{ display: 'grid', gap: 6, width, ...style }}>
      <div
        ref={track}
        role="slider"
        // Stays focusable when inert so the reason is reachable (the source used -1).
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((x / max()) * 100)}
        aria-disabled={inert || undefined}
        aria-busy={phase === 'pending' || undefined}
        aria-describedby={disabledReason ? reasonId : undefined}
        onKeyDown={(e) => {
          if (inert) return;
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'End') {
            e.preventDefault();
            void commit();
          }
          if (e.key === 'ArrowRight') setX((v) => Math.min(max(), v + 24));
          if (e.key === 'ArrowLeft') setX((v) => Math.max(0, v - 24));
          if (e.key === 'Home' || e.key === 'Escape') setX(0);
        }}
        style={{
          position: 'relative',
          height: H,
          borderRadius: 'var(--radius-pill)',
          background: 'var(--track)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden',
          opacity: disabledReason ? 0.55 : 1,
          cursor: disabledReason ? 'not-allowed' : 'default',
          boxSizing: 'border-box',
          touchAction: 'none',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            width: x + K + 3,
            background: c,
            opacity: phase === 'idle' ? 0.25 : 1,
            transition: drag.current ? 'none' : 'width var(--dur-base) var(--ease-out), opacity var(--dur-base)',
          }}
        />
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: 'var(--type-label)',
            color: phase === 'idle' ? 'var(--text-secondary)' : 'var(--on-accent)',
            paddingLeft: phase === 'idle' ? K : 0,
            userSelect: 'none',
            gap: 6,
          }}
        >
          {phase === 'pending' && <Spinner size={14} label="" />}
          {phase === 'success' && <Icon name="check" size={14} />}
          {phase === 'error' && <Icon name="circle-alert" size={14} />}
          {phase === 'pending' ? pendingLabel : phase === 'success' ? successLabel : phase === 'error' ? 'Failed, try again' : label}
        </span>
        {phase !== 'success' && phase !== 'pending' && (
          <span
            aria-hidden="true"
            data-knob=""
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            style={{
              position: 'absolute',
              top: 2,
              left: 2 + x,
              width: K,
              height: K,
              borderRadius: '50%',
              background: c,
              color: 'var(--on-accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: 'var(--elevation-2)',
              cursor: inert ? 'not-allowed' : 'grab',
              transition: drag.current ? 'none' : 'left var(--dur-base) var(--ease-out)',
            }}
          >
            <Icon name="chevrons-right" size={18} />
          </span>
        )}
      </div>
      {phase === 'error' && (
        <span role="alert" style={{ font: 'var(--type-caption)', color: 'var(--state-error)' }}>
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              setInner('idle');
              setErr(null);
              onRetry?.();
            }}
            style={{ all: 'unset', cursor: 'pointer', color: 'var(--text-link)', textDecoration: 'underline' }}
          >
            Retry
          </button>
        </span>
      )}
      {disabledReason && (
        <span id={reasonId} style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
          {disabledReason}
        </span>
      )}
    </div>
  );
}
