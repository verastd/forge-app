'use client';

/**
 * Fitting a head to the robot, for the head library: a head straight from
 * the modeller (a file not uploaded yet) or one already in the library,
 * worn by a robot in a close-up preview, with the controls to fit it.
 *
 * On load it measures the model and makes a first guess (@forge/lobby's
 * `autoPlacement`): a replacing head sized to the robot's head and set on
 * the neck, its eyes where the robot's own are (or on its EyeL/EyeR, if it
 * has them); a face accessory sized to the face. Then Size and three Move
 * sliders, a click on the head to place each eye (replacing heads), or a
 * click on an eye hole to line it up with that eye (accessories), and Reset
 * to the first guess. Every change reaches the page through `onChange`,
 * which uploads or saves it; this component never talks to the API.
 *
 * Its own states: the robot loading (or failing, with Try again), the head
 * being read (or failing, with why), and what a click is for while picking
 * (Esc or Stop ends it).
 *
 * Loaded on the client only (three.js). Each mount makes a canvas of its
 * own, as Preview does.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { alignToEye, autoPlacement, defaultColors, nudge, rescale } from '@forge/lobby';
import type { HeadPlacement, Point3 } from '@forge/lobby';
import type { AvatarHead, AvatarHeadFit, AvatarHeadPlacement } from '@forge/shared';

import { createRobotPreview } from '../../../components/lobby/scene/robot/preview';
import type { HeadSource, PreviewState, RobotPreview } from '../../../components/lobby/scene/robot/preview';
import type { HeadMeasure } from '../../../components/lobby/scene/robot/assets';
import type { HeadPick, RobotLook } from '../../../components/lobby/scene/robot/view';
import styles from './avatars.module.css';

export interface HeadFitterProps {
  /** What to fit: a chosen file, or a library head. A new source starts over. */
  source: { kind: 'file'; file: File } | { kind: 'library'; head: AvatarHead };
  fit: AvatarHeadFit;
  /** The placement to start from (a library head's saved one); null: the first guess. */
  initial: AvatarHeadPlacement | null;
  /** The placement now, once the head is read (null until then, or when it can't be). */
  onChange: (placement: AvatarHeadPlacement | null) => void;
  /** While the page uploads or saves: the controls hold still. */
  disabled: boolean;
}

type Reading = { kind: 'reading' } | { kind: 'ready'; measure: HeadMeasure } | { kind: 'error'; message: string };
type Picking = null | 'left' | 'right' | 'hole';

const FITTING_LOOK_ID = 'gh:0';
const MOVE_RANGE = 0.3;
const AXES = [
  { index: 0, label: 'Left · Right', less: 'left', more: 'right' },
  { index: 1, label: 'Down · Up', less: 'down', more: 'up' },
  { index: 2, label: 'Back · Forward', less: 'back', more: 'forward' },
] as const;

let localKeys = 0;

/** The shared schema's shape (eyes absent when the file's own are used). */
function toWire(placement: HeadPlacement): AvatarHeadPlacement {
  return placement.eyes ? { scale: placement.scale, offset: placement.offset, eyes: placement.eyes } : { scale: placement.scale, offset: placement.offset };
}

function firstGuess(fit: AvatarHeadFit, measure: HeadMeasure): HeadPlacement {
  const guess = autoPlacement(fit, measure.positions);
  // A head that brings its own EyeL/EyeR keeps them.
  return fit === 'replace' && measure.hasEyes ? { scale: guess.scale, offset: guess.offset } : guess;
}

