'use client';

/**
 * Embers core primitives, ported from the design handoff
 * (components/core/*.jsx) to TSX. Same states, same values; the inline
 * styles moved to embers.css. Icons are Lucide's paths drawn inline (stroke
 * 2, round caps), so nothing loads at runtime and nothing new is installed.
 * The handoff's tiers and locked states are left out: the private beta has
 * no plans, so nothing here is ever locked.
 */

import Link from 'next/link';
import { forwardRef, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react';

/* --- Icon ------------------------------------------------------------------- */

const ICONS = {
  search: (
    <>
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
    </>
  ),
  menu: (
    <>
      <line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
    </>
  ),
  'chevron-left': (
    <>
      <path d="m15 18-6-6 6-6"/>
    </>
  ),
  'chevron-right': (
    <>
      <path d="m9 18 6-6-6-6"/>
    </>
  ),
  'arrow-left': (
    <>
      <path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>
    </>
  ),
  'arrow-up': (
    <>
      <path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>
    </>
  ),
  'arrow-down': (
    <>
      <path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>
    </>
  ),
  'arrow-up-down': (
    <>
      <path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>
    </>
  ),
  check: (
    <>
      <path d="M20 6 9 17l-5-5"/>
    </>
  ),
  'circle-alert': (
    <>
      <circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
    </>
  ),
  'trending-up': (
    <>
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>
    </>
  ),
  'trending-down': (
    <>
      <polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>
    </>
  ),
  minus: (
    <>
      <path d="M5 12h14"/>
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </>
  ),
  'triangle-alert': (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>
    </>
  ),
  'log-in': (
    <>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>
    </>
  ),
  'refresh-cw': (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>
    </>
  ),
  moon: (
    <>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
    </>
  ),
  monitor: (
    <>
      <rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>
    </>
  ),
  'list-filter': (
    <>
      <path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>
    </>
  ),
  'chevron-down': (
    <>
      <path d="m6 9 6 6 6-6"/>
    </>
  ),
  house: (
    <>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    </>
  ),
  'building-2': (
    <>
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>
    </>
  ),
  'chart-line': (
    <>
      <path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>
    </>
  ),
  zap: (
    <>
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>
    </>
  ),
  user: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
    </>
  ),
  'map-pin': (
    <>
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  return (
    <span
      className={`em-icon${className ? ` ${className}` : ''}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      style={{ width: size, height: size }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ICONS[name]}
      </svg>
    </span>
  );
}

/* --- Spinner / Skeleton ------------------------------------------------------- */

/** Indeterminate spinner (static under reduced motion). `label=""` when the text beside it says what's loading. */
export function Spinner({ size = 16, label = 'Loading' }: { size?: number; label?: string }) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : 'true'}
      className="em-spinner em-motion"
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 8)) }}
    />
  );
}

export function Skeleton({ width = '100%', height = 12, shape = 'rect' }: { width?: number | string; height?: number; shape?: 'rect' | 'text' | 'circle' }) {
  return (
    <span
      aria-hidden="true"
      className="em-skeleton em-motion"
      style={{ width, height, borderRadius: shape === 'circle' ? '50%' : shape === 'text' ? 3 : undefined }}
    />
  );
}

/** A block of skeleton text rows (DataState's default placeholder). */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={14} width={`${70 + ((i * 13) % 30)}%`} />
      ))}
    </div>
  );
}

/* --- Button ---------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'link';
export type ButtonSize = 'dense' | 'standard' | 'comfortable';

function buttonClass(variant: ButtonVariant, size: ButtonSize, iconOnly: boolean, full?: boolean, extra?: string): string {
  return [
    'em-btn',
    `em-btn--${variant}`,
    size !== 'standard' ? `em-btn--${size}` : '',
    iconOnly ? 'em-btn--icon' : '',
    full ? 'em-btn--full' : '',
    extra ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  full?: boolean;
  /** Inert with a reason (never the native `disabled`, so the reason stays reachable). */
  disabledReason?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'standard', icon, full, disabledReason, children, className, onClick, title, ...rest },
  ref,
) {
  const inert = disabledReason !== undefined || rest['aria-disabled'] === true;
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      title={disabledReason ?? title}
      aria-disabled={inert ? true : undefined}
      className={buttonClass(variant, size, children === undefined || children === null, full, className)}
      onClick={(e) => {
        if (inert) return;
        onClick?.(e);
      }}
    >
      {icon && <Icon name={icon} size={size === 'dense' ? 14 : 16} />}
      {children}
      {disabledReason && <span className="em-sr"> ({disabledReason})</span>}
    </button>
  );
});

export function ButtonLink({
  href,
  variant = 'secondary',
  size = 'standard',
  icon,
  children,
  ...rest
}: { href: string; variant?: ButtonVariant; size?: ButtonSize; icon?: IconName; children?: ReactNode; 'aria-label'?: string }) {
  return (
    <Link href={href} className={buttonClass(variant, size, children === undefined, false)} {...rest}>
      {icon && <Icon name={icon} size={size === 'dense' ? 14 : 16} />}
      {children}
    </Link>
  );
}

/* --- AsyncButton ---------------------------------------------------------------- */

type AsyncState = 'idle' | 'pending' | 'slow' | 'success' | 'error';

export interface AsyncButtonProps {
  label: string;
  pendingLabel?: string;
  successLabel?: string;
  /** Runs the action; the button tracks its promise. Reject to show the error state. */
  onAction?: () => Promise<unknown>;
  /** Drive the pending state from outside (a fetch this button started elsewhere). */
  busy?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  disabledReason?: string;
  full?: boolean;
  /** Show the success tick for 1.5 s after the action resolves (off for navigation-like actions). */
  confirm?: boolean;
  slowMs?: number;
  'aria-label'?: string;
}

/**
 * The PRD 5.2 button: pending feedback in the same frame as the click, width
 * locked while pending, a "still working" note at 8 s, success held 1.5 s,
 * and errors in words with a visible Retry.
 */
export function AsyncButton({
  label,
  pendingLabel,
  successLabel = 'Done',
  onAction,
  busy = false,
  variant = 'primary',
  size,
  icon,
  disabledReason,
  full,
  confirm = false,
  slowMs = 8000,
  ...rest
}: AsyncButtonProps) {
  const [inner, setInner] = useState<AsyncState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const ref = useRef<HTMLButtonElement>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const list = timers.current;
    return () => {
      mounted.current = false;
      list.forEach(clearTimeout);
    };
  }, []);

  // An outside fetch can go slow too.
  const [outsideSlow, setOutsideSlow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setOutsideSlow(false);
      return undefined;
    }
    const t = setTimeout(() => setOutsideSlow(true), slowMs);
    return () => clearTimeout(t);
  }, [busy, slowMs]);

  const state: AsyncState = inner !== 'idle' ? inner : busy ? (outsideSlow ? 'slow' : 'pending') : 'idle';
  const pending = state === 'pending' || state === 'slow';

  const run = async (): Promise<void> => {
    if (!onAction || pending || state === 'success') return;
    setWidth(ref.current?.offsetWidth);
    setError(null);
    setInner('pending');
    timers.current.forEach(clearTimeout);
    timers.current = [setTimeout(() => mounted.current && setInner((s) => (s === 'pending' ? 'slow' : s)), slowMs)];
    try {
      await onAction();
      if (!mounted.current) return;
      timers.current.forEach(clearTimeout);
      if (confirm) {
        setInner('success');
        timers.current = [
          setTimeout(() => {
            if (!mounted.current) return;
            setInner('idle');
            setWidth(undefined);
          }, 1500),
        ];
      } else {
        setInner('idle');
        setWidth(undefined);
      }
    } catch (e) {
      if (!mounted.current) return;
      timers.current.forEach(clearTimeout);
      setError(e instanceof Error && e.message ? e.message : 'Something went wrong');
      setInner('error');
      setWidth(undefined);
    }
  };

  const content =
    state === 'success' ? (
      <>
        <Icon name="check" size={size === 'dense' ? 14 : 16} />
        {successLabel}
      </>
    ) : pending ? (
      <>
        <Spinner size={14} label="" />
        {pendingLabel ?? label}
      </>
    ) : state === 'error' ? (
      <>
        <Icon name="circle-alert" size={size === 'dense' ? 14 : 16} />
        {label}
      </>
    ) : (
      <>
        {icon && <Icon name={icon} size={size === 'dense' ? 14 : 16} />}
        {label}
      </>
    );

  return (
    <span className="em-async" style={full ? { display: 'flex', width: '100%' } : undefined}>
      <Button
        ref={ref}
        variant={state === 'error' ? 'secondary' : variant}
        size={size}
        full={full}
        disabledReason={disabledReason}
        aria-disabled={pending || state === 'success' ? true : undefined}
        aria-busy={pending ? 'true' : undefined}
        aria-label={rest['aria-label']}
        className={state === 'error' ? 'em-btn--error' : state === 'success' ? 'em-btn--success' : undefined}
        style={{ minWidth: width, width: width ?? (full ? '100%' : undefined) }}
        onClick={() => void run()}
      >
        {content}
      </Button>
      {state === 'slow' && (
        <span role="status" className="em-async-note">
          Still working: the ledger is slow right now
        </span>
      )}
      {state === 'error' && (
        <span role="alert" className="em-async-error">
          {error}
          <button type="button" className="em-inline-link" onClick={() => void run()}>
            Retry
          </button>
        </span>
      )}
    </span>
  );
}

/* --- Badge / LiveDot / StatusGlyph ------------------------------------------------- */

export type BadgeTone = 'neutral' | 'live' | 'success' | 'error' | 'warning' | 'info' | 'new';

/** Text badge: never color-only, it always carries words. */
export function Badge({ tone = 'neutral', dot, children, title }: { tone?: BadgeTone; dot?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`em-badge em-badge--${tone}`} title={title}>
      {dot && <span aria-hidden="true" className="em-badge-dot" />}
      {children}
    </span>
  );
}

export type LiveStatus = 'live' | 'lagging' | 'stalled' | 'offline' | 'unknown' | 'checking';

const LIVE: Record<LiveStatus, { color: string; text: string; pulse: boolean }> = {
  checking: { color: 'var(--state-neutral)', text: 'Checking', pulse: true },
  live: { color: 'var(--state-live)', text: 'LIVE', pulse: true },
  lagging: { color: 'var(--state-reconnecting)', text: 'Lagging', pulse: true },
  stalled: { color: 'var(--state-offline)', text: 'Stalled', pulse: false },
  offline: { color: 'var(--state-offline)', text: 'Offline', pulse: false },
  unknown: { color: 'var(--state-neutral)', text: 'Unknown', pulse: false },
};

/** LiveIndicator's dot and word (shape + color + word, never color alone). */
export function LiveDot({ status, text }: { status: LiveStatus; text?: string }) {
  const m = LIVE[status];
  return (
    <span className={`em-live${m.pulse ? ' em-live--pulse em-motion' : ''}`} style={{ color: m.color }}>
      <span aria-hidden="true" className="em-live-dot" />
      {text ?? m.text}
    </span>
  );
}

/* --- StatusBanner ------------------------------------------------------------------ */

export function StatusBanner({
  kind = 'info',
  icon: iconOverride,
  children,
  action,
}: {
  kind?: 'info' | 'warning' | 'error';
  /** The kit's "capped" banner uses list-filter on the info tone. */
  icon?: IconName;
  children: ReactNode;
  action?: ReactNode;
}) {
  const icon: IconName = iconOverride ?? (kind === 'error' ? 'circle-alert' : kind === 'warning' ? 'triangle-alert' : 'info');
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`em-banner em-banner--${kind}`}>
      <Icon name={icon} />
      <span className="em-banner-text">{children}</span>
      {action}
    </div>
  );
}

/* --- StatTile ----------------------------------------------------------------------- */

export function StatTile({
  label,
  value,
  unit,
  sub,
  trend,
  state = 'ready',
  onRetry,
  aside,
}: {
  label: string;
  value?: ReactNode;
  unit?: string;
  sub?: ReactNode;
  /** Signed fraction; drawn with an arrow and a word, not color alone. */
  trend?: { value: number; text: string } | null;
  state?: 'ready' | 'loading' | 'error';
  onRetry?: () => Promise<unknown>;
  aside?: ReactNode;
}) {
  return (
    <div className="em-stat">
      <div className="em-stat-label">
        <span>{label}</span>
        {aside}
      </div>
      {state === 'loading' ? (
        <>
          <Skeleton height={26} width="60%" />
          <Skeleton height={12} width="35%" />
          <span className="em-sr">Loading {label}</span>
        </>
      ) : state === 'error' ? (
        <span role="alert" style={{ font: 'var(--type-body-sm)', color: 'var(--state-error)', display: 'grid', gap: 6, justifyItems: 'start' }}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Icon name="circle-alert" size={14} /> Failed to load
          </span>
          {onRetry && <AsyncButton size="dense" variant="secondary" label="Retry" pendingLabel="Retrying…" onAction={onRetry} />}
        </span>
      ) : (
        <>
          <div className="em-stat-value">
            <span className="em-stat-num em-num">{value}</span>
            {unit && <span className="em-stat-unit">{unit}</span>}
          </div>
          {trend && (
            <span
              className="em-num"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                font: 'var(--type-caption)',
                fontWeight: 500,
                color: trend.value > 0 ? 'var(--price-up)' : trend.value < 0 ? 'var(--price-down)' : 'var(--text-muted)',
              }}
            >
              <Icon name={trend.value > 0 ? 'trending-up' : trend.value < 0 ? 'trending-down' : 'minus'} size={12} />
              {trend.text}
            </span>
          )}
          {sub && <span className="em-stat-sub">{sub}</span>}
        </>
      )}
    </div>
  );
}

/* --- Segment (radiogroup) ------------------------------------------------------------- */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** Accessible name when the label is a glyph (↑ / ↓). */
  ariaLabel?: string;
}

/** Controlled radiogroup, 2–5 options, arrow keys / Home / End move and select. */
export function Segment<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'standard',
  className,
}: {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: 'dense' | 'standard';
  className?: string;
}) {
  const idx = options.findIndex((o) => o.value === value);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in step) && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const n = options.length;
    const from = idx < 0 ? 0 : idx;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (from + (step[e.key] ?? 0) + n) % n;
    const next = options[to];
    if (next) {
      onChange(next.value);
      refs.current[to]?.focus();
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      className={['em-segment', size === 'dense' ? 'em-segment--dense' : '', className ?? ''].filter(Boolean).join(' ')}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === idx}
          tabIndex={i === (idx < 0 ? 0 : idx) ? 0 : -1}
          className="em-segment-opt"
          aria-label={o.ariaLabel}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Route tabs: links that look like a Segment, for state that lives in the URL. */
export function Tabs({ label, tabs }: { label: string; tabs: ReadonlyArray<{ href: string; label: string; current: boolean }> }) {
  return (
    <nav aria-label={label} className="em-tabs">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className="em-tab" aria-current={t.current ? 'page' : undefined} scroll={false}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/* --- Toggle ---------------------------------------------------------------------------- */

/** Embers Toggle: a 36×20 switch with its label; fully controlled. */
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="em-toggle">
      <button type="button" role="switch" aria-checked={checked} className="em-toggle-track" onClick={() => onChange(!checked)}>
        <span aria-hidden="true" className="em-toggle-thumb" />
      </button>
      <span>{label}</span>
    </label>
  );
}
