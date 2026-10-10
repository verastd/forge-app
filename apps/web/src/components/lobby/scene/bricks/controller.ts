/**
 * Building with bricks in the cave: the shared build (read from the bricks
 * BFF, and kept fresh), the brick you hold, where it would go, and what to
 * tell the shell. The rules are @forge/lobby's bricks.ts; the API has the last
 * word on every write.
 *
 * - Only the Lego bot (whoever wears the brick-making backpack: the API says,
 *   `GET me`) makes bricks (B, of the shape 1–9 and colour C / Shift+C picked)
 *   and removes them (X).
 * - Anyone signed in picks up a loose brick they point at (E), turns it (R),
 *   and places it where the ghost shows (E again: green fits, red says why
 *   not), or drops it on the floor in front of them (Q). A brick something is
 *   fastened to is part of a build: only the Lego bot can take it out.
 * - Every write says it's under way (Making…, Placing…) until the API
 *   answers; a placed brick moves at once and goes back if the API says no.
 * - After a write the others hear a ping (actions.ts `bricks`) and ask for
 *   what changed since the revision they have; every 20 s everyone asks
 *   anyway, so a ping lost on the way costs no more than that.
 */

import * as THREE from 'three';
import {
  BRICK,
  BRICK_COLORS,
  BRICK_PROBLEM_TEXT,
  BRICK_SHAPES,
  BLUEPRINT_ERROR_TEXT,
  BLUEPRINT_MAX_BYTES,
  aimBrick,
  blueprintProblems,
  brickBox,
  brickFrozen,
  brickProblem,
  brickShape,
  brickUnderRay,
  floorSpot,
  nextRot,
  parseBlueprint,
  placeBlueprint,
  skippedText,
  turnBlueprint,
} from '@forge/lobby';
import type { Blueprint, BlueprintBrick, BrickAt, BrickRot, LobbyAction, Ray } from '@forge/lobby';
import type { Brick, BrickChange, BrickColorId, BrickList, BrickShapeId } from '@forge/shared';

import type { PresenceFeed } from '../../presence/types';
import { ROBOT_SCALE } from '../robot/view';
import type { RobotView } from '../robot/view';
import { BrickRefusal, createBrickClient } from './client';
import type { BrickClient } from './client';
import { brickColour, brickMatrix, brickMaterial, createBrickLayer, createGhostLayer, createLoneBrick } from './meshes';
import type { DrawnBrick } from './meshes';

/** Who you are to the bricks: what the shell knows of your session. */
export type Builder = 'member' | 'signed-out' | 'practice';

export type BrickBusy = 'making' | 'picking' | 'placing' | 'dropping' | 'removing' | 'switching' | 'reading' | 'building';

export interface BrickState {
  /** The build: loading it, shown, or failed to load (and trying again). */
  sync: 'loading' | 'ready' | 'error';
  /** Whether you can build: checking with the API, yes, or why not. */
  access: 'checking' | 'member' | 'signed-out' | 'practice' | 'unavailable';
  maker: boolean;
  /** An admin may take over the Lego bot to test it ("Be the Lego bot")… */
  canStandIn: boolean;
  /** …and has. */
  standIn: boolean;
  /** Bricks in the cave, placed and held. */
  count: number;
  /** The shape and colour the Lego bot makes next (indexes into BRICK_SHAPES and BRICK_COLORS). */
  shape: number;
  color: number;
  busy: BrickBusy | null;
  /** The shape you hold, or null. */
  held: string | null;
  /** Holding: whether it fits where it's aimed, and why not. Null when it isn't aimed anywhere. */
  aim: { fits: boolean; why: string | null } | null;
  /** Not holding: the brick you're pointing at and what you can do with it. */
  target: { label: string; can: 'pick' | 'frozen' } | null;
  /**
   * The Lego bot's blueprint, while one is out: its name, how many bricks,
   * what was left out of it, and where it's aimed (whether it all fits, how
   * many bricks don't and why; null aim: not aimed anywhere).
   */
  blueprint: { name: string; bricks: number; skipped: string | null; aim: BlueprintAim | null } | null;
}

