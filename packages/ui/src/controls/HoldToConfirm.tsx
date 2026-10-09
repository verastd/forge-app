/**
 * HoldToConfirm (handoff controls/HoldToConfirm.jsx, adapted HoldButton
 * SEL-24). Row-level destructive confirm. Phases: idle | holding | pending |
 * success | error. Success only after `onHold` resolves; errors persist with
 * Retry. A plain click / Enter (keyboard, AT) calls onClickFallback (open a
 * confirm dialog); without one, holding Enter/Space holds. Pass `phase` to
 * control it.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';

import { Hint } from '../core/Hint';
import { Icon } from '../core/Icon';
import { Spinner } from '../core/Spinner';

export type HoldToConfirmPhase = 'idle' | 'holding' | 'pending' | 'success' | 'error';

export interface HoldToConfirmProps {
  label?: string;
  pendingLabel?: string;
  successLabel?: string;
  holdMs?: number;
  onHold?: () => Promise<unknown>;
  onClickFallback?: () => void;
  phase?: HoldToConfirmPhase;
  error?: string;
  onRetry?: () => void;
  disabledReason?: string;
  size?: 'dense' | 'standard';
  style?: CSSProperties;
}

export function HoldToConfirm({
  label = 'Delete',
  pendingLabel = 'Deleting…',
  successLabel = 'Deleted',
  holdMs = 900,
  onHold,
  onClickFallback,
  phase: controlled,
  error: controlledError,
  onRetry,
  disabledReason,
  size = 'dense',
  style,
}: HoldToConfirmProps) {
  const [inner, setInner] = useState<HoldToConfirmPhase>('idle');
  const [prog, setProg] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const raf = useRef(0);
  const t0 = useRef(0);
  const held = useRef(false);
  const done = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const hintId = useId();
  const phase = controlled || inner;
  const error = controlledError ?? err;
  const run = async (): Promise<void> => {
    setInner('pending');
    try {
      await onHold?.();
      if (!alive.current) return;
      setInner('success');
      // Cleared on unmount (the source leaked this timer).
      done.current = setTimeout(() => setInner('idle'), 1500);
    } catch (e) {
      if (!alive.current) return;
      setErr(e instanceof Error && e.message ? e.message : 'Failed');
      setInner('error');
    }
  };
  const canStart = !disabledReason && (phase === 'idle' || phase === 'error');
  const start = (e?: PointerEvent<HTMLButtonElement>): void => {
    if (!canStart) return;
    held.current = true;
    t0.current = performance.now();
    setInner('holding');
    // Keyboard holds have no pointer to capture (the source threw here).
    if (e) {
      const el = e.currentTarget;
      if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
    }
    const tick = (t: number): void => {
      if (!held.current) return;
      const p = Math.min(1, (t - t0.current) / holdMs);
      setProg(p);
      if (p >= 1) {
        held.current = false;
        setProg(0);
        void run();
      } else raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  const cancel = (): void => {
    if (!held.current) return;
    held.current = false;
    cancelAnimationFrame(raf.current);
    const short = performance.now() - t0.current < 250;
    setProg(0);
    setInner('idle');
    if (short) onClickFallback?.();
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelAnimationFrame(raf.current);
      clearTimeout(done.current);
    };
  }, []);
  const h = size === 'dense' ? 'var(--control-dense)' : 'var(--control-standard)';
  const busy = phase === 'pending';
  const btn = (
    <button
      type="button"
      aria-disabled={!!disabledReason || busy || undefined}
      aria-busy={busy || undefined}
      aria-describedby={hintId}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          // Disabled / busy / done ignore keys too (the source still fired the fallback).
          if (!canStart) return;
          if (onClickFallback) onClickFallback();
          else start();
        }
        if (e.key === 'Escape') cancel();
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') cancel();
      }}
      style={{
        all: 'unset',
        position: 'relative',
        overflow: 'hidden',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: h,
        padding: '0 var(--control-padding-x)',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${phase === 'error' ? 'var(--state-error)' : phase === 'success' ? 'var(--state-success)' : 'var(--border-strong)'}`,
        background: phase === 'success' ? 'var(--state-success)' : 'var(--surface-card)',
        color: phase === 'success' ? 'var(--on-accent)' : phase === 'error' ? 'var(--state-error)' : 'var(--danger)',
        font: 'var(--type-label)',
        fontSize: size === 'dense' ? 'var(--text-xs)' : 'var(--text-sm)',
        cursor: disabledReason ? 'not-allowed' : 'pointer',
        opacity: disabledReason ? 0.55 : 1,
        userSelect: 'none',
        touchAction: 'none',
        boxSizing: 'border-box',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        data-progress={prog}
        style={{
          position: 'absolute',
          inset: 0,
          width: `${prog * 100}%`,
          background: 'var(--danger)',
          opacity: phase === 'holding' ? 1 : 0,
          transition: phase === 'holding' ? 'none' : 'opacity var(--dur-fast)',
        }}
      />
      <span
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: phase === 'holding' ? 'var(--on-danger)' : undefined,
          mixBlendMode: phase === 'holding' ? 'normal' : undefined,
        }}
      >
        {busy ? (
          <Spinner size={13} label="" />
        ) : phase === 'success' ? (
          <Icon name="check" size={13} />
        ) : phase === 'error' ? (
          <Icon name="circle-alert" size={13} />
        ) : (
          <Icon name="trash-2" size={13} />
        )}
        {busy ? pendingLabel : phase === 'success' ? successLabel : phase === 'holding' ? 'Keep holding…' : label}
      </span>
    </button>
  );
  return (
    <span style={{ display: 'inline-grid', gap: 4, justifyItems: 'start' }}>
      {disabledReason ? (
        <Hint persistent content={disabledReason}>
          {btn}
        </Hint>
      ) : (
        btn
      )}
      <span id={hintId} className="em-sr">
        Press and hold to confirm. Press Enter to open a confirmation instead.
      </span>
      {phase === 'error' && (
        <span role="alert" style={{ font: 'var(--type-caption)', color: 'var(--state-error)' }}>
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              if (onRetry) onRetry();
              else void run();
            }}
            style={{ all: 'unset', cursor: 'pointer', color: 'var(--text-link)', textDecoration: 'underline' }}
          >
            Retry
          </button>
        </span>
      )}
    </span>
  );
}
