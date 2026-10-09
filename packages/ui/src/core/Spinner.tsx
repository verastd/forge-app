/** Indeterminate spinner (handoff core/Spinner.jsx). em-spin keyframes; static under reduced motion. */
import type { CSSProperties } from 'react';

export interface SpinnerProps {
  size?: number;
  color?: string;
  label?: string;
  style?: CSSProperties;
}

export function Spinner({ size = 16, color = 'currentColor', label = 'Loading', style }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className="em-motion"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        flex: 'none',
        borderRadius: '50%',
        border: `${Math.max(2, Math.round(size / 8))}px solid`,
        borderColor: `${color} transparent ${color} ${color}`,
        opacity: 0.9,
        animation: 'em-spin 700ms linear infinite',
        boxSizing: 'border-box',
        ...style,
      }}
    />
  );
}
