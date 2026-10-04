/**
 * Copy and number formatting.
 *
 * Everything a Civilian reads is written here or in the page that uses it, in
 * one voice: no git, no PRs, no CI, no YAML. "Checks", "a maintainer", "your
 * contribution" (PRD §4.9, Appendix I).
 */

import type { BridgeStage, RewardClass, Size, Tier } from '@forge/shared';

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

/**
 * What a task costs a contributor: roughly how long their agent runs on it,
 * and, the technical part shown only on hover or focus, roughly how many
 * tokens of model use that takes, counting the context it re-reads as it
 * works. Rough guides from the task's size alone, since agents differ a lot
 * in speed and appetite. No task shows a dollar amount.
 */
export const RUN_ESTIMATE: Record<Size, { time: string; tokens: string }> = {
  XS: { time: '~15 min', tokens: '0.5M to 1M' },
  S: { time: '~1 hour', tokens: '2M to 4M' },
  M: { time: '~3 hours', tokens: '6M to 12M' },
};

/** The run-time chip's text: "Agent runs ~1 hour". */
export function runTimeLabel(size: Size): string {
  return `Agent runs ${RUN_ESTIMATE[size].time}`;
}

/** The line behind the run-time chip, for anyone who wants the technical figure. */
export function tokenEstimateLabel(size: Size): string {
  return `Roughly ${RUN_ESTIMATE[size].tokens} tokens of model use, counting the context the agent re-reads as it works. It varies a lot by agent.`;
}

export const SIZE_FILTER_LABEL: Record<Size, string> = {
  XS: 'About 15 min',
  S: 'About an hour',
  M: 'About 3 hours',
};

/** A rewarded task says so, with no amount: FORGE shows no dollar figures. */
export function rewardLabel(rewardClass: RewardClass): string | null {
  return rewardClass === 'none' ? null : 'reward attached';
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
