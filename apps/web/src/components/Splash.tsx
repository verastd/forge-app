'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * The splash: the FORGE logo animation, played once per session and handed off
 * to the real hero without a cut.
 *
 * The clip is not decoration played over the page — it is the same lockup the
 * hero draws. It assembles the wordmark and the parcel plate, holds them still
 * from 2.4s, and while it holds the whole splash dissolves. The clip's FORGE is
 * sitting exactly on the hero's FORGE and the clip's plate exactly on the hero
 * map, so what the eye sees is one lockup that stays put while the rest of the
 * page fades up around it.
 *
 * Two things make that work.
 *
 * The clip plays as two layers, not one. The hero's wordmark and its map are
 * not in the same proportion to each other as the clip's are — the hero's map
 * is larger relative to its wordmark, and sits lower — so no single placement
 * of the frame can land both. Instead the frame is drawn twice, each copy
 * masked down to one feature and solved against that feature's own hero
 * element. Each lands exactly, at any viewport, including the narrow layout
 * where the map moves below the copy and the two are nowhere near each other.
 *
 * And the clip's own background never appears. Each layer is feathered to
 * nothing well before its edge, so what is on screen is the lockup floating on
 * the site's ordinary ground colour — no panel, no letterbox, no seam to hide.
 * That is also why the two layers being at different scales is invisible: they
 * are never on screen as one frame.
 *
 * Nothing here is a hardcoded pixel: FEATURES is the only fixed input, and it
 * describes where those two things sit inside the clip's own frame, so the
 * numbers survive a re-encode at any resolution. Everything else is measured
 * from the live hero — after webfonts land, and again on resize.
 *
 * The rest is about never trapping anybody: every failure path (autoplay
 * refused, file missing, decoder gives up, no hero to hand off to) dismisses,
 * a wall-clock ceiling dismisses if none of them fire, and click / Escape /
 * the skip button all cut it short.
 */

/** The clip's frame, and where the two features sit inside it, in its pixels. */
const FRAME = { w: 1920, h: 1080 } as const;
const FEATURES = {
  /* The wordmark's ink box — glyphs only, no leading. */
  mark: { x1: 377, y1: 494, x2: 901, y2: 588 },
  /* The parcels' bounding box — the slab's own edge is lost in its glow, but
     the lit lots threshold cleanly, and the hero anchor spans exactly the
     matching lots. */
  plate: { x1: 1038, y1: 444, x2: 1555, y2: 683 },
} as const;

/** The clip finishes assembling at 2.4s and holds; hand off just inside the hold. */
const HANDOFF_SECONDS = 2.9;

/** Length of the dissolve into the live page. Keep in step with globals.css. */
const FADE_MS = 900;

/** Hard ceiling from mount, in case no cue ever arrives. */
const CEILING_MS = 8000;

/*
 * How long to wait for a first decoded frame before giving up on the intro.
 *
 * A browser that cannot decode the clip does not necessarily say so: the spec
 * lets it sit in NETWORK_LOADING and simply never fire `error`, which is what a
 * Chrome build without the media pipeline actually does. Waiting out CEILING_MS
 * on a blank page is a much worse outcome than skipping the intro, so a layer
 * that has not reached HAVE_CURRENT_DATA by now is treated as a failure.
 */
const DECODE_GRACE_MS = 2500;

const SEEN_KEY = 'forge:splash-seen';

type Phase = 'playing' | 'leaving' | 'gone';
type Feature = (typeof FEATURES)[keyof typeof FEATURES];
type Box = { left: number; top: number; width: number; height: number };

/**
 * The box to give a layer so that `feature` lands on `target`.
 *
 * `uniform` keeps the aspect: type may not be stretched, so the wordmark layer
 * takes its scale from width alone. The plate is a soft, glowing 3D object and
 * the hero's is a slightly different shape, so it gets each axis solved
 * independently — a few percent of stretch there is invisible and buys exact
 * registration.
 */
function fitLayer(feature: Feature, target: Box, uniform: boolean): Box {
  const width = target.width / ((feature.x2 - feature.x1) / FRAME.w);
  const height = uniform
    ? (width * FRAME.h) / FRAME.w
    : target.height / ((feature.y2 - feature.y1) / FRAME.h);
  return {
    width,
    height,
    left: target.left + target.width / 2 - (((feature.x1 + feature.x2) / 2) / FRAME.w) * width,
    top: target.top + target.height / 2 - (((feature.y1 + feature.y2) / 2) / FRAME.h) * height,
  };
}

/**
 * The wordmark's ink box on screen.
 *
 * The anchor is an inline span, so its own rect is the font's full content area
 * — ascent to descent, plus side bearings — which for all-caps text is a good
 * deal taller and a little wider than the letters actually drawn. The clip was
 * measured off lit pixels, so match ink to ink: canvas text metrics give the
 * real thing.
 */
