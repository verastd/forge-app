/**
 * StepFlow (handoff feedback/StepFlow.jsx, PRD 5.5, CM-12). Controlled shell
 * for Upland-transaction flows. <ol> with aria-current="step"; the body
 * renders the active step's content passed as children. Also exports Receipt,
 * a <dl> for completed money flows.
 */
import { Fragment } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { StatusGlyph } from '../core/StatusGlyph';
import type { GlyphStatus } from '../core/StatusGlyph';

export type FlowStepStatus = 'pending' | 'active' | 'awaiting' | 'complete' | 'failed';

export interface FlowStep {
  id: string;
  label: string;
  status: FlowStepStatus;
}

export interface StepFlowProps {
  title: string;
  steps: FlowStep[];
  children?: ReactNode;
  onClose?: () => void;
  style?: CSSProperties;
}

const GLYPH: Record<FlowStepStatus, GlyphStatus> = { pending: 'pending', active: 'running', awaiting: 'awaiting', complete: 'done', failed: 'failed' };

export function StepFlow({ title, steps = [], children, onClose, style }: StepFlowProps) {
  const activeIdx = steps.findIndex((s) => s.status === 'active' || s.status === 'awaiting' || s.status === 'failed');
  return (
    <div
      role="dialog"
      aria-label={title}
      style={{
        display: 'grid',
        gap: 0,
        width: 520,
        maxWidth: '100%',
        background: 'var(--surface-popover)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--elevation-3)',
        color: 'var(--text-primary)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 0' }}>
        <h2 style={{ margin: 0, font: 'var(--type-h3)' }}>{title}</h2>
        {onClose && <Button variant="ghost" size="dense" icon="x" aria-label="Close" onClick={onClose} />}
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: '12px 16px', display: 'flex', gap: 4, borderBottom: '1px solid var(--border-subtle)', overflowX: 'auto' }}>
        {steps.map((s, i) => (
          <li key={s.id} aria-current={i === activeIdx ? 'step' : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
            <StatusGlyph
              status={GLYPH[s.status]}
              size={14}
              label={
                <span
                  style={{
                    font: i === activeIdx ? 'var(--type-label)' : 'var(--type-caption)',
                    color: i === activeIdx ? 'var(--text-primary)' : s.status === 'failed' ? 'var(--state-error)' : 'var(--text-muted)',
                  }}
                >
                  {s.label}
                </span>
              }
            />
            {i < steps.length - 1 && <Icon name="chevron-right" size={12} style={{ color: 'var(--border-strong)', margin: '0 4px' }} />}
          </li>
        ))}
      </ol>
      <div style={{ padding: 16, display: 'grid', gap: 14 }}>{children}</div>
    </div>
  );
}

export interface ReceiptRow {
  label: string;
  value: ReactNode;
  mono?: boolean;
  strong?: boolean;
}

export interface ReceiptProps {
  rows: ReceiptRow[];
  txId?: string;
  /** Links the real transaction. */
  txHref?: string;
  timestamp?: string;
  onCopy?: () => void;
  style?: CSSProperties;
}

/** Receipt: <dl> for completed money flows. */
export function Receipt({ rows = [], txId, txHref, timestamp, onCopy, style }: ReceiptProps) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 10,
        padding: 14,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--radius-lg)',
        border: '1px dashed var(--border-strong)',
        ...style,
      }}
    >
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 6, columnGap: 16, font: 'var(--type-body-sm)' }}>
        {rows.map((r) => (
          <Fragment key={r.label}>
            <dt
              style={{
                color: 'var(--text-secondary)',
                fontWeight: r.strong ? 600 : 400,
                borderTop: r.strong ? '1px solid var(--border-subtle)' : 'none',
                paddingTop: r.strong ? 6 : 0,
              }}
            >
              {r.label}
            </dt>
            <dd
              className="em-num"
              style={{
                margin: 0,
                textAlign: 'right',
                color: 'var(--text-primary)',
                font: r.mono ? 'var(--type-code)' : 'var(--type-num)',
                fontWeight: r.strong ? 600 : 400,
                borderTop: r.strong ? '1px solid var(--border-subtle)' : 'none',
                paddingTop: r.strong ? 6 : 0,
              }}
            >
              {r.value}
            </dd>
          </Fragment>
        ))}
      </dl>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          font: 'var(--type-caption)',
          color: 'var(--text-muted)',
          flexWrap: 'wrap',
        }}
      >
        {timestamp && <time className="em-num">{timestamp}</time>}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {txId && (
            <span className="em-mono" style={{ font: 'var(--type-code)' }}>
              {txId}
            </span>
          )}
          {txHref && (
            <a href={txHref} style={{ color: 'var(--text-link)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              View tx <Icon name="external-link" size={11} />
            </a>
          )}
          {onCopy && <Button variant="ghost" size="dense" icon="copy" aria-label="Copy receipt" onClick={onCopy} style={{ height: 24, width: 24 }} />}
        </span>
      </div>
    </div>
  );
}
