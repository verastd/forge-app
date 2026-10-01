'use client';

/**
 * The flags the Contribute layout already resolved, handed to the screens
 * under it, so a page doesn't fetch them a second time and doesn't render a
 * moment with every flag off before its own fetch lands. Null outside the
 * layout: callers treat a missing flag as off.
 */

import { createContext, useContext } from 'react';
import type { FlagConfig } from '@forge/shared';

export const ContributeFlagsContext = createContext<FlagConfig | null>(null);

export function useContributeFlags(): FlagConfig | null {
  return useContext(ContributeFlagsContext);
}