export default function HeadFitter({ source, fit, initial, onChange, disabled }: HeadFitterProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<RobotPreview | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>('loading');
  const [generation, setGeneration] = useState(0);
  const [reading, setReading] = useState<Reading>({ kind: 'reading' });
  const [placement, setPlacement] = useState<HeadPlacement | null>(null);
  const [picking, setPicking] = useState<Picking>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialRef = useRef(initial);
  initialRef.current = initial;

  // The head's key in the preview: a local one per chosen file, the sha256 for a library head.
  const headKey = useMemo(
    () => (source.kind === 'file' ? `local-${(localKeys += 1)}` : source.head.sha256),
    [source],
  );

  // A preview of its own, rebuilt by Try again.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    setPreviewState('loading');
    const canvas = document.createElement('canvas');
    canvas.className = styles.canvas ?? '';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'The head on a robot, close up. Drag to turn it.');
    host.prepend(canvas);
    let preview: RobotPreview;
    try {
      preview = createRobotPreview(canvas, setPreviewState, window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      canvas.remove();
      setPreviewState('error');
      return undefined;
    }
    preview.setFraming('head');
    previewRef.current = preview;
    return () => {
      preview.dispose();
      canvas.remove();
      previewRef.current = null;
    };
  }, [generation]);

  // When to start over: a new file, or another library head (even one sharing this file).
  const resetKey = source.kind === 'file' ? headKey : `library:${source.head.id}:${source.head.sha256}`;
  // The fit as it is now, for a head that finishes loading after it was changed.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const lastFit = useRef(fit);

  // Read and measure the head, then make the first guess (or take the saved placement).
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return undefined;
    let live = true;
    setReading({ kind: 'reading' });
    setPlacement(null);
    setPicking(null);
    setNote(null);
    onChangeRef.current(null);
    const load = async (): Promise<HeadMeasure> => {
      const from: HeadSource =
        source.kind === 'file'
          ? { kind: 'file', key: headKey, bytes: await source.file.arrayBuffer() }
          : { kind: 'library', sha256: source.head.sha256 };
      return preview.loadHead(from);
    };
    load().then(
      (measure) => {
        if (!live) return;
        if (measure.positions.length === 0) {
          setReading({ kind: 'error', message: 'That file has no shapes to wear: nothing to fit.' });
          return;
        }
        lastFit.current = fitRef.current;
        setReading({ kind: 'ready', measure });
        setPlacement(initialRef.current ?? firstGuess(fitRef.current, measure));
      },
      () => {
        if (!live) return;
        setReading({
          kind: 'error',
          message:
            source.kind === 'file'
              ? 'The preview couldn’t open that file. Check it’s a binary glTF 2.0 (.glb), exported uncompressed.'
              : 'Couldn’t load this head from the library. Check your connection and try again.',
        });
      },
    );
    return () => {
      live = false;
    };
    // `fit` is read when it lands (fitRef) and handled below after that; a new source or preview starts over.
  }, [resetKey, generation]);

  // Switching between replacing and accessory makes a new first guess for that fit.
  useEffect(() => {
    // Until the head is read there is nothing to redo: it is guessed for the fit it lands with.
    if (reading.kind !== 'ready' || lastFit.current === fit) return;
    lastFit.current = fit;
    setPlacement(firstGuess(fit, reading.measure));
    setBase(firstGuess(fit, reading.measure));
    setPicking(null);
    setNote(null);
  }, [fit, reading]);

  // The robot wears it as it stands, and the page hears every change.
  useEffect(() => {
    onChangeRef.current(placement ? toWire(placement) : null);
    const preview = previewRef.current;
    if (!preview || reading.kind !== 'ready' || !placement) return;
    const look: RobotLook = {
      id: FITTING_LOOK_ID,
      name: 'Fitting',
      colors: defaultColors(FITTING_LOOK_ID),
      chest: null,
      head: {
        id: 'fitting',
        name: 'Fitting',
        sha256: headKey,
        bytes: 0,
        fit,
        eyes: reading.measure.hasEyes,
        placement: toWire(placement),
        updatedAt: '',
      },
    };
    preview.setLook(look);
  }, [placement, fit, headKey, reading]);

  const auto = reading.kind === 'ready' ? firstGuess(fit, reading.measure) : null;
  // What Size and Move measure from: where this fitting started (a library head's saved fit, or the first guess).
  const [base, setBase] = useState<HeadPlacement | null>(null);
  useEffect(() => {
    if (reading.kind !== 'ready') {
      setBase(null);
      return;
    }
    setBase(initialRef.current ?? firstGuess(lastFit.current, reading.measure));
  }, [reading]);

  const placementRef = useRef(placement);
  placementRef.current = placement;
  const autoRef = useRef(auto);
  autoRef.current = auto;

  const handlePick = useCallback(
    (pick: HeadPick | null) => {
      const current = placementRef.current;
      if (!current || !picking) return;
      if (picking === 'hole') {
        if (!pick) {
          setNote({ tone: 'warn', text: 'That missed the face. Click on the eye hole.' });
          return;
        }
        const side = pick.head[0] < 0 ? 'left' : 'right';
        setPlacement(alignToEye(current, pick.file, side));
        setNote({ tone: 'ok', text: `Lined the hole up with the ${side} eye.` });
        setPicking(null);
        return;
      }
      if (!pick || !pick.onModel) {
        setNote({ tone: 'warn', text: 'That missed the head. Click on the model itself.' });
        return;
      }
      const spot: Point3 = [pick.head[0], pick.head[1], Math.round((pick.head[2] + 0.004) * 10_000) / 10_000];
      const eyes = current.eyes ?? autoRef.current?.eyes ?? [spot, spot];
      setPlacement({ ...current, eyes: picking === 'left' ? [spot, eyes[1]] : [eyes[0], spot] });
      setNote({ tone: 'ok', text: `${picking === 'left' ? 'Left' : 'Right'} eye placed.` });
      // Left done: straight on to the right.
      setPicking(picking === 'left' ? 'right' : null);
    },
    [picking],
  );

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return undefined;
    preview.setPicking(picking ? handlePick : null);
    if (!picking) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPicking(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking, handlePick]);

  useEffect(() => {
    if (disabled) setPicking(null);
  }, [disabled]);

  const ready = reading.kind === 'ready' && placement !== null && auto !== null && base !== null;
  const locked = !ready || disabled;
  const sizePercent = ready ? Math.round((placement.scale / base.scale) * 100) : 100;

  const onSize = (event: ChangeEvent<HTMLInputElement>): void => {
    const percent = Number(event.target.value);
    setPlacement((current) => (current && base ? rescale(current, (base.scale * percent) / 100) : current));
  };

  const onMove = (index: 0 | 1 | 2) => (event: ChangeEvent<HTMLInputElement>): void => {
    const wanted = Number(event.target.value);
    setPlacement((current) => {
      if (!current || !base) return current;
      const delta: Point3 = [0, 0, 0];
      delta[index] = base.offset[index] + wanted - current.offset[index];
      return nudge(current, delta);
    });
  };

  const pickingText: Record<Exclude<Picking, null>, string> = {
    left: 'Click the head where its left eye goes (the robot’s left, on your right).',
    right: 'Click the head where its right eye goes (on your left).',
    hole: 'Click the middle of an eye hole: it moves over the nearest eye.',
  };

  return (
    <div className={styles.fitter} data-fitter={reading.kind}>
      <div ref={hostRef} className={`${styles.stage} ${styles.fitStage}`} aria-busy={previewState === 'loading' || reading.kind === 'reading'} data-preview={previewState}>
        {previewState === 'loading' && reading.kind !== 'error' && (
          <div className={styles.stageOverlay} role="status">
            <span className="loading-line">
              <span className="spinner spinner-lg" aria-hidden="true" />
              {reading.kind === 'reading' ? 'Reading the head…' : 'Loading the robot…'}
            </span>
          </div>
        )}
        {previewState === 'error' && (
          <div className={styles.stageOverlay} role="alert">
            <p>The preview couldn’t load.</p>
            <button type="button" className="btn btn-sm" onClick={() => setGeneration((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {reading.kind === 'error' && previewState !== 'error' && (
          <div className={styles.stageOverlay} role="alert">
            <p>{reading.message}</p>
            {source.kind === 'library' && (
              <button type="button" className="btn btn-sm" onClick={() => setGeneration((n) => n + 1)}>
                Try again
              </button>
            )}
          </div>
        )}
        {picking && (
          <span className={styles.stageChip} role="status">
            <span className={styles.pickDot} aria-hidden="true" />
            {pickingText[picking]}
          </span>
        )}
      </div>

      <div className={styles.fitControls} aria-disabled={locked}>
        <label className={styles.label}>
          <span className={styles.sliderHead} aria-hidden="true">
            Size <span className={styles.sliderValue}>{sizePercent}%</span>
          </span>
          <input
            type="range"
            min={10}
            max={400}
            step={1}
            value={sizePercent}
            onChange={onSize}
            disabled={locked}
            aria-label="Size"
            aria-valuetext={`${sizePercent}% of where it started`}
          />
        </label>
        {AXES.map((axis) => {
          const value = ready ? Math.max(-MOVE_RANGE, Math.min(MOVE_RANGE, placement.offset[axis.index] - base.offset[axis.index])) : 0;
          const cm = Math.round(value * 1000) / 10;
          return (
            <label key={axis.index} className={styles.label}>
              <span className={styles.sliderHead} aria-hidden="true">
                {axis.label} <span className={styles.sliderValue}>{cm === 0 ? '0 cm' : `${Math.abs(cm)} cm ${cm < 0 ? axis.less : axis.more}`}</span>
              </span>
              <input
                type="range"
                min={-MOVE_RANGE}
                max={MOVE_RANGE}
                step={0.002}
                value={value}
                onChange={onMove(axis.index)}
                disabled={locked}
                aria-label={axis.label}
                aria-valuetext={cm === 0 ? 'where it started' : `${Math.abs(cm)} centimetres ${cm < 0 ? axis.less : axis.more}`}
              />
            </label>
          );
        })}

        {fit === 'replace' ? (
          <div className={styles.fitRow} role="group" aria-label="Eyes">
            <span className={styles.hint}>
              Eyes: {placement?.eyes ? 'placed here' : reading.kind === 'ready' && reading.measure.hasEyes ? 'the file’s EyeL/EyeR' : 'none yet'}
            </span>
            <button type="button" className={`btn btn-sm ${picking === 'left' ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={picking === 'left'} onClick={() => setPicking(picking === 'left' ? null : 'left')} disabled={locked}>
              Place left eye
            </button>
            <button type="button" className={`btn btn-sm ${picking === 'right' ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={picking === 'right'} onClick={() => setPicking(picking === 'right' ? null : 'right')} disabled={locked}>
              Place right eye
            </button>
            {reading.kind === 'ready' && reading.measure.hasEyes && placement?.eyes && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPlacement((current) => (current ? { scale: current.scale, offset: current.offset } : current))} disabled={locked}>
                Use the file’s eyes
              </button>
            )}
          </div>
        ) : (
          <div className={styles.fitRow}>
            <button type="button" className={`btn btn-sm ${picking === 'hole' ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={picking === 'hole'} onClick={() => setPicking(picking === 'hole' ? null : 'hole')} disabled={locked}>
              Line up an eye hole
            </button>
          </div>
        )}

        <div className={styles.fitRow}>
          {picking && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicking(null)}>
              Stop picking (Esc)
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              if (auto) setPlacement(auto);
              setPicking(null);
              setNote({ tone: 'ok', text: 'Back to the first guess.' });
            }}
            disabled={locked}
          >
            Reset to auto-fit
          </button>
        </div>
        {note && (
          <p className={note.tone === 'warn' ? styles.error : styles.hint} role={note.tone === 'warn' ? 'alert' : 'status'}>
            {note.text}
          </p>
        )}
      </div>
    </div>
  );
}
