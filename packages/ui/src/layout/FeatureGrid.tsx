/**
 * FeatureGrid (handoff layout/FeatureGrid.jsx, adapted Bento Grid SEL-05).
 * Tier-grouped tile grid; tiles are links. Locked tiles show the tier as text
 * and route to plans.
 */
import { useState } from 'react';
import type { CSSProperties } from 'react';

import { Badge } from '../core/Badge';
import { Icon } from '../core/Icon';
import type { IconName } from '../core/Icon';

export type FeatureTier = 'free' | 'basic' | 'premium';

export interface FeatureTile {
  title: string;
  description: string;
  icon: IconName;
  href?: string;
  colSpan?: number;
  locked?: boolean;
}

export interface FeatureGroup {
  tier: FeatureTier;
  title: string;
  tiles: FeatureTile[];
}

export interface FeatureGridProps {
  groups: FeatureGroup[];
  columns?: number;
  style?: CSSProperties;
}

export function FeatureGrid({ groups = [], columns = 3, style }: FeatureGridProps) {
  return (
    <div style={{ display: 'grid', gap: 28, ...style }}>
      {groups.map((g) => (
        <section key={g.tier} aria-label={g.title} style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Badge tone={g.tier}>{g.tier}</Badge>
            <h3 style={{ margin: 0, font: 'var(--type-title)', color: 'var(--text-primary)' }}>{g.title}</h3>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 12 }}>
            {g.tiles.map((t) => (
              <Tile key={t.title} {...t} tier={g.tier} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// The .jsx read window.matchMedia during render, which throws where it is
// missing (SSR, jsdom). Treat "unknown" as "motion allowed".
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function Tile({ title, description, icon, href = '#', colSpan = 1, locked, tier }: FeatureTile & { tier: FeatureTier }) {
  const [h, setH] = useState(false);
  return (
    <a
      href={locked ? '#pricing' : href}
      onPointerEnter={() => setH(true)}
      onPointerLeave={() => setH(false)}
      style={{ gridColumn: `span ${colSpan}`, display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 10, minHeight: 150, padding: 16, background: 'var(--surface-card)', border: `1px solid ${h ? 'var(--border-strong)' : 'var(--border-subtle)'}`, borderRadius: 'var(--radius-lg)', boxShadow: h ? 'var(--elevation-2)' : 'var(--elevation-1)', textDecoration: 'none', color: 'var(--text-primary)', transform: h && !prefersReducedMotion() ? 'translateY(-2px)' : 'none', transition: 'all var(--dur-base) var(--ease-out)', opacity: locked ? 0.85 : 1 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, borderRadius: 'var(--radius-md)', background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>
          <Icon name={icon} size={16} />
        </span>
        {locked && (
          <Badge tone={tier} icon="lock">
            {tier}
          </Badge>
        )}
      </div>
      <div style={{ display: 'grid', gap: 4, alignContent: 'start' }}>
        <span style={{ font: 'var(--type-title)' }}>{title}</span>
        <span style={{ font: 'var(--type-body-sm)', color: 'var(--text-secondary)' }}>{description}</span>
      </div>
      <span style={{ font: 'var(--type-label)', color: locked ? 'var(--text-muted)' : 'var(--text-link)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        {locked ? 'See plans' : 'Open'} <Icon name="arrow-right" size={12} />
      </span>
    </a>
  );
}
