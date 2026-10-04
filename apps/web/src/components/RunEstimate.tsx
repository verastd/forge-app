'use client';

import { useId, useState } from 'react';
import type { Size } from '@forge/shared';

import { runTimeLabel, tokenEstimateLabel } from '../lib/format';

/**
 * The run-time chip: roughly how long a contributor's agent runs on a task.
 * The token estimate is the technical part, so it stays out of sight until
 * the chip is hovered or focused. The chip is a tab stop, so a keyboard
 * reaches it and a tap focuses it on a phone, and Escape hides the estimate
 * again (WCAG 1.4.13). On a task card it sits above the card's stretched
 * link, so hovering it shows the estimate instead of lighting up the link.
 */
export function RunEstimate({ size }: { size: Size }) {
  const tipId = useId();
  const [dismissed, setDismissed] = useState(false);
  return (
    <span
      className="chip run-estimate"
      tabIndex={0}
      aria-describedby={tipId}
      data-dismissed={dismissed ? 'true' : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setDismissed(true);
      }}
      onBlur={() => setDismissed(false)}
      onMouseLeave={() => setDismissed(false)}
    >
      {runTimeLabel(size)}
      <span role="tooltip" id={tipId} className="run-estimate-tip">
        {tokenEstimateLabel(size)}
      </span>
    </span>
  );
}
