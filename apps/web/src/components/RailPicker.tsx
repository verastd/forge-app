'use client';

/**
 * Pick the agent you already pay for (PRD Appendix I.3).
 *
 * Every rail is listed, including the ones that cannot be driven by an API —
 * hiding those would hide the two most popular agents. The UX grade is on the
 * card so the choice is informed: fewer stars, less for you to do.
 */

import { RAILS } from '@forge/shared';
import type { Rail } from '@forge/shared';

import { RAIL_INFO } from '../lib/rails';

export function RailPicker({
  onPick,
  busyRail,
  disabled = false,
}: {
  onPick: (rail: Rail) => void;
  busyRail: Rail | null;
  disabled?: boolean;
}) {
  return (
    <ul className="rail-list">
      {RAILS.map((rail) => {
        const info = RAIL_INFO[rail];
        const busy = busyRail === rail;
        return (
          <li key={rail}>
            <button
              type="button"
              className="rail"
              disabled={disabled || busyRail !== null}
              onClick={() => {
                onPick(rail);
              }}
            >
              <span className="rail-head">
                <span className="rail-name">{info.label}</span>
                <span className="rail-stars" aria-hidden="true">
                  {'★'.repeat(info.stars)}
                </span>
              </span>
              <span className="rail-grade">{busy ? 'Handing it over…' : info.grade}</span>
              <span className="rail-note">{info.note}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
