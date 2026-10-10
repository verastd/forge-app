'use client';

/**
 * Fitting a head to the robot, for the head library: a head straight from
 * the modeller (a file not uploaded yet) or one already in the library,
 * worn by a robot in a close-up preview, with the controls to fit it.
 *
 * On load it measures the model and makes a first guess (@forge/lobby's
 * `autoPlacement`): a replacing head sized to the robot's head and set on
 * the neck, its eyes where the robot's own are (or on its EyeL/EyeR, if it
 * has them); a face accessory sized to the face. Then Size, three Move and
 * three angle sliders (Tilt, Turn, Slant: the whole model, eyes and screen with it), a click on the head to place each eye (replacing heads), or a
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
import {
  HEAD_FIT,
  ROBOT_EYES,
  alignToEye,
  anglesFromNormal,
  autoPlacement,
  defaultColors,
  moveScreen,
  nudge,
  rescale,
  rotateAbout,
} from '@forge/lobby';
import type { AvatarColors, AvatarFinish, HeadPlacement, HeadScreen, Point3, ScreenAtScale, WornFace } from '@forge/lobby';
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
  /**
   * Whose robot it is fitted on: their colours, and the replacing head they
   * wear, which a face accessory is fitted over (and lined up with its eyes).
   */
  wearer?: { colors: AvatarColors; head: AvatarHead | null; finish?: AvatarFinish | null } | null;
}

type Reading = { kind: 'reading' } | { kind: 'ready'; measure: HeadMeasure } | { kind: 'error'; message: string };
type Picking = null | 'left' | 'right' | 'hole' | 'ramp';

const FITTING_LOOK_ID = 'gh:0';
const MOVE_RANGE = 0.3;
const AXES = [
  { index: 0, label: 'Left · Right', less: 'left', more: 'right' },
  { index: 1, label: 'Down · Up', less: 'down', more: 'up' },
  { index: 2, label: 'Back · Forward', less: 'back', more: 'forward' },
] as const;

/** The eye angles a slider sets, mirrored for both eyes ([slant, turn, pitch] index). */
const EYE_ANGLES = [
  { index: 0, label: 'Eye slant', less: 'tops out', more: 'tops in' },
  { index: 1, label: 'Eye turn', less: 'out', more: 'in' },
] as const;
const EYE_ANGLE_RANGE = 60;

/**
 * The whole model's angles a slider sets ([tilt, turn, slant] index), as seen from the front
 * (the camera's side): `sign` flips one whose positive way reads backwards from there.
 */
const MODEL_ANGLES = [
  { index: 0, label: 'Tilt', less: 'back', more: 'forward', sign: 1 },
  { index: 1, label: 'Turn', less: 'to your left', more: 'to your right', sign: 1 },
  { index: 2, label: 'Slant', less: 'top to your left', more: 'top to your right', sign: -1 },
] as const;
/** Degrees either way: inside the schema's AVATAR_PLACEMENT_ANGLE (0.8 rad, about 45.8°). */
const MODEL_ANGLE_RANGE = 45;

let localKeys = 0;

/** The shared schema's shape (eyes absent when the file's own are used; angles only when set). */
function toWire(placement: HeadPlacement): AvatarHeadPlacement {
  return {
    scale: placement.scale,
    offset: placement.offset,
    ...(placement.eyes ? { eyes: placement.eyes } : {}),
    ...(placement.eyeAngles ? { eyeAngles: placement.eyeAngles } : {}),
    ...(placement.angles?.some((a) => a !== 0) ? { angles: placement.angles } : {}),
    ...(placement.eyeScale && placement.eyeScale !== 1 ? { eyeScale: placement.eyeScale } : {}),
    ...(placement.screen ? { screen: placement.screen } : {}),
    ...(placement.flyer ? { flyer: placement.flyer } : {}),
    ...(placement.emitter ? { emitter: placement.emitter } : {}),
    ...(placement.spout ? { spout: placement.spout } : {}),
  };
}

