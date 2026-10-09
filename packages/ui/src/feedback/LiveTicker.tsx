/**
 * LiveTicker (handoff feedback/LiveTicker.jsx, adapted Marquee SEL-08). The
 * first copy is real; the duplicate is aria-hidden + inert. Visible
 * Pause/Play (aria-pressed), pauses on hover and focus-within, static
 * scrollable row under reduced motion. Never the only place the data
 * appears; `moreHref` links to the feed.
 *
 * Port notes: reduced motion is read through a matchMedia subscription (safe
 * where matchMedia is missing). Bug fix: the .jsx documented pause on
 * focus-within but only paused on hover. `play`/`pause` are not in ICONS, so
 * the Lucide glyphs are rendered directly until Icon.tsx gains them.
 */
import { useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { Button } from '../core/Button';
import { Icon } from '../core/Icon';

const QUERY = '(prefers-reduced-motion: reduce)';
const useReducedMotion = (): boolean =>
  useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const m = window.matchMedia(QUERY);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches,
    () => false,
  );

export interface LiveTickerProps<T = ReactNode> {
  items: T[];
  /** Required unless the items are themselves renderable. */
  renderItem?: (item: T) => ReactNode;
  /** Pixels-per-second feel: higher is faster. */
  speed?: number;
  label?: string;
  moreHref?: string;
  /** Controlled pause; omit to let the ticker own it. */
  paused?: boolean;
  onTogglePause?: (paused: boolean) => void;
  style?: CSSProperties;
}

export function LiveTicker<T = ReactNode>({
  items = [],
  renderItem,
  speed = 40,
  label = 'Live activity',
  moreHref,
  paused: controlledPaused,
  onTogglePause,
  style,
}: LiveTickerProps<T>) {
  const [inner, setInner] = useState(false);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = controlledPaused ?? inner;
  const reduced = useReducedMotion();
  const dur = Math.max(10, items.length * (100 / speed));
  const row = (hidden: boolean) => (
    <div aria-hidden={hidden || undefined} inert={hidden || undefined} style={{ display: 'flex', gap: 32, flex: 'none', paddingRight: 32 }}>
      {items.map((it, i) => (
        <span
          key={i}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', font: 'var(--type-body-sm)', color: 'var(--text-secondary)' }}
        >
          {renderItem ? renderItem(it) : (it as ReactNode)}
        </span>
      ))}
    </div>
  );
  const mask = reduced ? 'none' : 'linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent)';
  return (
    <section
      aria-label={label}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setFocused(false);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 40,
        background: 'var(--surface-card)',
        borderTop: '1px solid var(--border-subtle)',
        borderBottom: '1px solid var(--border-subtle)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <Button
        variant="ghost"
        size="dense"
        aria-label={paused ? 'Play ticker' : 'Pause ticker'}
        aria-pressed={paused}
        onClick={() => (onTogglePause ? onTogglePause(!paused) : setInner((p) => !p))}
        style={{ flex: 'none', marginLeft: 8, height: 28, width: 28, padding: 0 }}
      >
        <Icon name={paused ? 'play' : 'pause'} size={14} />
      </Button>
      <div style={{ flex: 1, overflow: reduced ? 'auto' : 'hidden', position: 'relative', WebkitMaskImage: mask, maskImage: mask }}>
        <div
          className="em-motion"
          style={{
            display: 'flex',
            width: 'max-content',
            // play-state rides in the shorthand: mixing `animation` with `animationPlayState` makes React drop one on rerender.
            animation: reduced ? 'none' : `em-marquee ${dur}s linear infinite ${paused || hover || focused ? 'paused' : 'running'}`,
          }}
        >
          {row(false)}
          {!reduced && row(true)}
        </div>
      </div>
      {moreHref && (
        <a
          href={moreHref}
          style={{ flex: 'none', marginRight: 12, font: 'var(--type-label)', color: 'var(--text-link)', textDecoration: 'none', whiteSpace: 'nowrap' }}
        >
          Full feed →
        </a>
      )}
    </section>
  );
}
