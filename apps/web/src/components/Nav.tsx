'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Chip } from './Chip';
import { useDegraded } from '../lib/degraded';

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/history', label: 'History' },
  { href: '/upland', label: 'Upland' },
  { href: '/contribute', label: 'Contribute' },
  { href: '/contribute/profile', label: 'Profile' },
];

/** The mark: one parcel on the map, with a lot being built on it. */
function ParcelMark() {
  return (
    <svg className="wordmark-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M16 3 29 10.5 16 18 3 10.5Z" fill="#ffc23d" />
      <path d="M3 10.5 16 18v11L3 21.5Z" fill="#c98f12" />
      <path d="M29 10.5 16 18v11l13-7.5Z" fill="#8a600a" />
      <path d="M16 7.4 21.6 10.6 16 13.8 10.4 10.6Z" fill="#060a12" />
    </svg>
  );
}

export function Nav() {
  const pathname = usePathname();
  const degraded = useDegraded();

  // Profile lives under /contribute, so the Contribute tab stands down there:
  // exactly one tab is ever current.
  const isCurrent = (href: string): boolean => {
    if (href === '/contribute/profile') {
      return pathname === href;
    }
    if (href === '/contribute' && pathname === '/contribute/profile') {
      return false;
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <header className="nav">
      <div className="nav-inner">
        <Link href="/" className="wordmark" aria-label="FORGE home">
          <ParcelMark />
          <span className="wordmark-text">FORGE</span>
        </Link>
        <nav aria-label="Main">
          <ul className="nav-links">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="nav-link"
                  aria-current={isCurrent(link.href) ? 'page' : undefined}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <span className="spacer" />
        {degraded && (
          <Chip tone="warn" className="degraded-pill" title="We could not reach the FORGE service, so you are seeing a local demo copy.">
            offline demo data
          </Chip>
        )}
      </div>
    </header>
  );
}
