/**
 * Countdown (handoff core/Countdown.jsx, CM-36). Computes from `expiresAt` (ms
 * epoch) + `clockOffset` (server − client ms); one timeout chain aligned to the
 * second. States: ticking | expiring-soon (< soonMs) | expired | unknown (no
 * expiresAt). <time> with tabular numerals, role="timer" aria-live="off".
 * Money-safe: never animates digits.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

export type CountdownState = 'ticking' | 'expiring-soon' | 'expired' | 'unknown';

export interface CountdownProps {
  /** Server deadline in ms since epoch; null/undefined renders the "unknown" dash. */
  expiresAt?: number | null;
  clockOffset?: number;
  soonMs?: number;
  expiredLabel?: string;
  prefix?: string;
  /** `mmss` / `auto` switch to "Hh MMm" once an hour or more remains; `hhmmss` always uses it. */
  format?: 'mmss' | 'hhmmss' | 'auto';
  style?: CSSProperties;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function Countdown({ expiresAt, clockOffset = 0, soonMs = 60000, expiredLabel = 'Expired', prefix, format = 'mmss', style }: CountdownProps) {
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  useEffect(() => {
    if (!expiresAt) return undefined;
    let id: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      const t = Date.now() + clockOffset;
      setNow(t);
      // Stop once expired: the handoff kept re-arming the timer forever.
      if (t >= expiresAt) return;
      id = setTimeout(tick, 1000 - (t % 1000));
    };
    tick();
    return () => clearTimeout(id);
  }, [expiresAt, clockOffset]);
  if (!expiresAt)
    return (
      <span data-state="unknown" style={{ font: 'var(--type-num)', color: 'var(--text-muted)', ...style }}>
        —
      </span>
    );
  const ms = Math.max(0, expiresAt - now);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const text = ms === 0 ? expiredLabel : format === 'hhmmss' || h > 0 ? `${h}h ${pad(m)}m` : `${pad(m)}:${pad(sec)}`;
  const state: CountdownState = ms === 0 ? 'expired' : ms < soonMs ? 'expiring-soon' : 'ticking';
  const color = state === 'expired' ? 'var(--text-muted)' : state === 'expiring-soon' ? 'var(--state-warning)' : 'var(--text-primary)';
  return (
    <time role="timer" aria-live="off" dateTime={new Date(expiresAt).toISOString()} data-state={state} className="em-num" style={{ font: 'var(--type-num)', fontWeight: 500, color, ...style }}>
      {prefix && ms > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{prefix} </span>}
      {text}
    </time>
  );
}
