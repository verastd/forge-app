/**
 * Hint (handoff core/Hint.jsx, adapted WarmTooltip SEL-20). Hover 400 ms /
 * focus instant; hoverable content; merged aria-describedby; Escape closes.
 * For disabled reasons (`persistent`) the text is ALSO rendered visually
 * hidden so screen readers get it without opening.
 */
import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

export interface HintProps {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  persistent?: boolean;
  delay?: number;
  maxWidth?: number;
}

type TriggerProps = {
  'aria-describedby'?: string;
  onPointerEnter?: (e: unknown) => void;
  onPointerLeave?: (e: unknown) => void;
  onFocus?: (e: unknown) => void;
  onBlur?: (e: unknown) => void;
};

const POSITIONS: Record<NonNullable<HintProps['side']>, CSSProperties> = {
  top: { bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' },
  bottom: { top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' },
  right: { left: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' },
  left: { right: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' },
};

export function Hint({ content, children, side = 'top', persistent = false, delay = 400, maxWidth = 260 }: HintProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (ms: number): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), ms);
  };
  const hide = (): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 80);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const child = Children.only(children);
  if (!isValidElement<TriggerProps>(child)) return child;
  const props = child.props;
  const prev = props['aria-describedby'];
  const trigger = cloneElement(child, {
    'aria-describedby': [prev, open || persistent ? id : null].filter(Boolean).join(' ') || undefined,
    onPointerEnter: (e: unknown) => {
      props.onPointerEnter?.(e);
      show(delay);
    },
    onPointerLeave: (e: unknown) => {
      props.onPointerLeave?.(e);
      hide();
    },
    onFocus: (e: unknown) => {
      props.onFocus?.(e);
      show(0);
    },
    onBlur: (e: unknown) => {
      props.onBlur?.(e);
      hide();
    },
  });
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger}
      {persistent && !open && (
        <span id={id} className="em-sr">
          {content}
        </span>
      )}
      {open && (
        <span
          role="tooltip"
          id={id}
          onPointerEnter={() => show(0)}
          onPointerLeave={hide}
          style={{
            position: 'absolute',
            zIndex: 'var(--z-popover)' as unknown as number,
            ...POSITIONS[side],
            background: 'var(--surface-inverse)',
            color: 'var(--text-inverse)',
            font: 'var(--type-caption)',
            padding: '6px 8px',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--elevation-2)',
            width: 'max-content',
            maxWidth,
            whiteSpace: 'normal',
            lineHeight: 1.4,
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
