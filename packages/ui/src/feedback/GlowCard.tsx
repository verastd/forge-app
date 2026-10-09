/**
 * GlowCard (handoff feedback/GlowCard.jsx, adapted SpotlightCard SEL-02).
 * Pointer-tracked glow via CSS variables (no re-render). as: div | a |
 * article. glow: any color token. Effect off on touch and under reduced
 * motion; centered glow on focus. Loading/locked styling comes from children.
 *
 * Port notes: the media checks subscribe to matchMedia (and tolerate
 * environments without it) instead of reading it once per render. Bug fix:
 * the .jsx swallowed a consumer's onPointerMove whenever the effect was off.
 */
import { forwardRef, useRef, useSyncExternalStore } from 'react';
import type { CSSProperties, FocusEvent, HTMLAttributes, PointerEvent, ReactNode, Ref } from 'react';

const useMedia = (query: string): boolean =>
  useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );

export interface GlowCardProps extends Omit<HTMLAttributes<HTMLElement>, 'style' | 'children'> {
  as?: 'div' | 'a' | 'article';
  glow?: string;
  padding?: number;
  /** Only used when `as="a"`. */
  href?: string;
  children: ReactNode;
  style?: CSSProperties;
}

export const GlowCard = forwardRef<HTMLElement, GlowCardProps>(function GlowCard(
  { as: As = 'div', glow = 'var(--accent)', children, style, padding = 16, href, onPointerMove, onPointerLeave, onFocus, onBlur, ...rest },
  ref,
) {
  const inner = useRef<HTMLSpanElement>(null);
  const hover = useMedia('(hover: hover)');
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const enabled = hover && !reduced;
  const set = (x: number, y: number, o: number): void => {
    const el = inner.current;
    if (!el) return;
    el.style.setProperty('--gx', `${x}%`);
    el.style.setProperty('--gy', `${y}%`);
    el.style.setProperty('--go', String(o));
  };
  const Tag = As as 'div';
  return (
    <Tag
      ref={ref as Ref<HTMLDivElement>}
      {...rest}
      {...(As === 'a' ? { href } : {})}
      onPointerMove={(e: PointerEvent<HTMLElement>) => {
        if (enabled) {
          const r = e.currentTarget.getBoundingClientRect();
          set(((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100, 1);
        }
        onPointerMove?.(e);
      }}
      onPointerLeave={(e: PointerEvent<HTMLElement>) => {
        set(50, 50, 0);
        onPointerLeave?.(e);
      }}
      onFocus={(e: FocusEvent<HTMLElement>) => {
        set(50, 30, 0.7);
        onFocus?.(e);
      }}
      onBlur={(e: FocusEvent<HTMLElement>) => {
        set(50, 50, 0);
        onBlur?.(e);
      }}
      style={{
        position: 'relative',
        display: 'block',
        overflow: 'hidden',
        padding,
        background: 'var(--surface-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        color: 'var(--text-primary)',
        textDecoration: 'none',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      <span
        ref={inner}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: `radial-gradient(360px circle at var(--gx, 50%) var(--gy, 50%), color-mix(in oklab, ${glow} 22%, transparent), transparent 60%)`,
          opacity: 'var(--go, 0)',
          transition: 'opacity var(--dur-base) var(--ease-out)',
        }}
      />
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${glow} 30%, transparent)`,
          borderRadius: 'inherit',
          opacity: 0.6,
        }}
      />
      <div style={{ position: 'relative' }}>{children}</div>
    </Tag>
  );
});
