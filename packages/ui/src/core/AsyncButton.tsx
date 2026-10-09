/**
 * AsyncButton (handoff core/AsyncButton.jsx, PRD 5.2). States: idle | pending
 * | slow | success | error | disabled | locked. Pending feedback in the same
 * frame as the click; width locked; slow notice at 8 s; 20 s timeout → error
 * "Timed out"; success holds 1.5 s. Pass `state` to control it, or
 * `onAction` returning a Promise to let it run its own machine.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { Button } from './Button';
import type { ButtonSize } from './Button';
import { Hint } from './Hint';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { Spinner } from './Spinner';

export type AsyncButtonState = 'idle' | 'pending' | 'slow' | 'success' | 'error' | 'disabled' | 'locked';

export interface AsyncButtonProps {
  label: string;
  pendingLabel?: string;
  successLabel?: string;
  onAction?: (ctx: { signal: AbortSignal }) => Promise<unknown>;
  state?: AsyncButtonState;
  errorMessage?: string;
  disabledReason?: string;
  locked?: boolean;
  lockedTier?: string;
  onUpgrade?: () => void;
  slowMs?: number;
  timeoutMs?: number;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: ButtonSize;
  icon?: IconName;
  full?: boolean;
  style?: CSSProperties;
  'aria-label'?: string;
}

export function AsyncButton({
  onAction,
  state: controlled,
  label,
  pendingLabel,
  successLabel = 'Done',
  errorMessage: controlledError,
  disabledReason,
  locked,
  lockedTier,
  onUpgrade,
  slowMs = 8000,
  timeoutMs = 20000,
  variant = 'primary',
  size,
  icon,
  full,
  style,
  ...rest
}: AsyncButtonProps) {
  const [inner, setInner] = useState<AsyncButtonState>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const ref = useRef<HTMLElement>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const clear = (): void => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clear, []);

  const state: AsyncButtonState = locked ? 'locked' : disabledReason ? 'disabled' : controlled ?? inner;
  const errorMessage = controlledError ?? err;

  const run = async (): Promise<void> => {
    if (!onAction || (state !== 'idle' && state !== 'error')) return;
    setWidth(ref.current?.offsetWidth);
    setErr(null);
    setInner('pending');
    clear();
    timers.current.push(setTimeout(() => setInner((s) => (s === 'pending' ? 'slow' : s)), slowMs));
    const ctrl = new AbortController();
    timers.current.push(setTimeout(() => ctrl.abort(), timeoutMs));
    try {
      await Promise.race([
        onAction({ signal: ctrl.signal }),
        new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(new Error('Timed out')))),
      ]);
      clear();
      setInner('success');
      timers.current.push(
        setTimeout(() => {
          setInner('idle');
          setWidth(undefined);
        }, 1500),
      );
    } catch (e) {
      clear();
      setErr(e instanceof Error && e.message ? e.message : 'Something went wrong');
      setInner('error');
      setWidth(undefined);
    }
  };

  const busy = state === 'pending' || state === 'slow';
  const inert = busy || state === 'disabled' || state === 'success';
  const content: Record<AsyncButtonState, ReactNode> = {
    idle: (
      <>
        {icon && <Icon name={icon} />}
        {label}
      </>
    ),
    pending: (
      <>
        <Spinner size={14} label="" />
        {pendingLabel || label}
      </>
    ),
    slow: (
      <>
        <Spinner size={14} label="" />
        {pendingLabel || label}
      </>
    ),
    success: (
      <>
        <Icon name="check" />
        {successLabel}
      </>
    ),
    error: (
      <>
        <Icon name="circle-alert" />
        {label}
      </>
    ),
    disabled: (
      <>
        {icon && <Icon name={icon} />}
        {label}
      </>
    ),
    locked: (
      <>
        <Icon name="lock" />
        {label}
        <span style={{ opacity: 0.8, fontWeight: 400 }}>· {lockedTier || 'Upgrade'}</span>
      </>
    ),
  };

  const btn = (
    <Button
      ref={ref}
      variant={state === 'error' ? 'secondary' : state === 'locked' ? 'secondary' : variant}
      size={size}
      full={full}
      aria-label={rest['aria-label']}
      aria-disabled={inert ? true : undefined}
      aria-busy={busy ? 'true' : undefined}
      onClick={() => {
        if (state === 'locked') {
          onUpgrade?.();
          return;
        }
        if (inert) return;
        void run();
      }}
      style={{
        width: width || (full ? '100%' : undefined),
        minWidth: width,
        ...(state === 'error' ? { border: '1px solid var(--state-error)', color: 'var(--state-error)' } : {}),
        ...(state === 'success' ? { background: 'var(--state-success)', color: 'var(--on-accent)', border: '1px solid transparent' } : {}),
        ...style,
      }}
    >
      {content[state]}
    </Button>
  );
  const wrapped =
    state === 'disabled' ? (
      <Hint content={disabledReason} persistent>
        {btn}
      </Hint>
    ) : state === 'locked' ? (
      <Hint content={`Requires ${lockedTier || 'a paid plan'}. Click to see plans.`}>{btn}</Hint>
    ) : (
      btn
    );
  return (
    <span style={{ display: full ? 'block' : 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, verticalAlign: 'middle' }}>
      {wrapped}
      {state === 'slow' && (
        <span role="status" style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
          Still working, Upland is slow
        </span>
      )}
      {state === 'error' && (
        <span role="alert" style={{ font: 'var(--type-caption)', color: 'var(--state-error)', display: 'flex', gap: 6, alignItems: 'center' }}>
          {errorMessage}
          {onAction && (
            <button
              type="button"
              onClick={() => void run()}
              style={{ all: 'unset', cursor: 'pointer', color: 'var(--text-link)', fontWeight: 600, textDecoration: 'underline', textUnderlineOffset: 2 }}
            >
              Retry
            </button>
          )}
        </span>
      )}
    </span>
  );
}