/** A face screen for a head that found no opening of its own: robot-face sized, just behind its eyes. */
function defaultScreen(placement: HeadPlacement): HeadScreen {
  const eyes = placement.eyes ?? [ROBOT_EYES[0] as Point3, ROBOT_EYES[1] as Point3];
  const z = Math.round((Math.min(eyes[0][2], eyes[1][2]) - HEAD_FIT.eyeLift) * 10_000) / 10_000;
  return { center: [0, eyes[0][1], z], size: [0.25, 0.15] };
}

/** Moving the face screen (and the eyes on it): across from the middle, and up from the neck, in centimetres. */
const SCREEN_MOVES = [
  { axis: 0, label: 'Screen left · right', less: 'left', more: 'right', min: -15, max: 15 },
  { axis: 1, label: 'Screen down · up', less: 'down', more: 'up from the neck', min: -5, max: 45 },
] as const;

const degrees = (radians: number): number => Math.round((radians * 180) / Math.PI);

/** The face an accessory is fitted over: a replacing head's, when the wearer has one with placed eyes. */
function wornFace(fit: AvatarHeadFit, worn: AvatarHead | null): WornFace | null {
  if (fit !== 'accessory' || worn?.fit !== 'replace' || !worn.placement.eyes) return null;
  // Where its eyes really are: a head angled as a whole carries them with it.
  const [left, right] = worn.placement.eyes;
  return { eyes: [rotateAbout(worn.placement, left), rotateAbout(worn.placement, right)], screen: worn.placement.screen ?? null };
}

function firstGuess(fit: AvatarHeadFit, measure: HeadMeasure, onto: WornFace | null = null): HeadPlacement {
  const guess = autoPlacement(fit, measure.positions, measure.triangles, onto);
  // A head that brings its own EyeL/EyeR keeps them (and their angles); a face screen it found stays.
  if (fit === 'replace' && measure.hasEyes) {
    return { scale: guess.scale, offset: guess.offset, ...(guess.screen ? { screen: guess.screen } : {}) };
  }
  return guess;
}

