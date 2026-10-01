'use client';

/**
 * "Open my agent": one link per open rail that opens the contributor's agent
 * with the task already typed in; they press send (Phase 4 contract §2, open
 * rails). The links come from `lib/launch.ts` at render time, so each is a
 * real `<a href>` the browser follows on the click itself — a custom scheme
 * opened after an `await` would be blocked. The click also notes the hand-off
 * with a fire-and-forget request that can never hold the link up.
 *
 * Google Antigravity has no link at all, so its button shows the steps.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { railMeta } from '@forge/shared';
import type { OpenRail } from '@forge/shared';

import { SetupSteps } from './StartRails';
import { apiBase, recordOpen } from '../../lib/api';
import { CONNECT_PATH } from '../../lib/handoff';
import { launchLinks } from '../../lib/launch';
import styles from './contribute.module.css';

export function OpenRails({
  taskId,
  brief,
  login,
  appSlug,
  onOpened,
}: {
  taskId: number;
  brief: string;
  /** The signed-in GitHub login; null for the practice account. */
  login: string | null;
  appSlug: string | null;
  onOpened: (rail: OpenRail) => void;
}) {
  const launches = useMemo(() => launchLinks({ taskId, brief, login, apiBase }), [taskId, brief, login]);
  const [stepsOpen, setStepsOpen] = useState<OpenRail | null>(null);

  return (
    <div className="stack">
      <ul className={styles.railGrid}>
        {launches.map((launch) => {
          const meta = railMeta(launch.rail);
          const describedBy = `open-${launch.rail}-about`;
          const about = (
            <span id={describedBy} className="stack" style={{ gap: 4 }}>
              <span className="rail-grade">{meta.blurb}</span>
              {meta.plan !== undefined && <span className="rail-note">{meta.plan}</span>}
            </span>
          );
          return (
            <li key={launch.rail} className={styles.railItem}>
              {launch.href === null ? (
                <>
                  <button
                    type="button"
                    className={`rail ${stepsOpen === launch.rail ? styles.railChosen : ''}`}
                    aria-expanded={stepsOpen === launch.rail}
                    aria-controls={`open-${launch.rail}-steps`}
                    aria-describedby={describedBy}
                    onClick={() => setStepsOpen((current) => (current === launch.rail ? null : launch.rail))}
                  >
                    <span className="rail-head">
                      <span className="rail-name">{meta.label}</span>
                      <span className={styles.railMark} aria-hidden="true">
                        {stepsOpen === launch.rail ? '▾' : '▸'}
                      </span>
                    </span>
                    {about}
                  </button>
                  {stepsOpen === launch.rail && (
                    <ol id={`open-${launch.rail}-steps`} className="steps">
                      {(launch.steps ?? []).map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  )}
                </>
              ) : (
                <a
                  className="rail"
                  href={launch.href}
                  aria-label={`Open ${meta.label}`}
                  aria-describedby={describedBy}
                  {...(launch.kind === 'web' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  onClick={() => {
                    recordOpen(taskId, launch.rail);
                    onOpened(launch.rail);
                  }}
                >
                  <span className="rail-head">
                    <span className="rail-name">{meta.label}</span>
                    <span className={styles.railMark} aria-hidden="true">
                      {launch.kind === 'web' ? '↗' : '⇢'}
                    </span>
                  </span>
                  {about}
                </a>
              )}
              {launch.note !== undefined && <p className={styles.note}>{launch.note}</p>}
              <details className={styles.firstTime}>
                <summary>First time with {meta.label}?</summary>
                <SetupSteps meta={meta} vault={false} appSlug={appSlug} />
              </details>
            </li>
          );
        })}
      </ul>
      <p className="muted">
        <Link href={CONNECT_PATH} className={styles.inlineLink}>
          Connect your agent to FORGE once
        </Link>{' '}
        and it can report progress and read check results by itself.
      </p>
    </div>
  );
}
