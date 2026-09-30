import { describe, expect, expectTypeOf, it } from 'vitest';

import * as lobby from './index.js';
import type { AppEntry, AppMedia, CameraState, ChromeMode, SlotPose, SlotRef, WallSpec } from './index.js';
import * as presence from './presence.js';

// The free-roam lobby's API, which the scene and the shell (apps/web) code
// against. The runtime names are pinned here, and the signatures below are
// pinned by `tsc` (typecheck runs over this file), so neither can drift
// silently. presence.ts (the multiplayer unit's module) is re-exported whole,
// so its names are taken from the module itself rather than listed twice.
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
];

describe('@forge/lobby public API', () => {
  it('exports its own API plus everything presence.ts exports, with no name taken twice', () => {
    const fromPresence = Object.keys(presence);
    expect(fromPresence.filter((name) => OWN.includes(name))).toEqual([]);
    expect(Object.keys(lobby).sort()).toEqual([...OWN, ...fromPresence].sort());
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
  });
});
