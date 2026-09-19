'use client';

/**
 * The pipeline, translated (PRD §4.9, "Translated status").
 *
 * Same seven stages the Gauntlet reports, said in words a person who has never
 * seen a CI log can act on.
 */

import { BRIDGE_STAGES } from '@forge/shared';
import type { BridgeStatus } from '@forge/shared';

import { STAGE_LABEL } from '../lib/format';

export function StatusStepper({ status }: { status: BridgeStatus }) {
  const currentIndex = BRIDGE_STAGES.indexOf(status.stage);
  const showChecks = status.checksTotal !== undefined && status.checksPassed !== undefined;

  return (
    <div>
      <ol className="stepper">
        {BRIDGE_STAGES.map((stage, index) => {
          const state =
            index < currentIndex ? 'step-done' : index === currentIndex ? 'step-current' : '';
          return (
            <li
              key={stage}
              className={`step ${state}`}
              aria-current={index === currentIndex ? 'step' : undefined}
            >
              <span className="step-dot" aria-hidden="true">
                {index < currentIndex ? <span>✓</span> : null}
              </span>
              <span className="step-label">{STAGE_LABEL[stage]}</span>
              {index < BRIDGE_STAGES.length - 1 && <span className="step-bar" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      <p className="step-detail">{status.detail}</p>
      {showChecks && (
        <p className="faint">
          {status.checksPassed} of {status.checksTotal} checks passed.
        </p>
      )}
    </div>
  );
}