function inkBox(el: HTMLElement): Box {
  const rect = el.getBoundingClientRect();
  const text = el.textContent ?? '';
  const context = document.createElement('canvas').getContext('2d');
  if (context === null || text === '') {
    return rect;
  }
  const style = getComputedStyle(el);
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if ('letterSpacing' in context) {
    context.letterSpacing = style.letterSpacing;
  }
  const metrics = context.measureText(text);
  const { actualBoundingBoxLeft, actualBoundingBoxRight } = metrics;
  if (!Number.isFinite(actualBoundingBoxRight) || !Number.isFinite(metrics.fontBoundingBoxAscent)) {
    return rect;
  }
  const baseline = rect.top + metrics.fontBoundingBoxAscent;
  const top = baseline - metrics.actualBoundingBoxAscent;
  return {
    left: rect.left - actualBoundingBoxLeft,
    top,
    width: actualBoundingBoxLeft + actualBoundingBoxRight,
    height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
  };
}

export function Splash() {
  const [phase, setPhase] = useState<Phase>('playing');
  const [layers, setLayers] = useState<{ mark: Box; plate: Box } | null>(null);
  const markRef = useRef<HTMLVideoElement>(null);
  const plateRef = useRef<HTMLVideoElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);

  // `leave` gets called from a dozen places (the cue, an error, a key, a
  // click); the phase guard makes every one after the first a no-op.
  const leave = useCallback((immediate = false) => {
    setPhase((current) => {
      if (current !== 'playing') {
        return current;
      }
      try {
        sessionStorage.setItem(SEEN_KEY, '1');
      } catch {
        // Private mode: the splash just plays again next navigation.
      }
      // Scroll unlocks as soon as the dissolve starts; `off`, which hides the
      // splash outright, waits for the unmount below.
      document.documentElement.dataset.splash = immediate ? 'off' : 'leaving';
      return immediate ? 'gone' : 'leaving';
    });
  }, []);

  // The pre-paint script in layout.tsx already ruled this session out (seen
  // before, reduced motion, or not the home page). Drop the markup on the first
  // client tick, before anything has a chance to play.
  useEffect(() => {
    if (document.documentElement.dataset.splash === 'off') {
      setPhase('gone');
    }
  }, []);

  // Measure the hero and solve both layers. Webfonts change the wordmark's
  // metrics, so wait for them; a resize changes everything, so redo it.
  useEffect(() => {
    if (phase !== 'playing') {
      return;
    }
    let live = true;

    const measure = () => {
      if (!live) {
        return;
      }
      const mark = document.querySelector<HTMLElement>('[data-splash-anchor="mark"]');
      const plate = document.querySelector<HTMLElement>('[data-splash-anchor="plate"]');
      if (mark === null || plate === null) {
        leave(true); // Nothing to hand off to: skip the intro rather than fake one.
        return;
      }
      setLayers({
        mark: fitLayer(FEATURES.mark, inkBox(mark), true),
        plate: fitLayer(FEATURES.plate, plate.getBoundingClientRect(), false),
      });
    };

    measure();
    void document.fonts?.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => {
      live = false;
      window.removeEventListener('resize', measure);
    };
  }, [phase, leave]);

  useEffect(() => {
    if (phase !== 'playing') {
      return;
    }
    skipRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
        leave();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const ceiling = window.setTimeout(() => leave(true), CEILING_MS);
    const grace = window.setTimeout(() => {
      const stalled = [markRef.current, plateRef.current].some(
        (video) => video !== null && video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA,
      );
      if (stalled) {
        leave(true);
      }
    }, DECODE_GRACE_MS);

    // Autoplay is a request, not a guarantee. If it is refused there is nothing
    // to watch, so get out of the way rather than sit on a poster frame.
    void markRef.current?.play().catch(() => leave(true));
    void plateRef.current?.play().catch(() => leave(true));

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(ceiling);
      window.clearTimeout(grace);
    };
  }, [phase, leave]);

  useEffect(() => {
    if (phase !== 'leaving') {
      return;
    }
    const timer = window.setTimeout(() => {
      document.documentElement.dataset.splash = 'off';
      setPhase('gone');
    }, FADE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === 'gone') {
    return null;
  }

  // One <video> per feature, same file — the second is a cache hit. They are
  // spatially disjoint and both are frozen on the hold by the time the handoff
  // happens, so they do not need to be frame-locked to each other.
  const layer = (
    which: 'mark' | 'plate',
    ref: React.RefObject<HTMLVideoElement | null>,
    cue: boolean,
  ) => (
    <video
      ref={ref}
      className={`splash-layer splash-layer-${which}`}
      style={layers?.[which]}
      // Hidden until solved, so a layer is never seen in the wrong place.
      hidden={layers === null}
      poster="/splash/forge-splash-poster.jpg"
      preload="auto"
      autoPlay
      muted
      playsInline
      aria-hidden="true"
      tabIndex={-1}
      onTimeUpdate={
        cue
          ? (event) => {
              if (event.currentTarget.currentTime >= HANDOFF_SECONDS) {
                leave();
              }
            }
          : undefined
      }
      onEnded={cue ? () => leave() : undefined}
      onError={() => leave(true)}
    >
      <source src="/splash/forge-splash.webm" type="video/webm" />
      <source src="/splash/forge-splash.mp4" type="video/mp4" />
    </video>
  );

  return (
    <div
      className={phase === 'leaving' ? 'splash splash-leaving' : 'splash'}
      role="dialog"
      aria-modal="true"
      aria-label="FORGE intro"
      onClick={() => leave()}
    >
      {layer('mark', markRef, true)}
      {layer('plate', plateRef, false)}

      <button ref={skipRef} type="button" className="splash-skip" onClick={() => leave()}>
        Skip intro
      </button>
    </div>
  );
}
