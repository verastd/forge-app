import { describe, expect, expectTypeOf, it } from 'vitest';

import * as acoustics from './acoustics.js';
import * as attenuation from './attenuation.js';
import * as avatar from './avatar.js';
import * as avatarMotion from './avatarMotion.js';
import * as collide from './collide.js';
import * as lobby from './index.js';
import type {
  AppEntry,
  AppMedia,
  AttenuationCurve,
  AttenuationParams,
  CameraState,
  ChromeMode,
  ReverbPreset,
  ReverbPresetParams,
  ReverbStatus,
  SlotPose,
  SlotRef,
  SelfState,
  Speaking,
  Vec3,
  VoiceCandidate,
  VoiceNumbers,
  VoiceSettings,
  WallSpec,
} from './index.js';
import * as presence from './presence.js';
import * as voice from './voice.js';

// The free-roam lobby's API, which the scene and the shell (apps/web) code
// against. The runtime names are pinned here, and the signatures below are
// pinned by `tsc` (typecheck runs over this file), so neither can drift
// silently. presence.ts (the multiplayer unit's module), the voice modules
// (Fable's attenuation and acoustics, and the cave's settings) and the avatar
// modules (avatar.ts, avatarMotion.ts) are re-exported whole, so their names
// are taken from the modules themselves rather than listed twice.
const OWN = [
  // layout.ts
  'WALL',
  'isSlotIndex',
  'slotFromIndex',
  'slotIndex',
  'slotPose',
  'validateWall',
  // camera.ts
  'CAMERA_LIMITS',
  'CAMERA_SPEED',
  'INITIAL_CAMERA',
  'clampCamera',
  'facing',
  'normalizeYaw',
  // storage.ts
  'CAMERA_STORAGE_ITEM',
  'parseCameraState',
  'serializeCameraState',
  // registry.ts
  'APPS',
  'appAt',
  'appBySlug',
  'frameOrigin',
  'sandboxFor',
  'validateRegistry',
  // csp.ts
  'cspWithFrameSrc',
  'framedAppHeaderRules',
  // chrome.ts
  'chromeModeFor',
];

/** The fixed 12 × 7 wall's API, which free roam replaced. */
const RETIRED = [
  'panBy',
  'stepColumn',
  'stepRow',
  'snap',
  'nearestSlot',
  'focusOn',
  'frameFor',
  'isNearView',
  'focusedSlot',
  'playbackPlan',
  'slotAt',
  'buildCave',
  'rowHeight',
  'columnYaw',
  'yawDelta',
  'sameSlot',
  // Renamed CAMERA_STORAGE_ITEM with the re-keyed storage.
  'CAMERA_STORAGE_KEY',
  // The first voice's 2 m / 9 m / 14 m ranges, which voice v2 replaced (voice.ts).
  'near',
  'gainFor',
  'AUDIBLE_RANGE',
  'SUBSCRIBE_RANGE',
];

/** Everything the re-exported modules export, in one list. */
const REEXPORTED = [presence, attenuation, acoustics, voice, avatar, avatarMotion, collide].flatMap((module) => Object.keys(module));

