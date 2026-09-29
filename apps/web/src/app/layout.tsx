import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { SessionProvider } from '../components/SessionProvider';
import { SiteChrome } from '../components/SiteChrome';
import { ToastProvider } from '../components/Toast';
import { getPublicSession, signInAvailability } from '../lib/session';
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
/*
 * Runs before the first paint, which is the whole point: `<html>` ships with
 * data-splash="on", and anyone who is not getting an intro gets it flipped to
 * "off" here, so they never see a frame of one. Three ways to be ruled out:
 * you already watched it this session, you asked your system for less motion,
 * or you landed somewhere other than the home page — the intro dissolves into
 * the home hero, and there is nothing to dissolve into anywhere else.
 *
 * <Splash> reads the same attribute on its first client tick. Inline and
 * blocking on purpose; deferring it would hand a returning visitor exactly the
 * flash this avoids.
 */
const SPLASH_PREFLIGHT = `(function(){var h=document.documentElement,off=false;
try{off=location.pathname.replace(/\\/+$/,'')!==''}catch(e){}
try{off=off||sessionStorage.getItem('forge:splash-seen')==='1'}catch(e){}
try{off=off||matchMedia('(prefers-reduced-motion: reduce)').matches}catch(e){}
if(off)h.dataset.splash='off'})();`;

/* Without JS nothing can dismiss the splash, so without JS there isn't one. */
const SPLASH_NOSCRIPT = `.splash{display:none}html[data-splash='on'],html[data-splash='on'] body{overflow:auto}`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [session, availability] = await Promise.all([getPublicSession(), signInAvailability()]);

  return (
    <html lang="en" data-splash="on" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONTS_HREF} />
        <script dangerouslySetInnerHTML={{ __html: SPLASH_PREFLIGHT }} />
        <noscript>
          <style dangerouslySetInnerHTML={{ __html: SPLASH_NOSCRIPT }} />
        </noscript>
      </head>
      <body>
        <SessionProvider session={session} availability={availability}>
          <ToastProvider>
            <SiteChrome>{children}</SiteChrome>
          </ToastProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
