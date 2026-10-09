/** StatusBanner (handoff core/StatusBanner.jsx): partial | stale | capped | maintenance | info. role="status" (or "alert" for maintenance). Unmounts fully when dismissed. */
import type { CSSProperties, ReactNode } from 'react';

import { AsyncButton } from './AsyncButton';
import { Button } from './Button';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export type StatusBannerKind = 'partial' | 'stale' | 'capped' | 'maintenance' | 'info';

const KINDS: Record<StatusBannerKind, [string, string, IconName]> = {
  partial: ['var(--state-warning)', 'var(--state-warning-soft)', 'triangle-alert'],
  stale: ['var(--state-stale)', 'var(--state-warning-soft)', 'clock'],
  capped: ['var(--state-info)', 'var(--state-info-soft)', 'list-filter'],
  maintenance: ['var(--state-error)', 'var(--state-error-soft)', 'wrench'],
  info: ['var(--state-info)', 'var(--state-info-soft)', 'info'],
};

export interface StatusBannerProps {
  kind?: StatusBannerKind;
  actionLabel?: string;
  /** May return a Promise: the action button then shows its pending state. */
  onAction?: () => unknown;
  onDismiss?: () => void;
  children: ReactNode;
  style?: CSSProperties;
}

export function StatusBanner({ kind = 'info', children, actionLabel, onAction, onDismiss, style }: StatusBannerProps) {
  const [fg, bg, icon] = KINDS[kind];
  return (
    <div
      role={kind === 'maintenance' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 'var(--radius-md)',
        background: bg,
        color: 'var(--text-primary)',
        font: 'var(--type-body-sm)',
        borderLeft: 'none',
        border: `1px solid color-mix(in oklab, ${fg} 35%, transparent)`,
        ...style,
      }}
    >
      <Icon name={icon} size={16} style={{ color: fg }} />
      <span style={{ flex: 1 }}>{children}</span>
      {actionLabel &&
        (onAction ? (
          <AsyncButton
            size="dense"
            variant="secondary"
            label={actionLabel}
            pendingLabel={actionLabel.replace(/y$/, 'ying').replace(/^Refresh$/, 'Refreshing')}
            onAction={async () => {
              await onAction();
            }}
          />
        ) : (
          <Button size="dense">{actionLabel}</Button>
        ))}
      {onDismiss && <Button size="dense" variant="ghost" icon="x" onClick={onDismiss} aria-label="Dismiss" />}
    </div>
  );
}