describe('@forge/lobby public API', () => {
  it('exports its own API plus everything presence.ts and the voice modules export, with no name taken twice', () => {
    expect(REEXPORTED.filter((name) => OWN.includes(name))).toEqual([]);
    expect(new Set(REEXPORTED).size).toBe(REEXPORTED.length);
    expect(Object.keys(lobby).sort()).toEqual([...OWN, ...REEXPORTED].sort());
  });

  it('no longer exports the fixed-wall API', () => {
    for (const name of RETIRED) {
      expect(name in lobby).toBe(false);
    }
  });

  it('keeps its types', () => {
    expectTypeOf<WallSpec>().toEqualTypeOf<{
      readonly columns: number;
      readonly rows: number;
      readonly radius: number;
      readonly y0: number;
      readonly eye: number;
      readonly panelWidth: number;
      readonly panelHeight: number;
      readonly ringRadius: number;
    }>();
    expectTypeOf<SlotRef>().toEqualTypeOf<{ col: number; row: number }>();
    expectTypeOf<SlotPose>().toEqualTypeOf<{ position: [number, number, number]; rotationY: number }>();
    expectTypeOf<CameraState>().toEqualTypeOf<{ x: number; y: number; z: number; yaw: number; pitch: number }>();
    expectTypeOf<AppMedia>().toEqualTypeOf<
      | { kind: 'generated' }
      | { kind: 'image'; src: string }
      | { kind: 'video'; src: string; srcLow?: string; poster: string }
    >();
    expectTypeOf<AppEntry>().toEqualTypeOf<{
      slug: string;
      title: string;
      description: string;
      hosting: 'native' | 'framed';
      route: string;
      slot: SlotRef;
      media: AppMedia;
      lit: boolean;
      sandbox?: { allowPopups?: boolean; allowDownloads?: boolean };
    }>();
    expectTypeOf<ChromeMode>().toEqualTypeOf<'site' | 'lobby' | 'app'>();
    expectTypeOf<Vec3>().toEqualTypeOf<{ x: number; y: number; z: number }>();
    expectTypeOf<AttenuationCurve>().toEqualTypeOf<'linear' | 'logReverse' | 'natural'>();
    expectTypeOf<AttenuationParams>().toEqualTypeOf<{
      fullVolumeDistance: number;
      falloffDistance: number;
      curve: AttenuationCurve;
      naturalDbAtMax?: number;
    }>();
    expectTypeOf<ReverbPreset>().toEqualTypeOf<'none' | 'room' | 'cave' | 'hall'>();
    expectTypeOf<ReverbStatus>().toEqualTypeOf<'off' | 'generating' | 'loading' | 'ready' | 'failed'>();
    expectTypeOf<ReverbPresetParams>().toEqualTypeOf<{
      decay: number;
      preDelay: number;
      earlyReflections: Array<[number, number]>;
      brightnessStart: number;
      brightnessEnd: number;
      defaultWet: number;
      label: string;
    }>();
    expectTypeOf<VoiceSettings>().toEqualTypeOf<{
      fullVolumeDistance: number;
      falloffDistance: number;
      curve: AttenuationCurve;
      naturalDbAtMax: number;
      subscribeMargin: number;
      permitRange: number;
      positionHz: number;
      spatialPanning: boolean;
      reverb: ReverbPreset;
      reverbWet: number;
      distanceMuffling: boolean;
      maxVoicesCoarse: number;
      maxVoicesFine: number;
      dwellMs: number;
      retryMs: number;
      retryMaxMs: number;
      pannerTurnDegrees: number;
      pannerStepMetres: number;
      speakingOn: number;
      speakingOff: number;
      speakingHoldMs: number;
    }>();
    expectTypeOf<VoiceCandidate>().toEqualTypeOf<{ id: string; distance: number; speaking: boolean }>();
    expectTypeOf<Speaking>().toEqualTypeOf<{ speaking: boolean; quietSince: number | null }>();
    expectTypeOf<VoiceNumbers>().toEqualTypeOf<{
      fullVolumeDistance: number;
      falloffDistance: number;
      subscribeMargin: number;
      positionHz: number;
      positionStaleMs: number;
      reverbWet: number;
      naturalDbAtMax?: number;
    }>();
  });

  it('keeps its signatures', () => {
    expectTypeOf(lobby.WALL).toEqualTypeOf<WallSpec>();
    expectTypeOf(lobby.isSlotIndex).toEqualTypeOf<(value: unknown, wall?: WallSpec) => value is number>();
    expectTypeOf(lobby.slotIndex).toEqualTypeOf<(slot: SlotRef, wall?: WallSpec) => number>();
    expectTypeOf(lobby.slotFromIndex).toEqualTypeOf<(index: number, wall?: WallSpec) => SlotRef>();
    expectTypeOf(lobby.slotPose).toEqualTypeOf<(index: number, wall?: WallSpec) => SlotPose>();
    expectTypeOf(lobby.validateWall).toEqualTypeOf<(wall?: WallSpec) => void>();

    expectTypeOf(lobby.CAMERA_LIMITS).toEqualTypeOf<
      Readonly<{ radius: number; minY: number; maxY: number; minPitch: number; maxPitch: number }>
    >();
    expectTypeOf(lobby.CAMERA_SPEED).toEqualTypeOf<Readonly<{ walk: number; rise: number }>>();
    expectTypeOf(lobby.INITIAL_CAMERA).toEqualTypeOf<CameraState>();
    expectTypeOf(lobby.clampCamera).toEqualTypeOf<(s: CameraState) => CameraState>();
    expectTypeOf(lobby.normalizeYaw).toEqualTypeOf<(yaw: number) => number>();
    expectTypeOf(lobby.facing).toEqualTypeOf<(slotIndex: number) => number>();

    expectTypeOf(lobby.CAMERA_STORAGE_ITEM).toEqualTypeOf<'forge.lobby.pos.v2'>();
    expectTypeOf(lobby.parseCameraState).toEqualTypeOf<(raw: string | null) => CameraState | null>();
    expectTypeOf(lobby.serializeCameraState).toEqualTypeOf<(s: CameraState) => string>();

    expectTypeOf(lobby.APPS).toEqualTypeOf<readonly AppEntry[]>();
    expectTypeOf(lobby.validateRegistry).toEqualTypeOf<
      (apps: readonly AppEntry[], opts?: { forgeHost?: string; allowedSuffixes?: readonly string[] }) => void
    >();
    expectTypeOf(lobby.appBySlug).toEqualTypeOf<(slug: string) => AppEntry | undefined>();
    expectTypeOf(lobby.appAt).toEqualTypeOf<(slot: SlotRef, apps?: readonly AppEntry[]) => AppEntry | undefined>();
    expectTypeOf(lobby.sandboxFor).toEqualTypeOf<(app: AppEntry) => string>();
    expectTypeOf(lobby.frameOrigin).toEqualTypeOf<(app: AppEntry) => string | null>();

    expectTypeOf(lobby.cspWithFrameSrc).toEqualTypeOf<(baseCsp: string, origin: string) => string>();
    expectTypeOf(lobby.framedAppHeaderRules).toEqualTypeOf<
      (
        apps: readonly AppEntry[],
        baseCsp: string,
      ) => Array<{ source: string; headers: Array<{ key: string; value: string }> }>
    >();
    expectTypeOf(lobby.chromeModeFor).toEqualTypeOf<(pathname: string) => ChromeMode>();

    expectTypeOf(lobby.distance).toEqualTypeOf<(a: Vec3, b: Vec3) => number>();
    expectTypeOf(lobby.computeGain).toEqualTypeOf<(d: number, p: AttenuationParams) => number>();
    expectTypeOf(lobby.shouldSubscribe).toEqualTypeOf<
      (d: number | null, p: AttenuationParams, margin: number, currentlySubscribed: boolean) => boolean
    >();
    expectTypeOf(lobby.listenerSpace).toEqualTypeOf<(listener: Vec3 & { yaw: number }, peer: Vec3) => Vec3>();
    expectTypeOf(lobby.synthesizeImpulseResponse).toEqualTypeOf<
      (sampleRate: number, p: ReverbPresetParams) => [Float32Array, Float32Array]
    >();
    expectTypeOf(lobby.lowpassCutoff).toEqualTypeOf<
      (alpha: number, occlusion: number, distanceMuffling: boolean) => number
    >();
    expectTypeOf(lobby.VOICE).toEqualTypeOf<Readonly<VoiceSettings>>();
    expectTypeOf(lobby.nearness).toEqualTypeOf<(d: number) => number>();
    expectTypeOf(lobby.permitted).toEqualTypeOf<(d: number) => boolean>();
    expectTypeOf(lobby.liveVoices).toEqualTypeOf<(candidates: readonly VoiceCandidate[], cap: number) => Set<string>>();
    expectTypeOf(lobby.retryDelay).toEqualTypeOf<(failures: number) => number>();
    expectTypeOf(lobby.pannerMoved).toEqualTypeOf<(from: Vec3 | null, to: Vec3) => boolean>();
    expectTypeOf(lobby.hearSpeaking).toEqualTypeOf<(previous: Speaking, rms: number, now: number) => Speaking>();
    expectTypeOf(lobby.voiceConfigProblem).toEqualTypeOf<(config: VoiceNumbers) => string | null>();
    expectTypeOf(lobby.plausibleStep).toEqualTypeOf<
      (from: SelfState | null, fromAt: number, to: SelfState, at: number) => boolean
    >();
  });
});
