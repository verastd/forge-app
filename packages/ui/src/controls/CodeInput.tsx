/**
 * CodeInput (handoff controls/CodeInput.jsx, adapted CodeSlots SEL-26). One
 * hidden numeric input over visual slots. status: idle | verifying | error |
 * success. Paste of a full code always fills from slot 0; announces on
 * complete/error only; visible error text; Resend with cooldown.
 */
import { useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Spinner } from '../core/Spinner';

export type CodeInputStatus = 'idle' | 'verifying' | 'error' | 'success';

export interface CodeInputProps {
  length?: number;
  value: string;
  onChange?: (v: string) => void;
  onComplete?: (v: string) => void;
  status?: CodeInputStatus;
  error?: string;
  onResend?: () => void;
  resendIn?: number;
  label?: string;
  style?: CSSProperties;
}

export function CodeInput({
  length = 6,
  value = '',
  onChange,
  onComplete,
  status = 'idle',
  error,
  onResend,
  resendIn = 0,
  label = 'Verification code',
  style,
}: CodeInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState(false);
  const locked = status === 'verifying' || status === 'success';
  const set = (v: string): void => {
    // readOnly blocks typing but not the paste handler: the source still
    // changed the code while verifying / verified.
    if (locked) return;
    const d = v.replace(/\D/g, '').slice(0, length);
    onChange?.(d);
    if (d.length === length) onComplete?.(d);
  };
  const id = useId();
  return (
    <div style={{ display: 'grid', gap: 10, justifyItems: 'start', ...style }}>
      <div
        onClick={() => ref.current?.focus()}
        className={status === 'error' ? 'em-motion' : undefined}
        style={{
          position: 'relative',
          display: 'flex',
          gap: 8,
          cursor: locked ? 'default' : 'text',
          animation: status === 'error' ? 'em-shake var(--dur-slow)' : 'none',
        }}
      >
        {Array.from({ length }, (_, i) => {
          const active = focus && !locked && i === Math.min(value.length, length - 1);
          return (
            <span
              key={i}
              aria-hidden="true"
              data-slot={i}
              className="em-num"
              style={{
                width: 40,
                height: 48,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--radius-md)',
                border: `1.5px solid ${
                  status === 'error'
                    ? 'var(--state-error)'
                    : status === 'success'
                      ? 'var(--state-success)'
                      : active
                        ? 'var(--border-focus)'
                        : 'var(--border-strong)'
                }`,
                background: 'var(--surface-card)',
                boxShadow: active ? 'var(--focus-ring)' : 'none',
                font: 'var(--type-num-lg)',
                color: 'var(--text-primary)',
                opacity: locked && status !== 'success' ? 0.7 : 1,
                boxSizing: 'border-box',
                transition: 'border-color var(--dur-fast), box-shadow var(--dur-fast)',
              }}
            >
              {value[i] || (active ? <span data-caret="" style={{ width: 1.5, height: 22, background: 'var(--accent)' }} /> : '')}
            </span>
          );
        })}
        <input
          ref={ref}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d*"
          aria-label={label}
          aria-invalid={status === 'error' || undefined}
          aria-describedby={status === 'error' ? id : undefined}
          aria-busy={status === 'verifying' || undefined}
          readOnly={locked}
          value={value}
          onChange={(e) => set(e.target.value)}
          onPaste={(e) => {
            e.preventDefault();
            set(e.clipboardData.getData('text'));
          }}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: locked ? 'default' : 'text' }}
        />
        {status === 'verifying' && (
          <span
            role="status"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'center', marginLeft: 4, font: 'var(--type-caption)', color: 'var(--text-secondary)' }}
          >
            <Spinner size={14} label="" />
            Verifying
          </span>
        )}
      </div>
      {status === 'error' && (
        <span id={id} role="alert" style={{ font: 'var(--type-caption)', color: 'var(--state-error)' }}>
          {error || 'That code didn’t match. Check the email and try again.'}
        </span>
      )}
      {status === 'success' && (
        <span role="status" style={{ font: 'var(--type-caption)', color: 'var(--state-success)' }}>
          Verified
        </span>
      )}
      {onResend && (
        <button
          type="button"
          aria-disabled={resendIn > 0 || undefined}
          onClick={() => {
            if (resendIn <= 0) onResend();
          }}
          style={{
            all: 'unset',
            cursor: resendIn > 0 ? 'not-allowed' : 'pointer',
            font: 'var(--type-caption)',
            color: resendIn > 0 ? 'var(--text-muted)' : 'var(--text-link)',
            textDecoration: resendIn > 0 ? 'none' : 'underline',
            textUnderlineOffset: 2,
          }}
        >
          {resendIn > 0 ? (
            <>
              Resend code in <span className="em-num">{resendIn}s</span>
            </>
          ) : (
            'Resend code'
          )}
        </button>
      )}
    </div>
  );
}
