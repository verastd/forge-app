/**
 * Copy and number formatting.
 *
 * Everything a Civilian reads is written here or in the page that uses it, in
 * one voice: no git, no PRs, no CI, no YAML. "Checks", "a maintainer", "your
 * contribution" (PRD §4.9, Appendix I).
 */

import type { BridgeStage, HistoryItem, RewardClass, Size, Tier } from '@forge/shared';

/* --- dates and numbers ----------------------------------------------------- */

/** Server timestamps are UTC; people read them in their own timezone. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Upland chain timestamps arrive without a timezone suffix but are UTC. */
export function formatChainTimestamp(ts: string): string {
  return formatTimestamp(/[Zz]$|[+-]\d\d:\d\d$/.test(ts) ? ts : `${ts}Z`);
}

const UPX_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** "15,000 UPX" — whole numbers; Upland prices don't carry meaningful cents. */
export function formatUpx(amount: number): string {
  return `${UPX_FORMAT.format(amount)} UPX`;
}

const AMOUNT_FORMAT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Signed by type: spending reads negative even though the API stores magnitude. */
export function formatAmount(item: Pick<HistoryItem, 'type' | 'amount'>): string {
  const sign = item.type === 'spend' ? '-' : item.type === 'earn' ? '+' : '';
  return `${sign}${AMOUNT_FORMAT.format(Math.abs(item.amount))}`;
}

export function amountClass(type: HistoryItem['type']): string {
  return `num amount-${type}`;
}

/** Days left, rounded up so a part-day still reads as a day. Never negative. */
export function daysUntil(iso: string, nowMs = Date.now()): number {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) {
    return 0;
  }
  return Math.max(0, Math.ceil((target - nowMs) / (24 * 60 * 60 * 1000)));
}

/** "12 days" / "1 day" / "today". */
export function formatDaysLeft(iso: string, nowMs = Date.now()): string {
  const days = daysUntil(iso, nowMs);
  if (days === 0) {
    return 'today';
  }
  return days === 1 ? '1 day' : `${days} days`;
}

/** "47h 12m 03s" — the lease countdown, ticking. */
export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) {
    return 'time is up';
  }
  const totalSeconds = Math.floor(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/* --- task vocabulary ------------------------------------------------------- */

/** Size, priced in the only currency a Civilian has: their agent's time. */
export const SIZE_LABEL: Record<Size, string> = {
  XS: '~an hour',
  S: "~an evening of your agent's time",
  M: '~a weekend',
};

export const SIZE_FILTER_LABEL: Record<Size, string> = {
  XS: 'An hour',
  S: 'An evening',
  M: 'A weekend',
};

/** "$200-equiv" — rewards are token-denominated, quoted in dollars (PRD §7.2). */
export function rewardLabel(rewardClass: RewardClass, rewardUsd?: number): string | null {
  if (rewardClass === 'none') {
    return null;
  }
  return rewardUsd === undefined ? 'reward attached' : `$${rewardUsd}-equiv`;
}

/** Tier floors, said the way a person would say them (PRD §6). */
export const TIER_FLOOR_LABEL: Record<string, string> = {
  T0: 'open to everyone',
  T1: 'once you have 2 shipped',
  T2: 'once you have 8 shipped',
  T3: 'stewards only',
};

export function tierFloorLabel(tierFloor: string): string {
  return `${tierFloor} · ${TIER_FLOOR_LABEL[tierFloor] ?? 'open to everyone'}`;
}

export const TIER_NAME: Record<Tier, string> = {
  T0: 'Newcomer',
  T1: 'Contributor',
  T2: 'Regular',
  T3: 'Steward',
};

/** The ladder in civilian voice — PRD §6, no CI or CLA vocabulary. */
export const TIER_HOW: Record<Tier, string> = {
  T0: 'Where everyone starts. Take any starter task, one at a time.',
  T1: 'Two contributions that shipped and stuck. Unlocks tasks that carry a reward.',
  T2: 'Eight shipped, at least 4 in 5 still standing, three months around. Unlocks the bigger tasks.',
  T3: 'Twenty shipped, 9 in 10 still standing, and an invitation. You help decide what gets built.',
};

/* --- bridge stages --------------------------------------------------------- */

/** The pipeline, translated. Same seven stages the server reports. */
export const STAGE_LABEL: Record<BridgeStage, string> = {
  claimed: 'Claimed',
  agent_working: 'Your agent is working',
  ready_to_submit: 'Ready to submit',
  in_checks: 'In checks',
  in_review: 'A human is reviewing',
  shipping: 'Shipping',
  shipped: 'Shipped',
};

/* --- ledger ---------------------------------------------------------------- */

/** Ledger event kinds, spelled out. Unknown kinds degrade to a tidy fallback. */
const LEDGER_KIND_LABEL: Record<string, string> = {
  claim: 'Took on a task',
  merge: 'Contribution accepted',
  reward_pending: 'Reward waiting out its survival window',
  reward_paid: 'Reward paid out',
  revert: 'Contribution was rolled back',
  strike: 'Rule broken',
  tier_up: 'Moved up a rung',
  tier_down: 'Moved down a rung',
  repro_validated: 'Bug report confirmed',
};

export function ledgerKindLabel(kind: string): string {
  return LEDGER_KIND_LABEL[kind] ?? kind.replace(/_/g, ' ');
}

export function formatPoints(points: number): string {
  if (points === 0) {
    return '—';
  }
  return points > 0 ? `+${points}` : String(points);
}

export function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
