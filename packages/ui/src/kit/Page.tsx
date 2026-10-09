/**
 * Page building blocks from the handoff's UI kit (ui_kits/embers/kit.jsx and
 * the screens built on it): every screen title uses --type-h1; section blocks
 * use an h3-sized title followed by a muted caption note; cards are
 * surface-card + border-subtle + radius-lg + elevation-1 (DESIGN_SYSTEM.md
 * "Surfaces & cards").
 */
import type { CSSProperties, ReactNode } from 'react';

export interface PageHeaderProps {
  title: ReactNode;
  /** A short line under the title. */
  lede?: ReactNode;
  /** Right-aligned controls or indicators (LiveIndicator, actions). */
  aside?: ReactNode;
  /** Small label above the title (e.g. "Property #123"). */
  eyebrow?: ReactNode;
}

/** The screen title row, as the kit screens lay it out (title left, controls right, wrapping). */
export function PageHeader({ title, lede, aside, eyebrow }: PageHeaderProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        {eyebrow && (
          <span style={{ font: 'var(--type-eyebrow)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide)', color: 'var(--text-muted)' }}>
            {eyebrow}
          </span>
        )}
        <h1 style={{ margin: 0, font: 'var(--type-h1)', letterSpacing: 'var(--tracking-tight)', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{title}</h1>
        {lede && <p style={{ margin: 0, font: 'var(--type-body)', color: 'var(--text-secondary)', maxWidth: '72ch' }}>{lede}</p>}
      </div>
      {aside && <div style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{aside}</div>}
    </div>
  );
}

export interface BlockProps {
  title?: ReactNode;
  note?: ReactNode;
  /** Right-aligned controls in the title row. */
  aside?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  id?: string;
}

/** kit.jsx Block: a titled section (h2 element, --type-h3 look) with a muted caption note. */
export function Block({ title, note, aside, children, style, id }: BlockProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section aria-labelledby={headingId} style={{ display: 'grid', gap: 12, minWidth: 0, alignContent: 'start', ...style }}>
      {(title || note || aside) && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          {title && (
            <h2 id={headingId} style={{ margin: 0, font: 'var(--type-h3)', color: 'var(--text-primary)' }}>
              {title}
            </h2>
          )}
          {note && <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>{note}</span>}
          {aside && <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>{aside}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** kit.jsx Card, with the DESIGN_SYSTEM.md card elevation. */
export function Card({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        padding: 16,
        background: 'var(--surface-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--elevation-1)',
        display: 'grid',
        gap: 12,
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A responsive grid of StatTiles (or cards), as the kit's KPI rows. */
export function TileRow({ children, min = 190 }: { children?: ReactNode; min?: number }) {
  return <div style={{ display: 'grid', gap: 12, gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}px), 1fr))` }}>{children}</div>;
}

/** A definition list for detail panels: muted terms, values in the body face. */
export function FactList({ items }: { items: ReadonlyArray<{ term: ReactNode; value: ReactNode; mono?: boolean }> }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '6px 16px', margin: 0, font: 'var(--type-body-sm)' }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt style={{ color: 'var(--text-muted)' }}>{it.term}</dt>
          <dd className={it.mono ? 'em-num' : undefined} style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere', color: 'var(--text-primary)' }}>
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
