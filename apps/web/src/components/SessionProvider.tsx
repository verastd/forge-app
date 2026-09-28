'use client';

/**
 * The signed-in visitor, for client components.
 *
 * `lib/session.ts` is server-only (it reads cookies), so this file imports
 * only its TYPES — never the module itself. The root layout awaits
 * `getPublicSession()` / `signInAvailability()` once, server-side, and hands
 * the plain result down through this provider.
 *
 * The default value is signed out and unavailable, so anything that ends up
 * rendering outside the provider (or before it mounts) fails safe rather than
 * claiming a session that was never checked.
 */

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { PublicSession, SignInAvailability } from '../lib/session';

interface SessionContextValue {
  session: PublicSession | null;
  availability: SignInAvailability;
}

const DEFAULT_VALUE: SessionContextValue = { session: null, availability: 'unavailable' };

const SessionContext = createContext<SessionContextValue>(DEFAULT_VALUE);

export function SessionProvider({
  session,
  availability,
  children,
}: {
  session: PublicSession | null;
  availability: SignInAvailability;
  children: ReactNode;
}) {
  return (
    <SessionContext.Provider value={{ session, availability }}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  return useContext(SessionContext);
}
