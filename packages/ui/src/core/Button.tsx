/**
 * Base button (handoff core/Button.jsx). variant: primary | secondary | ghost |
 * danger | link. size: dense (32) | standard (36) | comfortable (40).
 * Never uses native `disabled` for reasoned states: pass aria-disabled and a
 * guarded handler (see AsyncButton). `as` renders another element with the
 * same look, e.g. "a" or a framework link component.
 */
import { forwardRef, useState } from 'react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, CSSProperties, ElementType, PointerEvent, ReactNode } from 'react';

import { Icon } from './Icon';
import type { IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'dense' | 'standard' | 'comfortable';

export const BUTTON_HEIGHT: Record<ButtonSize, string> = {
  dense: 'var(--control-dense)',
  standard: 'var(--control-standard)',
  comfortable: 'var(--control-comfortable)',
};

type NativeProps = Omit<ButtonHTMLAttributes<HTMLElement> & AnchorHTMLAttributes<HTMLElement>, 'style' | 'children' | 'type'>;

export interface ButtonProps extends NativeProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  full?: boolean;
  /** Render as another element or component (e.g. "a", or a router link) with the same look. */
  as?: ElementType;
  type?: 'button' | 'submit' | 'reset';
  children?: ReactNode;
  style?: CSSProperties;
  [data: `data-${string}`]: string | undefined;
}

export const Button = forwardRef<HTMLElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'standard', icon, iconRight, children, style, full, as: As = 'button', type, onPointerEnter, onPointerLeave, onPointerDown, onPointerUp, ...rest },
  ref,
) {
  const [hover, setHover] = useState(false);
  const [down, setDown] = useState(false);
  const base = {
    primary: { bg: hover ? 'var(--accent-hover)' : 'var(--accent)', fg: 'var(--on-accent)', bd: 'transparent' },
    secondary: { bg: hover ? 'var(--surface-hover)' : 'var(--surface-card)', fg: 'var(--text-primary)', bd: 'var(--border-strong)' },
    ghost: { bg: hover ? 'var(--surface-hover)' : 'transparent', fg: 'var(--text-primary)', bd: 'transparent' },
    danger: { bg: hover ? 'var(--danger-hover)' : 'var(--danger)', fg: 'var(--on-danger)', bd: 'transparent' },
    link: { bg: 'transparent', fg: 'var(--text-link)', bd: 'transparent' },
  }[variant];
  const dis = rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  const iconOnly = children === undefined || children === null || children === false;
  return (
    <As
      ref={ref}
      type={As === 'button' ? (type ?? 'button') : undefined}
      {...rest}
      onPointerEnter={(e: PointerEvent<HTMLElement>) => {
        setHover(true);
        onPointerEnter?.(e);
      }}
      onPointerLeave={(e: PointerEvent<HTMLElement>) => {
        setHover(false);
        setDown(false);
        onPointerLeave?.(e);
      }}
      onPointerDown={(e: PointerEvent<HTMLElement>) => {
        setDown(true);
        onPointerDown?.(e);
      }}
      onPointerUp={(e: PointerEvent<HTMLElement>) => {
        setDown(false);
        onPointerUp?.(e);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: BUTTON_HEIGHT[size],
        padding: iconOnly ? 0 : variant === 'link' ? '0 2px' : '0 var(--control-padding-x)',
        width: iconOnly ? BUTTON_HEIGHT[size] : full ? '100%' : undefined,
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${base.bd}`,
        background: base.bg,
        color: base.fg,
        font: 'var(--type-label)',
        fontSize: size === 'dense' ? 'var(--text-xs)' : 'var(--text-sm)',
        cursor: dis ? 'not-allowed' : 'pointer',
        opacity: dis ? 0.55 : 1,
        transform: down && !dis ? 'scale(0.985)' : 'none',
        transition: 'background var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)',
        whiteSpace: 'nowrap',
        textDecoration: 'none',
        userSelect: 'none',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={size === 'dense' ? 14 : 16} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'dense' ? 14 : 16} />}
    </As>
  );
});
