/**
 * RecommendedBeam (handoff feedback/RecommendedBeam.jsx, adapted Border Beam
 * SEL-09). Decorative travelling highlight on ONE card (the recommended plan).
 * aria-hidden; under reduced motion renders a static token border. Parent must
 * be position:relative with a border-radius; pair with a visible
 * "Recommended" badge.
 *
 * Port note: reduced motion is read through a matchMedia subscription (live
 * updates, and safe where matchMedia is missing) instead of once per render.
 */
import { useSyncExternalStore } from 'react';

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

export interface RecommendedBeamProps {
  colorFrom?: string;
  colorTo?: string;
  size?: number;
  duration?: number;
  borderWidth?: number;
}

export function RecommendedBeam({ colorFrom = 'var(--tier-premium)', colorTo = 'var(--accent)', size = 120, duration = 6, borderWidth = 1.5 }: RecommendedBeamProps) {
  const reduced = useReducedMotion();
  if (reduced) {
    return (
      <span
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none', border: `${borderWidth}px solid ${colorFrom}` }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        pointerEvents: 'none',
        overflow: 'hidden',
        padding: borderWidth,
        boxSizing: 'border-box',
        WebkitMaskImage: 'linear-gradient(#000, #000), linear-gradient(#000, #000)',
        WebkitMaskClip: 'padding-box, border-box',
        WebkitMaskComposite: 'xor',
        maskComposite: 'exclude',
        maskClip: 'padding-box, border-box',
        maskImage: 'linear-gradient(#000, #000), linear-gradient(#000, #000)',
      }}
    >
      <span
        className="em-motion"
        style={{
          position: 'absolute',
          width: size,
          height: size,
          offsetPath: `rect(0 auto auto 0 round ${size}px)`,
          offsetAnchor: '50% 50%',
          background: `linear-gradient(90deg, transparent, ${colorFrom}, ${colorTo})`,
          animation: `em-beam ${duration}s linear infinite`,
          borderRadius: '50%',
          filter: 'blur(2px)',
        }}
      />
    </span>
  );
}
