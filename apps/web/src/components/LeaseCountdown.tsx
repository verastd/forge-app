'use client';

/**
 * "yours for 48h — ends Thu 18:20", ticking.
 *
 * The lease is the anti-snipe rule made visible (PRD §4 Stage 3): while it
 * runs, the task is nobody else's. When it lapses, it lapses blamelessly.
 */

import { useEffect, useState } from 'react';

import { Chip } from './Chip';
import { formatCountdown, formatTime } from '../lib/format';

export function LeaseCountdown({
  leaseEndsAt,
  leaseHours,
}: {
  leaseEndsAt: string;
  leaseHours: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const endsAt = Date.parse(leaseEndsAt);
  const remaining = Number.isNaN(endsAt) ? 0 : endsAt - now;
  const expired = remaining <= 0;

  return (
    <Chip tone={expired ? 'warn' : 'ok'}>
      {expired
        ? 'Your time on this one ran out — no hard feelings, claim it again'
        : `yours for ${leaseHours}h — ends ${formatTime(leaseEndsAt)} · ${formatCountdown(remaining)} left`}
    </Chip>
  );
}
