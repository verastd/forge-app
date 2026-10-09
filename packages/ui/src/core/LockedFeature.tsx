/**
 * LockedFeature (handoff core/LockedFeature.jsx, PRD 5.6). Renders from session
 * entitlements, no spinner-then-lock flash. `anonymous` swaps CTAs to Log in /
 * Create free account.
 */
import type { CSSProperties } from 'react';

import { Badge } from './Badge';
import { Button } from './Button';
import { Icon } from './Icon';

export interface LockedFeatureProps {
  feature: string;
  tier?: 'Basic' | 'Premium';
  value?: string;
  anonymous?: boolean;
  onUpgrade?: () => void;
  onCompare?: () => void;
  onLogin?: () => void;
  onSignup?: () => void;
  compact?: boolean;
  style?: CSSProperties;
}

export function LockedFeature({ feature, tier = 'Premium', value, anonymous, onUpgrade, onCompare, onLogin, onSignup, compact, style }: LockedFeatureProps) {
  const tone = tier.toLowerCase() as 'basic' | 'premium';
  return (
    <div
      style={{
        display: 'grid',
        gap: compact ? 8 : 12,
        padding: compact ? 16 : 32,
        justifyItems: 'center',
        textAlign: 'center',
        background: 'var(--surface-card)',
        border: '1px dashed var(--border-strong)',
        borderRadius: 'var(--radius-lg)',
        ...style,
      }}
    >
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--surface-sunken)',
          color: 'var(--text-secondary)',
        }}
      >
        <Icon name="lock" size={16} />
      </span>
      <div style={{ display: 'grid', gap: 4, justifyItems: 'center' }}>
        <span style={{ font: 'var(--type-title)' }}>{feature}</span>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
          Requires <Badge tone={tone}>{tier}</Badge>
        </span>
        {value && <span style={{ font: 'var(--type-body-sm)', color: 'var(--text-secondary)', maxWidth: 360 }}>{value}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {anonymous ? (
          <>
            <Button variant="primary" onClick={onLogin}>
              Log in
            </Button>
            <Button onClick={onSignup}>Create free account</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={onUpgrade}>
              Upgrade
            </Button>
            <Button onClick={onCompare}>Compare plans</Button>
          </>
        )}
      </div>
    </div>
  );
}
