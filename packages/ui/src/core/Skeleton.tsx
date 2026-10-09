/** Skeleton block with shimmer (handoff core/Skeleton.jsx); static under reduced motion. Shape: text | rect | circle. */
import type { CSSProperties } from 'react';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  shape?: 'text' | 'rect' | 'circle';
  style?: CSSProperties;
}

export function Skeleton({ width = '100%', height = 12, shape = 'rect', style }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className="em-motion"
      style={{
        display: 'block',
        width,
        height,
        borderRadius: shape === 'circle' ? '50%' : shape === 'text' ? 3 : 'var(--radius-sm)',
        background: 'linear-gradient(90deg, var(--skeleton) 25%, var(--skeleton-shine) 50%, var(--skeleton) 75%)',
        backgroundSize: '200% 100%',
        animation: 'em-shimmer 1.4s linear infinite',
        ...style,
      }}
    />
  );
}
