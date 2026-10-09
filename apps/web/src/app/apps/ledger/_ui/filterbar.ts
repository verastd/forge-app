/** Glue between the URL-backed filter draft and the Embers FilterBar / NumberField contracts. */
import type { FilterBarState } from '@forge/ui';

import { parseNumberDraft } from '../_lib/filters';

/** clean | dirty | applying | applied, as the FilterBar spec names them. */
export function filterBarState(dirty: boolean, applying: boolean, appliedCount: number): FilterBarState {
  if (applying) return 'applying';
  if (dirty) return 'dirty';
  return appliedCount > 0 ? 'applied' : 'clean';
}

/** A draft string as NumberField's `value` (null = no bound). */
export function draftNumber(draft: string): number | null {
  const n = parseNumberDraft(draft);
  return n === null || Number.isNaN(n) ? null : n;
}

/** NumberField's committed value back to a draft string. */
export function numberDraft(v: number | null): string {
  return v === null ? '' : String(v);
}
