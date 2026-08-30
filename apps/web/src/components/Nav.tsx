'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Chip } from './Chip';
import { useDegraded } from '../lib/degraded';

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/history', label: 'History' },
  { href: '/contribute', label: 'Contribute' },
  { href: '/contribute/profile', label: 'Profile' },
];

export function Nav() {
  const pathname = usePathname();
  const degraded = useDegraded();

  const isCurrent = (href: string): boolean =>
    href === '/contribute/profile'
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="nav">
      <div className="nav-inner">
        <Link href="/" className="wordmark">
          FORGE
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
