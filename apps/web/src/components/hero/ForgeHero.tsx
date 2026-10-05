'use client';

/**
 * The home page's hero: the animated FORGE grid (forgeHero.ts) behind the
 * page's own copy, full bleed, with a film grain and a scrim that keeps the
 * copy readable on the left.
 *
 * Under the canvas there is always the brand gradient: it is what shows
 * before the first frame, when WebGL2 isn't there (or the shader fails), and
 * with no JavaScript at all, so the hero is never an empty box. The canvas
 * fades in over it once its first frame is drawn. A click on the grid itself,
 * not on the copy's links or buttons, strikes the lot under it.
 *
 * Each mount makes a canvas of its own and throws it away after: a canvas
 * whose WebGL context was released never gets another, and React's
 * development double mount would otherwise hand the second hero a dead one.
 */

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';

import { createForgeHero } from './forgeHero';
import type { ForgeHero as Engine } from './forgeHero';

type HeroState = 'loading' | 'ready' | 'unsupported';

export function ForgeHero({ children }: { children: ReactNode }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [state, setState] = useState<HeroState>('loading');

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return undefined;
    const canvas = document.createElement('canvas');
    canvas.className = 'forge-hero-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    layer.prepend(canvas);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let engine: Engine;
    try {
      engine = createForgeHero(canvas, { reducedMotion: motion.matches, onState: setState });
    } catch (error) {
      console.error('forge hero:', error);
      setState('unsupported');
      canvas.remove();
      return undefined;
    }
    engineRef.current = engine;
    const onMotion = (event: MediaQueryListEvent): void => engine.setReducedMotion(event.matches);
    motion.addEventListener('change', onMotion);
    return () => {
      motion.removeEventListener('change', onMotion);
      engine.dispose();
      engineRef.current = null;
      canvas.remove();
    };
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, textarea, select, label, [role="button"]')) return;
    engineRef.current?.strike(event.clientX, event.clientY);
  };

  return (
    <section className="hero forge-hero" data-hero={state} onPointerDown={onPointerDown}>
      <div className="forge-hero-backdrop" aria-hidden="true">
        <div className="forge-hero-fallback" />
        <div ref={layerRef} className="forge-hero-layer" />
        <svg className="forge-hero-grain" xmlns="http://www.w3.org/2000/svg">
          <filter id="forgeHeroGrain">
            <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves={2} stitchTiles="stitch" />
            <feColorMatrix values="0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 1 0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#forgeHeroGrain)" />
        </svg>
        <div className="forge-hero-scrim" />
      </div>
      <div className="hero-copy">{children}</div>
    </section>
  );
}
