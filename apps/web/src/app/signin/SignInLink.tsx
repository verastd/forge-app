'use client';

/**
 * A sign-in button: a plain link (never a prefetch, which must never start a
 * sign-in) that, once pressed, says it is on its way ("Opening Google…") with
 * a spinner and won't start a second attempt, until the provider's page takes
 * over. Coming back to this page with Back (the browser's page cache) shows it
 * ready again.
 */
import { useEffect, useState } from 'react';

export function SignInLink({ href, label, pending }: { href: string; label: string; pending: string }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const ready = (event: PageTransitionEvent): void => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener('pageshow', ready);
    return () => window.removeEventListener('pageshow', ready);
  }, []);
  return (
    <a
      className="btn btn-primary btn-lg"
      href={href}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      data-pending={busy ? 'on' : undefined}
      onClick={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        setBusy(true);
      }}
    >
      {busy && <span className="spinner" aria-hidden="true" />}
      {busy ? pending : label}
    </a>
  );
}
