/**
 * JobPhaseList (handoff feedback/JobPhaseList.jsx, adapted Multi Step Loader
 * SEL-03). Controlled inline phase list. One polite summary ("Step 3 of 5:
 * …"), aria-current on the active row, only confirmed phases get a check.
 */
import type { CSSProperties } from 'react';

import { Button } from '../core/Button';
import { StatusGlyph } from '../core/StatusGlyph';
import type { GlyphStatus } from '../core/StatusGlyph';

export type JobStepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped';

export interface JobStep {
  id: string;
  label: string;
  status: JobStepStatus;
  detail?: string;
}

export interface JobPhaseListProps {
  steps: JobStep[];
  onRetry?: (id: string) => void;
  onCancel?: () => void;
  /** Shows the "Upland is slow" note under the active phase. */
  slow?: boolean;
  style?: CSSProperties;
}

const GLYPH: Record<JobStepStatus, GlyphStatus> = { pending: 'pending', active: 'running', done: 'done', error: 'failed', skipped: 'cancelled' };

export function JobPhaseList({ steps = [], onRetry, onCancel, slow, style }: JobPhaseListProps) {
  const activeIdx = steps.findIndex((s) => s.status === 'active' || s.status === 'error');
  const active = steps[activeIdx];
  const summary = active
    ? `Step ${activeIdx + 1} of ${steps.length}: ${active.label}`
    : steps.every((s) => s.status === 'done' || s.status === 'skipped')
      ? 'Complete'
      : '';
  return (
    <div style={{ display: 'grid', gap: 8, ...style }}>
      <span role="status" className="em-sr">
        {summary}
      </span>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
        {steps.map((s, i) => (
          <li
            key={s.id}
            aria-current={i === activeIdx ? 'step' : undefined}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr auto',
              alignItems: 'start',
              gap: 10,
              padding: '6px 8px',
              borderRadius: 'var(--radius-sm)',
              background: i === activeIdx ? 'var(--surface-sunken)' : 'transparent',
            }}
          >
            <StatusGlyph status={GLYPH[s.status]} size={16} style={{ marginTop: 1 }} />
            <span style={{ display: 'grid', gap: 1, minWidth: 0 }}>
              <span
                style={{
                  font: s.status === 'active' ? 'var(--type-label)' : 'var(--type-body-sm)',
                  color:
                    s.status === 'pending' || s.status === 'skipped'
                      ? 'var(--text-secondary)'
                      : s.status === 'error'
                        ? 'var(--state-error)'
                        : 'var(--text-primary)',
                  textDecoration: s.status === 'skipped' ? 'none' : undefined,
                }}
              >
                {s.label}
                {s.status === 'skipped' && <span style={{ color: 'var(--text-muted)' }}> · skipped</span>}
              </span>
              {s.detail && <span style={{ font: 'var(--type-caption)', color: s.status === 'error' ? 'var(--state-error)' : 'var(--text-muted)' }}>{s.detail}</span>}
              {s.status === 'active' && slow && <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>Still working, Upland is slow</span>}
            </span>
            {s.status === 'error' && onRetry && (
              <Button size="dense" variant="secondary" onClick={() => onRetry(s.id)} style={{ height: 26 }}>
                Retry
              </Button>
            )}
          </li>
        ))}
      </ol>
      {onCancel && active?.status === 'active' && (
        <div>
          <Button variant="ghost" size="dense" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
