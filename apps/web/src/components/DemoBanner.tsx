'use client';

/**
 * The demo app says so, on every screen that can show made-up data.
 *
 * Loud and permanent by design: in demo mode a claim that never reached the
 * service is still drawn as a claim, and the one thing that must never happen
 * is somebody believing it. Renders nothing at all in the live app.
 *
 * Deliberately not part of the root layout: it belongs to the screens that
 * fetch, and keeping it out of the shared layout keeps the landing page
 * identical in both builds.
 */

import { isDemoMode } from '../lib/mode';

export function DemoBanner() {
  if (!isDemoMode()) {
    return null;
  }
  return (
    <p className="demo-banner">
      Demo mode — this is practice data. Nothing here is real or saved.
    </p>
  );
}
