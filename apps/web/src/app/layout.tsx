import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { Nav } from '../components/Nav';
import { ToastProvider } from '../components/Toast';
import './globals.css';

export const metadata: Metadata = {
  title: 'FORGE — built by its community',
  description:
    'The community brings the intelligence and pays for the tokens. The repo brings the tasks and the gauntlet. The core team brings final judgment. Nobody has to trust anybody.',
};

export const viewport: Viewport = {
  themeColor: '#060a12',
  colorScheme: 'dark',
};

/*
 * Faces: Unbounded (display), Manrope (UI), JetBrains Mono (ledger numbers and
 * map labels). Loaded with a plain stylesheet link rather than next/font so
 * `next build` never needs the network; every stack in globals.css falls back
 * to system faces if the link is blocked.
 */
const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Manrope:wght@400;500;600;700;800&family=Unbounded:wght@500;600;700;800&display=swap';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONTS_HREF} />
      </head>
      <body>
        <ToastProvider>
          <Nav />
          {children}
          <footer className="footer">beta · testnet</footer>
        </ToastProvider>
      </body>
    </html>
  );
}
