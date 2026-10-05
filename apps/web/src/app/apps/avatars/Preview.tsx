'use client';

/**
 * The editor's live robot: robot/preview.ts on a canvas, with its own
 * loading, error and "still loading the head or image" states drawn over it.
 * Loaded on the client only (three.js), by AvatarEditor.
 *
 * Each mount (and each "Try again") makes a canvas of its own and throws it
 * away after, as LobbyScene does: a canvas whose WebGL context was released
 * never gets another, and React's development double mount would otherwise
 * hand the second preview a dead one.
 */

import { useEffect, useRef, useState } from 'react';

import { createRobotPreview } from '../../../components/lobby/scene/robot/preview';
import type { PreviewState, RobotPreview } from '../../../components/lobby/scene/robot/preview';
import type { RobotLook } from '../../../components/lobby/scene/robot/view';
import styles from './avatars.module.css';

export interface PreviewProps {
  look: RobotLook;
  /** A chest image upload is on its way: the plate shows its loading scan. */
  chestUploading: boolean;
}

const label = (name: string): string => `Preview of @${name}'s robot. Drag to turn it.`;

export default function Preview({ look, chestUploading }: PreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<RobotPreview | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<PreviewState>('loading');
  const [everReady, setEverReady] = useState(false);
  const [flying, setFlying] = useState(false);
  const [generation, setGeneration] = useState(0);
  const latest = useRef({ look, chestUploading, flying });
  latest.current = { look, chestUploading, flying };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    setState('loading');
    setEverReady(false);
    const canvas = document.createElement('canvas');
    canvas.className = styles.canvas ?? '';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label(latest.current.look.name));
    host.prepend(canvas);
    canvasRef.current = canvas;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let preview: RobotPreview;
    try {
      preview = createRobotPreview(
        canvas,
        (next) => {
          setState(next);
          if (next === 'ready') setEverReady(true);
        },
        reduced,
      );
    } catch {
      canvas.remove();
      setState('error');
      return undefined;
    }
    previewRef.current = preview;
    preview.setLook(latest.current.look);
    preview.holdChest(latest.current.chestUploading);
    preview.setFlying(latest.current.flying);
    return () => {
      preview.dispose();
      canvas.remove();
      previewRef.current = null;
      canvasRef.current = null;
    };
  }, [generation]);

  useEffect(() => {
    previewRef.current?.setLook(look);
    canvasRef.current?.setAttribute('aria-label', label(look.name));
  }, [look]);

  useEffect(() => {
    previewRef.current?.holdChest(chestUploading);
  }, [chestUploading]);

  useEffect(() => {
    previewRef.current?.setFlying(flying);
  }, [flying]);

  const firstLoad = state === 'loading' && !everReady;

  return (
    <div
      ref={hostRef}
      className={styles.stage}
      aria-busy={state === 'loading'}
      data-preview={state}
    >
      {firstLoad && (
        <div className={styles.stageOverlay} role="status">
          <span className="loading-line">
            <span className="spinner spinner-lg" aria-hidden="true" />
            Loading the robot…
          </span>
        </div>
      )}
      {state === 'error' && (
        <div className={styles.stageOverlay} role="alert">
          <p>The robot couldn’t load.</p>
          <button type="button" className="btn btn-sm" onClick={() => setGeneration((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {state === 'loading' && everReady && (
        <span className={styles.stageChip} role="status">
          <span className="spinner" aria-hidden="true" />
          {chestUploading ? 'Uploading the chestplate…' : 'Loading the head and chestplate…'}
        </span>
      )}
      <div className={styles.stageControls}>
        <button
          type="button"
          className={`btn btn-sm ${flying ? 'btn-primary' : 'btn-ghost'}`}
          aria-pressed={flying}
          onClick={() => setFlying((value) => !value)}
          disabled={state === 'error'}
        >
          {flying ? 'Flying' : 'Hovering'}
        </button>
      </div>
    </div>
  );
}