/** Where a blueprint is aimed: whether all of it fits, and if not, how many bricks don't and the first one's why. */
export interface BlueprintAim {
  fits: boolean;
  blocked: number;
  why: string | null;
}

export type BrickCommand =
  | { kind: 'make' }
  | { kind: 'shape'; index: number }
  | { kind: 'color'; step: 1 | -1 }
  | { kind: 'paint'; index: number }
  | { kind: 'use' }
  | { kind: 'rotate' }
  | { kind: 'drop' }
  | { kind: 'remove' }
  | { kind: 'retry' }
  | { kind: 'stand-in'; on: boolean }
  /** The Lego bot reads a blueprint (an LDraw file) to build. */
  | { kind: 'blueprint'; file: File }
  /** …and puts it away. */
  | { kind: 'put-away' };

export interface BrickFrame {
  /** Your eye, for dropping in front of you and for reach. */
  eye: THREE.Vector3;
  yaw: number;
  selfRobot: RobotView | null;
  robotOf(id: string): RobotView | null;
}

export interface BrickEvents {
  onState(state: BrickState): void;
  /** Something to say: "Brick made", "Taken: someone got it first". */
  onEvent(text: string): void;
}

export interface Bricks {
  command(command: BrickCommand): void;
  setBuilder(builder: Builder): void;
  update(frame: BrickFrame): void;
  dispose(): void;
}

/** Ask for what changed this often anyway (ms). */
const REFRESH_MS = 20_000;
/** After a read that failed, sooner (ms). */
const RETRY_MS = 5_000;
/** Bricks further than this beyond your reach (m) are left out of aiming. */
const NEAR_MARGIN = 3;

interface Placed extends DrawnBrick {
  id: string;
}

const atOf = (brick: Brick): BrickAt => ({ shape: brick.shape, x: brick.x, y: brick.y, z: brick.z, rot: brick.rot as BrickRot });
const shapeLabel = (id: string): string => brickShape(id)?.label ?? 'brick';

const GHOST_FITS = new THREE.Color('#46e08a');
const GHOST_BLOCKED = new THREE.Color('#ff5d5d');