export default function HeadFitter({ source, fit, initial, onChange, disabled, wearer = null }: HeadFitterProps) {
  // A face accessory is fitted over the replacing head its wearer has.
  const worn = fit === 'accessory' && wearer?.head?.fit === 'replace' ? wearer.head : null;
  const ontoRef = useRef<{ fit: AvatarHeadFit; worn: AvatarHead | null }>({ fit, worn });
  ontoRef.current = { fit, worn };
  const guessFor = (f: AvatarHeadFit, measure: HeadMeasure): HeadPlacement =>
    firstGuess(f, measure, wornFace(f, f === ontoRef.current.fit ? ontoRef.current.worn : null));
  const hostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<RobotPreview | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>('loading');
  const [generation, setGeneration] = useState(0);
  const [reading, setReading] = useState<Reading>({ kind: 'reading' });
  const [placement, setPlacement] = useState<HeadPlacement | null>(null);
  /**
   * The face screen's size as last set, and the head scale it was set at: Size sizes the
   * screen from this, never from a size a limit has clamped, so a drag to an extreme and
   * back leaves it as it was. Anything but Size that changes the screen sets it again.
   */
  const screenAt = useRef<ScreenAtScale | null>(null);
  const sizing = useRef(false);
  const [picking, setPicking] = useState<Picking>(null);
  // Fitted over another head (or none): a click that was aimed at the old one is dropped.
  const wornId = worn?.id ?? null;
  useEffect(() => {
    setPicking(null);
  }, [wornId]);
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
    preview.setFraming(fitRef.current === 'back' ? 'back' : 'head');
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
  // Fitting something for the back looks at the robot from behind; anything else, at its head.
  useEffect(() => {
    previewRef.current?.setFraming(fit === 'back' ? 'back' : 'head');
  }, [fit]);
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
        setPlacement(initialRef.current ?? guessFor(fitRef.current, measure));
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
    setPlacement(guessFor(fit, reading.measure));
    setBase(guessFor(fit, reading.measure));
    setPicking(null);
    setNote(null);
  }, [fit, reading]);

  // The page hears every change.
  useEffect(() => {
    onChangeRef.current(placement ? toWire(placement) : null);
  }, [placement]);

  // The robot wears it as it stands (over the wearer's head, for an accessory), in the wearer's colours.
  const wearerColors = wearer?.colors ?? null;
  const wearerFinish = wearer?.finish ?? null;
  const colorKey = wearerColors
    ? `${wearerColors.shell}${wearerColors.trim}${wearerColors.accent}${wearerColors.eye}${wearerColors.eyeRight ?? ''}${wearerFinish ?? ''}`
    : '';
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || reading.kind !== 'ready' || !placement) return;
    const fitted: AvatarHead = {
      id: 'fitting',
      name: 'Fitting',
      sha256: headKey,
      bytes: 0,
      fit,
      eyes: reading.measure.hasEyes,
      placement: toWire(placement),
      updatedAt: '',
    };
    const look: RobotLook = {
      id: FITTING_LOOK_ID,
      name: 'Fitting',
      colors: wearerColors ?? defaultColors(FITTING_LOOK_ID),
      chest: null,
      finish: wearerFinish,
      // A back model on the wearer's back, under the head they have on; a face accessory over that head.
      ...(fit === 'back'
        ? { head: wearer?.head?.fit === 'replace' ? wearer.head : null, back: fitted }
        : worn
          ? { head: worn, accessory: fitted }
          : { head: fitted }),
    };
    preview.setLook(look);
    // Colours by value: the page hands over a new object every render.
  }, [placement, fit, headKey, reading, worn, colorKey]);

  const auto = reading.kind === 'ready' ? guessFor(fit, reading.measure) : null;
  // What Size and Move measure from: where this fitting started (a library head's saved fit, or the first guess).
  const [base, setBase] = useState<HeadPlacement | null>(null);
  useEffect(() => {
    if (reading.kind !== 'ready') {
      setBase(null);
      return;
    }
    setBase(initialRef.current ?? guessFor(lastFit.current, reading.measure));
  }, [reading]);

  const placementRef = useRef(placement);
  placementRef.current = placement;
  const autoRef = useRef(auto);
  autoRef.current = auto;

  const handlePick = useCallback(
    (pick: HeadPick | null) => {
      const current = placementRef.current;
      if (!current || !picking) return;
      if (picking === 'ramp') {
        if (!pick) {
          setNote({ tone: 'warn', text: 'That missed the model. Click on the ramp bricks come out of.' });
          return;
        }
        setPlacement({ ...current, spout: pick.file });
        setNote({ tone: 'ok', text: 'Ramp marked: new bricks drop out there.' });
        setPicking(null);
        return;
      }
      if (picking === 'hole') {
        if (!pick) {
          setNote({ tone: 'warn', text: 'That missed the face. Click on the eye hole.' });
          return;
        }
        const side = pick.head[0] < 0 ? 'left' : 'right';
        const face = wornFace('accessory', ontoRef.current.worn);
        setPlacement(face ? alignToEye(current, pick.file, side, face.eyes) : alignToEye(current, pick.file, side));
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
      // Facing the surface clicked (turn and pitch); the slant stays the admin's.
      const [slant] = current.eyeAngles ?? [0, 0, 0];
      const aim = pick.normal ? anglesFromNormal(pick.normal, picking === 'left' ? 'left' : 'right') : null;
      setPlacement({
        ...current,
        eyes: picking === 'left' ? [spot, eyes[1]] : [eyes[0], spot],
        ...(aim ? { eyeAngles: [slant, aim[0], aim[1]] as [number, number, number] } : {}),
      });
      setNote({ tone: 'ok', text: `${picking === 'left' ? 'Left' : 'Right'} eye placed${aim ? ', angled to the surface' : ''}.` });
      // Left done: straight on to the right.
      setPicking(picking === 'left' ? 'right' : null);
    },
    [picking],
  );

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return undefined;
    preview.setPicking(picking ? handlePick : null, picking === 'ramp' ? 'back' : worn ? 'accessory' : 'head');
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
  const eyeSizePercent = Math.round((placement?.eyeScale ?? 1) * 100);

  const onSize = (event: ChangeEvent<HTMLInputElement>): void => {
    const percent = Number(event.target.value);
    sizing.current = true;
    setPlacement((current) => (current && base ? rescale(current, (base.scale * percent) / 100, screenAt.current ?? undefined) : current));
  };

  // The screen as set by anything but Size (auto-fit, its own sliders, switching it on, a saved fit): Size works from it.
  const screenSize = placement?.screen?.size;
  useEffect(() => {
    if (sizing.current) {
      sizing.current = false;
      return;
    }
    screenAt.current = placement?.screen ? { size: placement.screen.size, scale: placement.scale } : null;
  }, [screenSize?.[0], screenSize?.[1], placement?.screen, placement?.scale]);

  const onMove = (index: 0 | 1 | 2) => (event: ChangeEvent<HTMLInputElement>): void => {
    const wanted = Number(event.target.value);
    setPlacement((current) => {
      if (!current || !base) return current;
      const delta: Point3 = [0, 0, 0];
      delta[index] = base.offset[index] + wanted - current.offset[index];
      return nudge(current, delta);
    });
  };

  const onEyeSize = (event: ChangeEvent<HTMLInputElement>): void => {
    const size = Number(event.target.value) / 100;
    setPlacement((current) => (current ? { ...current, eyeScale: size } : current));
  };

  const onScreen = (event: ChangeEvent<HTMLInputElement>): void => {
    const on = event.target.checked;
    setPlacement((current) => {
      if (!current) return current;
      if (!on) return { ...current, screen: null };
      return { ...current, screen: auto?.screen ?? defaultScreen(current) };
    });
  };

  /** The helicopter is a choice of its own: Size, Move and Reset leave it as it is. */
  const onFlyer = (event: ChangeEvent<HTMLInputElement>): void => {
    const on = event.target.checked;
    setPlacement((current) => (current ? { ...current, flyer: on ? 'helicopter' : null } : current));
  };

  /** Making bricks is a back model's choice of its own, like the helicopter. */
  const onEmitter = (event: ChangeEvent<HTMLInputElement>): void => {
    const on = event.target.checked;
    setPlacement((current) => (current ? { ...current, emitter: on ? 'bricks' : null } : current));
  };

  const onScreenSize = (index: 0 | 1) => (event: ChangeEvent<HTMLInputElement>): void => {
    const metres = Number(event.target.value) / 100;
    setPlacement((current) => {
      if (!current?.screen) return current;
      const size: [number, number] = [...current.screen.size];
      size[index] = metres;
      return { ...current, screen: { ...current.screen, size } };
    });
  };

  /** Screen left/right and up/down: its centre, in centimetres, the glowing eyes going with it. */
  const onScreenMove = (axis: 0 | 1) => (event: ChangeEvent<HTMLInputElement>): void => {
    const metres = Number(event.target.value) / 100;
    setPlacement((current) => (current ? moveScreen(current, axis, metres) : current));
  };

  const onEyeAngle = (index: 0 | 1) => (event: ChangeEvent<HTMLInputElement>): void => {
    const radians = (Number(event.target.value) * Math.PI) / 180;
    setPlacement((current) => {
      if (!current) return current;
      const angles: [number, number, number] = [...(current.eyeAngles ?? [0, 0, 0])];
      angles[index] = Math.round(radians * 10_000) / 10_000;
      return { ...current, eyeAngles: angles };
    });
  };

  const onModelAngle = (index: 0 | 1 | 2, sign: 1 | -1) => (event: ChangeEvent<HTMLInputElement>): void => {
    const radians = (sign * Number(event.target.value) * Math.PI) / 180;
    setPlacement((current) => {
      if (!current) return current;
      const angles: [number, number, number] = [...(current.angles ?? [0, 0, 0])];
      angles[index] = Math.round(radians * 10_000) / 10_000 + 0;
      return { ...current, angles };
    });
  };
  const angled = Boolean(placement?.angles?.some((a) => a !== 0));

  const pickingText: Record<Exclude<Picking, null>, string> = {
    left: 'Click the head where its left eye goes (the robot’s left, on your right).',
    right: 'Click the head where its right eye goes (on your left).',
    hole: 'Click the middle of an eye hole: it moves over the nearest eye.',
    ramp: 'Click the ramp (or chute) new bricks drop out of.',
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
        {MODEL_ANGLES.map((control) => {
          const value = ready ? control.sign * degrees((placement.angles ?? [0, 0, 0])[control.index]) + 0 : 0;
          const words = value === 0 ? 'straight' : `${Math.abs(value)}° ${value < 0 ? control.less : control.more}`;
          return (
            <label key={control.label} className={styles.label}>
              <span className={styles.sliderHead} aria-hidden="true">
                {control.label} <span className={styles.sliderValue}>{words}</span>
              </span>
              <input
                type="range"
                min={-MODEL_ANGLE_RANGE}
                max={MODEL_ANGLE_RANGE}
                step={1}
                value={Math.max(-MODEL_ANGLE_RANGE, Math.min(MODEL_ANGLE_RANGE, value))}
                onChange={onModelAngle(control.index, control.sign)}
                disabled={locked}
                aria-label={`${control.label}, ${fit === 'replace' ? 'whole head' : fit === 'back' ? 'whole model' : 'whole accessory'}`}
                aria-valuetext={words}
              />
            </label>
          );
        })}
        {angled && (
          <div className={styles.fitRow}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPlacement((current) => (current ? { ...current, angles: null } : current))} disabled={locked}>
              Straighten
            </button>
          </div>
        )}

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
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPlacement((current) => (current ? { scale: current.scale, offset: current.offset, ...(current.angles ? { angles: current.angles } : {}) } : current))} disabled={locked}>
                Use the file’s eyes
              </button>
            )}
            <label className={`${styles.label} ${styles.fitFull}`}>
              <span className={styles.sliderHead} aria-hidden="true">
                Eye size <span className={styles.sliderValue}>{eyeSizePercent}%</span>
              </span>
              <input
                type="range"
                min={50}
                max={250}
                step={1}
                value={eyeSizePercent}
                onChange={onEyeSize}
                disabled={locked}
                aria-label="Eye size, both eyes"
                aria-valuetext={`${eyeSizePercent}% of their own size`}
              />
            </label>
            <label className={`${styles.radio} ${styles.fitFull}`}>
              <input type="checkbox" checked={Boolean(placement?.screen)} onChange={onScreen} disabled={locked} />
              <span>
                Face screen (shiny black LED)
                <br />
                <span className={styles.hint}>
                  {placement?.screen
                    ? 'Closes the face and covers the model’s own eyes; the glowing eyes sit on it.'
                    : auto?.screen
                      ? 'Off: the model’s own face (and eyes) show.'
                      : 'This model has a face of its own. Switch on to put a screen over it.'}
                </span>
              </span>
            </label>
            {placement?.screen &&
              (['Screen width', 'Screen height'] as const).map((label, index) => {
                const cm = Math.round(placement.screen!.size[index]! * 100);
                return (
                  <label key={label} className={`${styles.label} ${styles.fitFull}`}>
                    <span className={styles.sliderHead} aria-hidden="true">
                      {label} <span className={styles.sliderValue}>{cm} cm</span>
                    </span>
                    <input
                      type="range"
                      min={2}
                      max={50}
                      step={1}
                      value={cm}
                      onChange={onScreenSize(index as 0 | 1)}
                      disabled={locked}
                      aria-label={label}
                      aria-valuetext={`${cm} centimetres`}
                    />
                  </label>
                );
              })}
            {placement?.screen &&
              SCREEN_MOVES.map((control) => {
                const cm = Math.round(placement.screen!.center[control.axis] * 1000) / 10;
                const words = control.axis === 0 ? (cm === 0 ? 'centred' : `${Math.abs(cm)} cm ${cm < 0 ? control.less : control.more}`) : `${cm} cm ${control.more}`;
                return (
                  <label key={control.label} className={`${styles.label} ${styles.fitFull}`}>
                    <span className={styles.sliderHead} aria-hidden="true">
                      {control.label} <span className={styles.sliderValue}>{words}</span>
                    </span>
                    <input
                      type="range"
                      min={control.min}
                      max={control.max}
                      step={0.5}
                      value={Math.max(control.min, Math.min(control.max, cm))}
                      onChange={onScreenMove(control.axis)}
                      disabled={locked}
                      aria-label={control.label}
                      aria-valuetext={`${words}, the eyes with it`}
                    />
                  </label>
                );
              })}
            {EYE_ANGLES.map((control) => {
              const value = ready ? degrees((placement.eyeAngles ?? [0, 0, 0])[control.index]) : 0;
              const words = value === 0 ? 'straight' : `${Math.abs(value)}° ${value < 0 ? control.less : control.more}`;
              return (
                <label key={control.index} className={`${styles.label} ${styles.fitFull}`}>
                  <span className={styles.sliderHead} aria-hidden="true">
                    {control.label} <span className={styles.sliderValue}>{words}</span>
                  </span>
                  <input
                    type="range"
                    min={-EYE_ANGLE_RANGE}
                    max={EYE_ANGLE_RANGE}
                    step={1}
                    value={Math.max(-EYE_ANGLE_RANGE, Math.min(EYE_ANGLE_RANGE, value))}
                    onChange={onEyeAngle(control.index)}
                    disabled={locked}
                    aria-label={`${control.label}, both eyes`}
                    aria-valuetext={words}
                  />
                </label>
              );
            })}
          </div>
        ) : fit === 'back' ? null : (
          <div className={styles.fitRow}>
            <button type="button" className={`btn btn-sm ${picking === 'hole' ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={picking === 'hole'} onClick={() => setPicking(picking === 'hole' ? null : 'hole')} disabled={locked}>
              Line up an eye hole
            </button>
          </div>
        )}

        {fit !== 'back' && (
          <label className={`${styles.radio} ${styles.fitFull}`}>
            <input type="checkbox" checked={placement?.flyer === 'helicopter'} onChange={onFlyer} disabled={locked} />
            <span>
              Helicopter over the top
              <br />
              <span className={styles.hint}>
                {placement?.flyer === 'helicopter'
                  ? 'Flies figure-8s just above the model’s top, its searchlight on whatever’s below. Everyone wearing this head gets it.'
                  : 'Off: nothing flies over this head.'}
              </span>
            </span>
          </label>
        )}

        {fit === 'back' && (
          <label className={`${styles.radio} ${styles.fitFull}`}>
            <input type="checkbox" checked={placement?.emitter === 'bricks'} onChange={onEmitter} disabled={locked} />
            <span>
              Makes bricks
              <br />
              <span className={styles.hint}>
                {placement?.emitter === 'bricks'
                  ? 'Whoever wears this on their back is the Lego bot: they make building bricks (B) and remove them (X).'
                  : 'Off: an ordinary back model.'}
              </span>
            </span>
          </label>
        )}

        {fit === 'back' && placement?.emitter === 'bricks' && (
          <div className={styles.fitRow} data-ramp={placement.spout ? 'marked' : 'guessed'}>
            <button
              type="button"
              className={`btn btn-sm ${picking === 'ramp' ? 'btn-primary' : 'btn-ghost'}`}
              aria-pressed={picking === 'ramp'}
              onClick={() => setPicking(picking === 'ramp' ? null : 'ramp')}
              disabled={locked}
            >
              {placement.spout ? 'Mark the ramp again' : 'Mark the ramp'}
            </button>
            {placement.spout && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setPlacement((current) => (current ? { ...current, spout: null } : current));
                  setNote({ tone: 'ok', text: 'Ramp cleared: bricks drop from low on the middle of its back.' });
                }}
                disabled={locked}
              >
                Clear
              </button>
            )}
            <span className={styles.hint}>
              {placement.spout
                ? 'Marked: new bricks drop out of the spot you clicked.'
                : 'Not marked: new bricks drop from low on the middle of its back.'}
            </span>
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
              if (auto) setPlacement((current) => ({ ...auto, flyer: current?.flyer ?? null, emitter: current?.emitter ?? null, spout: current?.spout ?? null }));
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
