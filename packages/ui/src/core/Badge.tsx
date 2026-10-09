/** Text badge (handoff core/Badge.jsx). Never color-only: always carries text. */
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

import { Icon } from './Icon';
import type { IconName } from './Icon';

export type BadgeTone =
  | 'neutral'
  | 'live'
  | 'new'
  | 'lock'
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'free'
  | 'basic'
  | 'premium'
  | 'limited'
  | 'exclusive'
  | 'rare'
  | 'accent';

const TONES: Record<BadgeTone, { bg: string; fg: string; bd: string }> = {
  neutral: { bg: 'var(--surface-sunken)', fg: 'var(--text-secondary)', bd: 'var(--border-subtle)' },
  live: { bg: 'var(--state-success-soft)', fg: 'var(--state-live)', bd: 'transparent' },
  new: { bg: 'var(--accent-soft)', fg: 'var(--accent-strong)', bd: 'transparent' },
  lock: { bg: 'var(--surface-sunken)', fg: 'var(--text-muted)', bd: 'var(--border-subtle)' },
  success: { bg: 'var(--state-success-soft)', fg: 'var(--state-success)', bd: 'transparent' },
  error: { bg: 'var(--state-error-soft)', fg: 'var(--state-error)', bd: 'transparent' },
  warning: { bg: 'var(--state-warning-soft)', fg: 'var(--state-warning)', bd: 'transparent' },
  info: { bg: 'var(--state-info-soft)', fg: 'var(--state-info)', bd: 'transparent' },
  free: { bg: 'var(--tier-free-soft)', fg: 'var(--tier-free)', bd: 'transparent' },
  basic: { bg: 'var(--tier-basic-soft)', fg: 'var(--tier-basic)', bd: 'transparent' },
  premium: { bg: 'var(--tier-premium-soft)', fg: 'var(--tier-premium)', bd: 'transparent' },
  limited: { bg: 'var(--rarity-limited-soft)', fg: 'var(--rarity-limited)', bd: 'transparent' },
  exclusive: { bg: 'var(--rarity-exclusive-soft)', fg: 'var(--rarity-exclusive)', bd: 'transparent' },
  rare: { bg: 'var(--rarity-rare-soft)', fg: 'var(--rarity-rare)', bd: 'transparent' },
  accent: { bg: 'var(--accent)', fg: 'var(--on-accent)', bd: 'transparent' },
};

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'style'> {
  tone?: BadgeTone;
  icon?: IconName;
  dot?: boolean;
  size?: 'xs' | 'sm';
  children: ReactNode;
  style?: CSSProperties;
}

export function Badge({ tone = 'neutral', icon, children, dot, size = 'sm', style, ...rest }: BadgeProps) {
  const t = TONES[tone] ?? TONES.neutral;
  const pad = size === 'xs' ? '0 5px' : '1px 7px';
  return (
    <span
      {...rest}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: pad,
        borderRadius: 'var(--radius-sm)',
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.bd}`,
        font: 'var(--type-eyebrow)',
        fontSize: size === 'xs' ? 10 : 11,
        letterSpacing: 'var(--tracking-wide)',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        lineHeight: '16px',
        ...style,
      }}
    >
      {dot && <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />}
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}
