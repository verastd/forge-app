import type { ReactNode } from 'react';

export type ChipTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';

const TONE_CLASS: Record<ChipTone, string> = {
  neutral: '',
  accent: 'chip-accent',
  ok: 'chip-ok',
  warn: 'chip-warn',
  danger: 'chip-danger',
  info: 'chip-info',
};

export function chipClass(tone: ChipTone = 'neutral', extra?: string): string {
  return ['chip', TONE_CLASS[tone], extra].filter(Boolean).join(' ');
}

export function Chip({
  tone = 'neutral',
  className,
  title,
  children,
}: {
  tone?: ChipTone;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={chipClass(tone, className)} title={title}>
      {children}
    </span>
  );
}

/** A chip that filters. Pressed state is the selection, not a hover accident. */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={chipClass('neutral', 'chip-button')} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}
