/**
 * The flag fallback the demo app hands to `@forge/flags/react`.
 *
 * The flag client fails closed on purpose: an unreachable flag service has to
 * read exactly like a kill switch somebody threw deliberately. That is right
 * for the live app and useless for the practice one, which is built to run with
 * nothing behind it at all. So demo builds pass an all-on fallback instead —
 * an actual answer from the service still wins, so a flag switched off in a
 * demo really is off, but silence shows the whole product rather than an empty
 * shell. Live builds pass nothing and keep the fail-closed default.
 */

import { FLAG_NAMES } from '@forge/shared';
import type { FlagConfig } from '@forge/shared';

import { isDemoMode } from './mode';

const ALL_ON = Object.fromEntries(FLAG_NAMES.map((name) => [name, true])) as FlagConfig;

export function demoFlagFallback(): FlagConfig | undefined {
  return isDemoMode() ? ALL_ON : undefined;
}
