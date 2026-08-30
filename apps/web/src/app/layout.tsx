import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Nav } from '../components/Nav';
import { ToastProvider } from '../components/Toast';
import './globals.css';

export const metadata: Metadata = {
  title: 'FORGE — built by its community',
  description:
    'The community brings the intelligence and pays for the tokens. The repo brings the tasks and the gauntlet. The core team brings final judgment. Nobody has to trust anybody.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
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
