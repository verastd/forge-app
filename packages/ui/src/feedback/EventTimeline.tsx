/**
 * EventTimeline (handoff feedback/EventTimeline.jsx, adapted Timeline SEL-04).
 * <ol> with <time dateTime>; density: compact (construction history) |
 * comfortable (changelog). The beam is a static token line; no scroll-linked
 * motion. `onLoadMore` paginates while `hasMore`.
 *
 * Port note (bug fix): the .jsx put the decorative beam <span> directly inside
 * the <ol>, where only <li> is allowed (screen readers can miscount the list).
 * The beam now sits in a relative wrapper around the <ol> at the same offsets.
 */
import type { CSSProperties, ReactNode } from 'react';

import { Button } from '../core/Button';
import { Spinner } from '../core/Spinner';
import { StatusGlyph } from '../core/StatusGlyph';
import type { GlyphStatus } from '../core/StatusGlyph';

export interface TimelineEntry {
  id: string;
  /** Machine-readable date for <time dateTime>. */
  date: string;
  dateLabel?: string;
  title: string;
  content?: ReactNode;
  status?: GlyphStatus;
}

export interface EventTimelineProps {
  entries: TimelineEntry[];
  density?: 'compact' | 'comfortable';
  heading?: string;
  onLoadMore?: () => void;
  hasMore?: boolean;
  /** Older entries are loading: the button spins, ignores presses, and says so. */
  loadingMore?: boolean;
  /** Loading older entries failed: shown under the button, which then reads "Retry". */
  loadMoreError?: string;
  style?: CSSProperties;
}

export function EventTimeline({ entries = [], density = 'compact', heading, onLoadMore, hasMore, loadingMore, loadMoreError, style }: EventTimelineProps) {
  const compact = density === 'compact';
  return (
    <section aria-label={heading} style={{ display: 'grid', gap: compact ? 8 : 16, ...style }}>
      {heading && <h3 style={{ margin: 0, font: compact ? 'var(--type-title)' : 'var(--type-h2)', color: 'var(--text-primary)' }}>{heading}</h3>}
      <div style={{ position: 'relative' }}>
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 8,
            bottom: 8,
            left: compact ? 7 : 9,
            width: 2,
            background: 'linear-gradient(180deg, var(--accent), var(--border-subtle) 30%, var(--border-subtle))',
            borderRadius: 1,
          }}
        />
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative', display: 'grid', gap: compact ? 0 : 20 }}>
          {entries.map((e) => (
            <li
              key={e.id}
              style={{
                position: 'relative',
                display: 'grid',
                gridTemplateColumns: compact ? '16px 96px 1fr' : '20px 1fr',
                columnGap: compact ? 12 : 16,
                alignItems: 'start',
                padding: compact ? '6px 0' : 0,
              }}
            >
              <span style={{ display: 'grid', placeItems: 'center', height: compact ? 20 : 24, background: 'var(--surface-page)', position: 'relative', zIndex: 1 }}>
                {e.status ? (
                  <StatusGlyph status={e.status} size={compact ? 14 : 16} />
                ) : (
                  <span
                    style={{
                      width: compact ? 8 : 10,
                      height: compact ? 8 : 10,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                      boxShadow: '0 0 0 3px var(--surface-page)',
                    }}
                  />
                )}
              </span>
              {compact ? (
                <>
                  <time
                    dateTime={e.date}
                    className="em-num"
                    style={{ font: 'var(--type-caption)', color: 'var(--text-muted)', lineHeight: '20px', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {e.dateLabel || e.date}
                  </time>
                  <span style={{ display: 'grid', gap: 1, minWidth: 0 }}>
                    <span style={{ font: 'var(--type-body-sm)', color: 'var(--text-primary)', lineHeight: '20px' }}>{e.title}</span>
                    {e.content && <span style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>{e.content}</span>}
                  </span>
                </>
              ) : (
                <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                  <time
                    dateTime={e.date}
                    style={{
                      font: 'var(--type-eyebrow)',
                      color: 'var(--accent-strong)',
                      textTransform: 'uppercase',
                      letterSpacing: 'var(--tracking-wide)',
                      lineHeight: '24px',
                    }}
                  >
                    {e.dateLabel || e.date}
                  </time>
                  <span style={{ font: 'var(--type-h3)', color: 'var(--text-primary)' }}>{e.title}</span>
                  {e.content && <div style={{ font: 'var(--type-body)', color: 'var(--text-secondary)', maxWidth: 640 }}>{e.content}</div>}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
      {hasMore && (
        <div style={{ display: 'grid', gap: 4, justifyItems: 'start' }}>
          <Button
            variant="secondary"
            size="dense"
            aria-disabled={loadingMore ? true : undefined}
            aria-busy={loadingMore ? 'true' : undefined}
            onClick={() => {
              if (!loadingMore) onLoadMore?.();
            }}
          >
            {loadingMore ? (
              <>
                <Spinner size={12} label="" />
                Loading older…
              </>
            ) : loadMoreError ? (
              'Retry'
            ) : (
              'Load older'
            )}
          </Button>
          {loadMoreError && (
            <span role="alert" style={{ font: 'var(--type-caption)', color: 'var(--state-error)' }}>
              {loadMoreError}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