export function createBricks(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  feed: () => PresenceFeed | null,
  events: BrickEvents,
  /** The robots' environment map, which lights the bricks too (null: none yet). */
  envMap: THREE.Texture | null,
  client: BrickClient = createBrickClient(),
): Bricks {
  const bricks = new Map<string, Brick>();
  let rev: number | null = null;
  let sync: BrickState['sync'] = 'loading';
  let builder: Builder | null = null;
  let access: BrickState['access'] = 'checking';
  let memberId: string | null = null;
  let maker = false;
  let canStandIn = false;
  let standIn = false;
  let shape = 4;
  let color = 0;
  let rot: BrickRot = 0;
  let busy: BrickBusy | null = null;
  let disposed = false;

  // ---------- the build: read, and kept fresh ----------

  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading: AbortController | null = null;
  /** Something changed while a read was out: read again when it's back. */
  let again = false;
  let changed = true;

  const apply = (list: BrickList): void => {
    if (list.full) bricks.clear();
    for (const brick of list.bricks) bricks.set(brick.id, brick);
    for (const id of list.gone) bricks.delete(id);
    rev = list.rev;
    changed = true;
  };

  const read = async (): Promise<void> => {
    if (disposed) return;
    if (reading) {
      again = true;
      return;
    }
    clearTimeout(timer);
    reading = new AbortController();
    let wait = REFRESH_MS;
    try {
      apply(await client.list(rev, reading.signal));
      sync = 'ready';
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      // Keep what's shown; only a first read that failed shows as failed.
      if (sync !== 'ready') sync = 'error';
      wait = error instanceof BrickRefusal && error.code === 'lobby-disabled' ? REFRESH_MS * 3 : RETRY_MS;
    } finally {
      reading = null;
    }
    if (disposed) return;
    if (again) {
      again = false;
      void read();
      return;
    }
    timer = setTimeout(() => void read(), wait);
  };
  void read();

  const whoAmI = async (): Promise<void> => {
    try {
      const me = await client.me();
      if (disposed || builder !== 'member') return;
      memberId = me.memberId;
      maker = me.maker;
      canStandIn = me.canStandIn;
      standIn = me.standIn;
      access = 'member';
    } catch (error) {
      if (disposed || builder !== 'member') return;
      memberId = null;
      maker = false;
      canStandIn = false;
      standIn = false;
      access = error instanceof BrickRefusal && error.code === 'practice_session' ? 'practice' : 'unavailable';
    }
  };

  // ---------- hearing the others ----------

  let subscribed: PresenceFeed | null = null;
  let unsubscribe: (() => void) | null = null;
  const hear = (_from: string, action: LobbyAction): void => {
    if (action.kind === 'bricks' && (rev === null || action.rev > rev)) void read();
  };
  const ping = (change: { rev: number }): void => {
    feed()?.sendAction({ kind: 'bricks', rev: change.rev });
  };

  // ---------- what you hold, and what you point at ----------

  const mine = (): Brick | null => {
    if (memberId === null) return null;
    for (const brick of bricks.values()) if (brick.holder === memberId) return brick;
    return null;
  };

  let placed: Placed[] = [];
  let near: Placed[] = [];
  let nearFrom = new THREE.Vector3(Infinity, 0, 0);
  const rebuild = (): void => {
    placed = [];
    for (const brick of bricks.values()) if (!brick.holder) placed.push({ id: brick.id, color: brick.color, ...atOf(brick) });
    layer.set(placed);
    nearFrom.set(Infinity, 0, 0);
  };
  const nearby = (from: THREE.Vector3, reach: number): Placed[] => {
    if (from.distanceTo(nearFrom) < 0.5) return near;
    nearFrom = from.clone();
    const limit = reach + NEAR_MARGIN;
    near = placed.filter((brick) => {
      const box = brickBox(brick);
      const dx = Math.max(box.min[0] - from.x, 0, from.x - box.max[0]);
      const dy = Math.max(box.min[1] - from.y, 0, from.y - box.max[1]);
      const dz = Math.max(box.min[2] - from.z, 0, from.z - box.max[2]);
      return Math.hypot(dx, dy, dz) <= limit;
    });
    return near;
  };

  const layer = createBrickLayer(scene, envMap);
  const ghostMaterial = new THREE.MeshBasicMaterial({ color: GHOST_FITS, transparent: true, opacity: 0.42, depthWrite: false });
  let ghost: THREE.Group | null = null;
  let ghostShape = '';
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
  );
  outline.visible = false;
  outline.renderOrder = 2;
  scene.add(outline);

  /** Bricks drawn in someone's hand: brick id → its mesh. */
  const inHand = new Map<string, { group: THREE.Group; material: THREE.MeshStandardMaterial; shape: string; color: string }>();

  let aimed: BrickAt | null = null;
  let aim: BrickState['aim'] = null;
  let target: (Placed & { can: 'pick' | 'frozen' }) | null = null;
  let frame: BrickFrame | null = null;
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();

  const ray = (): { ray: Ray; reach: number } => {
    camera.getWorldPosition(origin);
    camera.getWorldDirection(direction);
    // Out on the boom, reach counts from your robot, not the camera behind it.
    const reach = BRICK.reach + (frame ? origin.distanceTo(frame.eye) : 0);
    return { ray: { origin: [origin.x, origin.y, origin.z], dir: [direction.x, direction.y, direction.z] }, reach };
  };

  // ---------- the Lego bot's blueprint ----------

  let blueprint: Blueprint | null = null;
  const ghosts = createGhostLayer(scene);
  /** Where the blueprint goes now, and which of its bricks fit there. */
  let planned: BlueprintBrick[] | null = null;
  let plannedAim: BlueprintAim | null = null;
  let planKey = '';

  const aimBlueprint = (r: Ray, reach: number): void => {
    if (!blueprint) return;
    // A blueprint always goes on the floor, its middle where the aim meets the floor (through any bricks in the way).
    const spot = aimBrick(r, 'brick-1x1', 0, [], reach);
    if (!spot) {
      if (planKey !== '') ghosts.hide();
      planKey = '';
      planned = null;
      plannedAim = null;
      return;
    }
    const [sx, sz] = blueprint.size;
    const corner = { x: spot.x - Math.floor(sx / 2), y: 0, z: spot.z - Math.floor(sz / 2) };
    const key = `${corner.x},${corner.y},${corner.z}|${blueprint.bricks.length}|${blueprint.size.join()}|${rev ?? ''}|${placed.length}`;
    if (key === planKey) return;
    planKey = key;
    planned = placeBlueprint(blueprint, corner.x, corner.y, corner.z);
    // Only the cave's bricks around it can be in its way.
    const minX = corner.x - 1;
    const maxX = corner.x + sx + 1;
    const minZ = corner.z - 1;
    const maxZ = corner.z + sz + 1;
    const around = placed.filter((brick) => {
      const box = brickBox(brick);
      return box.max[0] / BRICK.stud >= minX && box.min[0] / BRICK.stud <= maxX && box.max[2] / BRICK.stud >= minZ && box.min[2] / BRICK.stud <= maxZ;
    });
    const problems = blueprintProblems(planned, around);
    const blocked = problems.filter((problem) => problem !== null);
    const first = blocked[0];
    plannedAim = { fits: blocked.length === 0, blocked: blocked.length, why: first ? BRICK_PROBLEM_TEXT[first] : null };
    ghosts.set(planned.map((brick, i) => ({ ...brick, fits: problems[i] === null })));
  };

  const putAway = (): void => {
    blueprint = null;
    planned = null;
    plannedAim = null;
    planKey = '';
    ghosts.hide();
  };

  const look = (): void => {
    const held = mine();
    const { ray: r, reach } = ray();
    const candidates = nearby(origin, reach);
    aimed = null;
    aim = null;
    target = null;
    if (blueprint) {
      if (busy === null) aimBlueprint(r, reach);
      return;
    }
    if (held && busy === null) {
      aimed = aimBrick(r, held.shape, rot, candidates, reach);
      if (aimed) {
        const problem = brickProblem(aimed, candidates);
        aim = { fits: problem === null, why: problem === null ? null : BRICK_PROBLEM_TEXT[problem] };
      }
    } else if (!held) {
      const hit = brickUnderRay(r, candidates, reach);
      if (hit) {
        const brick = hit.brick as Placed;
        target = { ...brick, can: maker || !brickFrozen(brick, candidates) ? 'pick' : 'frozen' };
      }
    }
  };

  const drawGhost = (): void => {
    const held = mine();
    if (!held || !aimed || !aim) {
      if (ghost) ghost.visible = false;
      return;
    }
    if (!ghost || ghostShape !== held.shape) {
      if (ghost) scene.remove(ghost);
      ghost = createLoneBrick(held.shape, ghostMaterial, false);
      ghost.matrixAutoUpdate = false;
      ghost.renderOrder = 1;
      ghostShape = held.shape;
      scene.add(ghost);
    }
    ghost.visible = true;
    brickMatrix(aimed, ghost.matrix);
    ghost.matrixWorldNeedsUpdate = true;
    ghostMaterial.color.copy(aim.fits ? GHOST_FITS : GHOST_BLOCKED);
  };

  const drawOutline = (): void => {
    if (!target) {
      outline.visible = false;
      return;
    }
    const box = brickBox(target);
    outline.visible = true;
    outline.position.set((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
    outline.scale.set(box.max[0] - box.min[0] + 0.02, box.max[1] - box.min[1] + 0.02, box.max[2] - box.min[2] + 0.02);
    (outline.material as THREE.LineBasicMaterial).color.set(target.can === 'pick' ? 0xffffff : 0xffb340);
  };

  /** Each held brick in its holder's hand: their robot's palm, or low in your own view in first person. */
  const drawHeld = (f: BrickFrame): void => {
    const wanted = new Set<string>();
    for (const brick of bricks.values()) {
      if (!brick.holder) continue;
      const self = brick.holder === memberId;
      const robot = self ? f.selfRobot : f.robotOf(brick.holder);
      const parent: THREE.Object3D | null = robot ? robot.hand : self ? camera : null;
      if (!parent) continue;
      wanted.add(brick.id);
      let entry = inHand.get(brick.id);
      if (entry && (entry.shape !== brick.shape || entry.color !== brick.color)) {
        entry.group.removeFromParent();
        entry.material.dispose();
        entry = undefined;
      }
      if (!entry) {
        const material = brickMaterial(envMap);
        material.color.copy(brickColour(brick.color));
        entry = { group: createLoneBrick(brick.shape, material, true), material, shape: brick.shape, color: brick.color };
        inHand.set(brick.id, entry);
      }
      if (entry.group.parent !== parent) {
        parent.add(entry.group);
        if (robot) {
          entry.group.position.set(0, 0.02, 0.16);
          entry.group.rotation.set(0, 0, 0);
          entry.group.scale.setScalar(1 / ROBOT_SCALE);
        } else {
          entry.group.position.set(0.5, -0.42, -1.1);
          entry.group.rotation.set(0.35, 0.6, 0);
          entry.group.scale.setScalar(0.32);
        }
      }
    }
    for (const [id, entry] of inHand) {
      if (wanted.has(id)) continue;
      entry.group.removeFromParent();
      entry.material.dispose();
      inHand.delete(id);
    }
  };

  // ---------- writes ----------

  const canBuild = (): boolean => {
    if (access === 'member') return true;
    const why: Record<Exclude<BrickState['access'], 'member'>, string> = {
      checking: 'Just a moment: checking who you are…',
      'signed-out': 'Sign in with GitHub to build.',
      practice: 'The practice account can’t build: sign in with GitHub.',
      unavailable: 'Building isn’t available right now.',
    };
    events.onEvent(why[access]);
    return false;
  };
  const makerOnly = (): boolean => {
    if (!canBuild()) return false;
    if (maker) return true;
    events.onEvent('Only the Lego bot makes and removes bricks.');
    return false;
  };
  const ready = (): boolean => {
    if (busy !== null) return false;
    if (sync !== 'ready') {
      events.onEvent(sync === 'loading' ? 'The bricks are still loading…' : 'Couldn’t load the bricks: trying again…');
      return false;
    }
    return true;
  };

  /** Runs a write: busy while it's out, then the answer (or the refusal, in words). */
  const write = async (
    kind: BrickBusy,
    run: () => Promise<BrickChange>,
    done: (change: BrickChange) => string | null,
    undo?: () => void,
  ): Promise<void> => {
    busy = kind;
    try {
      const change = await run();
      if (disposed) return;
      busy = null;
      if (change.brick) bricks.set(change.brick.id, change.brick);
      changed = true;
      const text = done(change);
      if (text) events.onEvent(text);
      ping(change);
      // Catch up on anything else that changed meanwhile.
      void read();
    } catch (error) {
      if (disposed) return;
      busy = null;
      undo?.();
      changed = true;
      events.onEvent(error instanceof BrickRefusal ? error.message : 'Couldn’t save that: try again.');
      if (error instanceof BrickRefusal && error.status !== 0) void read();
    }
  };

  const placeAt = (held: Brick, at: BrickAt, kind: 'placing' | 'dropping'): void => {
    const before = { ...held };
    // It goes there at once; back in your hand if the API says no.
    const moved: Brick = { ...held, x: at.x, y: at.y, z: at.z, rot: at.rot };
    delete moved.holder;
    bricks.set(held.id, moved);
    changed = true;
    void write(
      kind,
      () => client.place(held.id, { x: at.x, y: at.y, z: at.z, rot: at.rot }),
      () => (kind === 'placing' ? 'Placed' : 'Dropped on the floor'),
      () => bricks.set(held.id, before),
    );
  };

  const run = (command: BrickCommand): void => {
    switch (command.kind) {
      case 'stand-in': {
        if (!canBuild() || busy !== null) return;
        if (!canStandIn) {
          events.onEvent('Only admins can take over the Lego bot.');
          return;
        }
        busy = 'switching';
        changed = true;
        client
          .standIn(command.on)
          .then((me) => {
            if (disposed) return;
            maker = me.maker;
            canStandIn = me.canStandIn;
            standIn = me.standIn;
            events.onEvent(me.standIn ? 'You’re the Lego bot now (testing): B makes a brick' : 'Back to yourself');
          })
          .catch((error: unknown) => {
            if (disposed) return;
            events.onEvent(error instanceof BrickRefusal ? error.message : 'Couldn’t switch: try again.');
          })
          .finally(() => {
            busy = null;
            changed = true;
          });
        return;
      }
      case 'retry':
        if (sync === 'error') {
          sync = 'loading';
          changed = true;
          void read();
        }
        return;
      case 'shape': {
        if (!makerOnly()) return;
        const index = Math.max(0, Math.min(BRICK_SHAPES.length - 1, command.index));
        shape = index;
        changed = true;
        events.onEvent(`${BRICK_SHAPES[index]!.label} · B to make one`);
        return;
      }
      case 'color': {
        if (!makerOnly()) return;
        color = (color + command.step + BRICK_COLORS.length) % BRICK_COLORS.length;
        changed = true;
        events.onEvent(`${BRICK_COLORS[color]!.label} · B to make one`);
        return;
      }
      case 'paint': {
        if (!makerOnly()) return;
        color = Math.max(0, Math.min(BRICK_COLORS.length - 1, command.index));
        changed = true;
        return;
      }
      case 'blueprint': {
        if (!makerOnly() || !ready()) return;
        if (mine()) {
          events.onEvent('Your hands are full: place or drop that brick first.');
          return;
        }
        if (command.file.size > BLUEPRINT_MAX_BYTES) {
          events.onEvent(BLUEPRINT_ERROR_TEXT['too-big']);
          return;
        }
        busy = 'reading';
        changed = true;
        command.file
          .text()
          .then((text) => {
            if (disposed) return;
            const result = parseBlueprint(text, command.file.name);
            if (typeof result === 'string') {
              events.onEvent(BLUEPRINT_ERROR_TEXT[result]);
              return;
            }
            putAway();
            blueprint = result;
            const skipped = skippedText(result);
            events.onEvent(
              `${result.name}: ${result.bricks.length.toLocaleString('en')} bricks · E builds it where the ghost is, R turns it, Q puts it away${skipped ? ` (${skipped})` : ''}`,
            );
          })
          .catch(() => {
            if (!disposed) events.onEvent('Couldn’t read that file: try again.');
          })
          .finally(() => {
            if (busy === 'reading') busy = null;
            changed = true;
          });
        return;
      }
      case 'put-away': {
        if (!blueprint || busy !== null) return;
        putAway();
        changed = true;
        events.onEvent('Blueprint put away');
        return;
      }
      case 'make': {
        if (!makerOnly() || !ready()) return;
        if (blueprint) {
          events.onEvent('Put the blueprint away first (Q), or build it (E).');
          return;
        }
        if (mine()) {
          events.onEvent('Your hands are full: place or drop that brick first.');
          return;
        }
        const made = BRICK_SHAPES[shape]!;
        rot = 0;
        void write(
          'making',
          () => client.make({ shape: made.id as BrickShapeId, color: BRICK_COLORS[color]!.id as BrickColorId }),
          () => `${BRICK_COLORS[color]!.label} ${made.label} made · E to place, Q to drop`,
        );
        return;
      }
      case 'rotate': {
        if (blueprint && busy === null) {
          blueprint = turnBlueprint(blueprint);
          planKey = '';
          return;
        }
        if (!mine()) {
          events.onEvent('Pick up a brick to turn it.');
          return;
        }
        rot = nextRot(rot);
        changed = true;
        return;
      }
      case 'use': {
        if (!canBuild() || !ready()) return;
        if (blueprint) {
          if (!makerOnly()) return;
          if (!planned || !plannedAim) {
            events.onEvent('Aim at the floor to place the blueprint.');
            return;
          }
          if (!plannedAim.fits) {
            events.onEvent(`${plannedAim.blocked} brick${plannedAim.blocked === 1 ? '' : 's'} won’t fit: ${plannedAim.why ?? ''}`);
            return;
          }
          const { name } = blueprint;
          const pieces = planned.map(({ shape: s, color: c, x, y, z, rot: r }) => ({ shape: s as BrickShapeId, color: c as BrickColorId, x, y, z, rot: r }));
          busy = 'building';
          changed = true;
          client
            .build({ name, bricks: pieces })
            .then((built) => {
              if (disposed) return;
              events.onEvent(`Built ${name}: ${built.built.toLocaleString('en')} bricks`);
              ping(built);
              planKey = '';
              void read();
            })
            .catch((error: unknown) => {
              if (!disposed) events.onEvent(error instanceof BrickRefusal ? error.message : 'Couldn’t build it: try again.');
            })
            .finally(() => {
              busy = null;
              changed = true;
            });
          return;
        }
        const held = mine();
        if (held) {
          if (!aimed || !aim) {
            events.onEvent('Aim at the floor or a brick to place it (or Q to drop it).');
            return;
          }
          if (!aim.fits) {
            events.onEvent(aim.why ?? 'It doesn’t fit there.');
            return;
          }
          placeAt(held, aimed, 'placing');
          return;
        }
        if (!target) {
          events.onEvent('Point at a brick to pick it up.');
          return;
        }
        if (target.can === 'frozen') {
          events.onEvent('Part of a build: only the Lego bot can take it out.');
          return;
        }
        const picked = target;
        rot = picked.rot;
        void write(
          'picking',
          () => client.pick(picked.id),
          () => `Picked up a ${shapeLabel(picked.shape)} · E to place, R to turn`,
        );
        return;
      }
      case 'drop': {
        if (blueprint) {
          run({ kind: 'put-away' });
          return;
        }
        const held = mine();
        if (!held) {
          events.onEvent('You’re not holding a brick.');
          return;
        }
        if (!canBuild() || !ready() || !frame) return;
        // A metre ahead of you (the camera looks down −Z turned by −yaw).
        const ahead = { x: frame.eye.x + Math.sin(frame.yaw), z: frame.eye.z - Math.cos(frame.yaw) };
        const spot = floorSpot(held.shape, rot, ahead.x, ahead.z, placed);
        if (!spot) {
          events.onEvent('No room on the floor here: find a clearer spot.');
          return;
        }
        placeAt(held, spot, 'dropping');
        return;
      }
      case 'remove': {
        if (!makerOnly() || !ready()) return;
        const victim = mine() ?? (target ? bricks.get(target.id) ?? null : null);
        if (!victim) {
          events.onEvent('Point at a brick to remove it.');
          return;
        }
        const before = { ...victim };
        bricks.delete(victim.id);
        changed = true;
        void write(
          'removing',
          () => client.remove(victim.id),
          () => `Removed a ${shapeLabel(victim.shape)}`,
          () => bricks.set(victim.id, before),
        );
        return;
      }
    }
  };

  // ---------- the shell's view ----------

  let shown = '';
  const state = (): BrickState => {
    const held = mine();
    return {
      sync,
      access,
      maker,
      canStandIn,
      standIn,
      count: bricks.size,
      shape,
      color,
      busy,
      held: held ? held.shape : null,
      aim: held ? aim : null,
      target: held || !target ? null : { label: shapeLabel(target.shape), can: target.can },
      blueprint: blueprint
        ? { name: blueprint.name, bricks: blueprint.bricks.length, skipped: skippedText(blueprint), aim: plannedAim }
        : null,
    };
  };

  return {
    command: run,

    setBuilder(next) {
      if (next === builder) return;
      builder = next;
      memberId = null;
      maker = false;
      canStandIn = false;
      standIn = false;
      access = next === 'member' ? 'checking' : next;
      changed = true;
      if (next === 'member') void whoAmI();
    },

    update(f) {
      frame = f;
      const current = feed();
      if (current !== subscribed) {
        unsubscribe?.();
        subscribed = current;
        unsubscribe = current ? current.onAction(hear) : null;
      }
      if (changed) {
        changed = false;
        rebuild();
      }
      look();
      drawGhost();
      drawOutline();
      drawHeld(f);

      const next = state();
      const key = JSON.stringify(next);
      if (key !== shown) {
        shown = key;
        events.onState(next);
      }
    },

    dispose() {
      disposed = true;
      clearTimeout(timer);
      reading?.abort();
      unsubscribe?.();
      layer.dispose();
      ghosts.dispose();
      if (ghost) scene.remove(ghost);
      ghostMaterial.dispose();
      scene.remove(outline);
      outline.geometry.dispose();
      (outline.material as THREE.Material).dispose();
      for (const entry of inHand.values()) {
        entry.group.removeFromParent();
        entry.material.dispose();
      }
      inHand.clear();
    },
  };
}
