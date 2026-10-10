/**
 * The mechanic's machines in the cave: the machines everyone sees (read from
 * the machines BFF, and kept fresh), each built part by part as it goes up,
 * and the mechanic's library and tools. Where a machine may stand is
 * @forge/lobby's machine.ts; the API has the last word on every write.
 *
 * - Only the mechanic (whoever wears the back model that makes machines: the
 *   API says, `GET me`; or an admin testing as him) keeps the library: he
 *   uploads blueprints (binary glTF, from Tripo or a CAD tool), chooses one,
 *   and a see-through ghost of it follows his aim on the floor (green fits,
 *   red says why not). R turns it (Shift+R back), + and − size it, E builds
 *   it, Q puts it away. Shift+X takes down the machine he points at (Shift+X
 *   again to confirm: it's outlined until then, or for TAKE_DOWN_ARMED_MS).
 * - A new machine builds itself from when the API says it was built, the
 *   same for everyone: part after part flies out of the mechanic's ramp (or
 *   down from above, with him not around), arcs to its place growing as it
 *   goes, and snaps in with a burst of sparks. Someone arriving later sees it
 *   mid-build, or finished. Asking for less motion skips straight to built.
 * - A machine whose blueprint is still downloading shows as a pulsing
 *   outline of its size, and one that failed as a red one.
 * - Every write says it's under way until the API answers. After one the
 *   others hear a ping (actions.ts `machines`) and ask for what changed;
 *   every 20 s everyone asks anyway.
 */

import * as THREE from 'three';
import {
  MACHINE,
  MACHINE_PROBLEM_TEXT,
  aimFloor,
  buildOrder,
  buildTime,
  machineAngle,
  machineExtent,
  machineFootprint,
  machineProblem,
  machineUnderRay,
  partFrame,
  partStart,
} from '@forge/lobby';
import type { BrickAt, LobbyAction, MachineSpot, Ray } from '@forge/lobby';
import { MACHINE_BLUEPRINT_MAX_BYTES, MACHINE_NAME_MAX, MACHINE_SCALE_MAX, MACHINE_SCALE_MIN, MACHINE_TURNS } from '@forge/shared';
import type { Machine, MachineBlueprint, MachineChange, MachineList } from '@forge/shared';

import type { PresenceFeed } from '../../presence/types';
import type { RobotView } from '../robot/view';
import type { Builder } from '../bricks/controller';
import { MachineRefusal, createMachineClient } from './client';
import type { MachineClient } from './client';
import { drawScale, readMachineModel } from './model';
import type { MachineModel } from './model';
import { createSparks } from './sparks';

/** How long "take down this machine?" waits for its confirmation. */
export const TAKE_DOWN_ARMED_MS = 10_000;

export type MachineBusy = 'building' | 'taking-down' | 'switching';

/** A blueprint in the library, as the panel shows it. */
export interface LibraryItem {
  id: string;
  name: string;
  parts: number;
  bytes: number;
  /** Its size at scale 1, metres (width, height, depth). */
  metres: [number, number, number];
}

export interface MachineState {
  /** The machines: loading them, shown, or failed to load (and trying again). */
  sync: 'loading' | 'ready' | 'error';
  access: 'checking' | 'member' | 'signed-out' | 'practice' | 'unavailable';
  mechanic: boolean;
  /** An admin may take over the mechanic to test ("Be the mechanic")… */
  canStandIn: boolean;
  /** …and has. */
  standIn: boolean;
  /** Machines in the cave. */
  count: number;
  busy: MachineBusy | null;
  /** The mechanic's library: not asked for yet, loading, there, or failed to load. */
  library: { status: 'idle' | 'loading' | 'ready' | 'error'; items: LibraryItem[] };
  /** A blueprint on its way up: reading the file (and finding its parts), then sending it. */
  upload: { name: string; stage: 'reading' | 'uploading' | 'finishing'; progress: number; parts: number | null } | null;
  /** Why the last upload failed (shown until the next one, or dismissed). */
  uploadError: string | null;
  /** The blueprint being deleted from the library. */
  deleting: string | null;
  /**
   * The blueprint the mechanic chose to build: its file downloading (with
   * progress) or ready (or failed), how it's turned and sized, and whether it
   * fits where it's aimed (null aim: not aimed at the floor).
   */
  chosen: {
    id: string;
    name: string;
    parts: number;
    load: 'loading' | 'ready' | 'error';
    progress: number;
    turn: number;
    scale: number;
    aim: { fits: boolean; why: string | null } | null;
  } | null;
  /** The machine the mechanic points at (with nothing chosen). */
  target: { id: string; name: string } | null;
  /** The mechanic asked to take a machine down: waiting for him to confirm. */
  takeDown: { name: string } | null;
  /** A machine going up right now, and how far along it is. */
  assembling: { name: string; part: number; parts: number } | null;
  /** Machines whose blueprints are still on their way (each shows as an outline until it's here). */
  loadingModels: number;
}

export type MachineCommand =
  | { kind: 'stand-in'; on: boolean }
  | { kind: 'retry' }
  | { kind: 'library' }
  | { kind: 'upload'; file: File }
  | { kind: 'cancel-upload' }
  | { kind: 'dismiss-upload-error' }
  | { kind: 'delete-blueprint'; id: string }
  | { kind: 'choose'; id: string }
  | { kind: 'retry-model' }
  | { kind: 'put-away' }
  | { kind: 'turn'; step: 1 | -1 }
  | { kind: 'scale'; value: number }
  | { kind: 'build' }
  | { kind: 'take-down' }
  | { kind: 'cancel-take-down' };

export interface MachineFrame {
  /** Your eye, for reach. */
  eye: THREE.Vector3;
  selfRobot: RobotView | null;
  robotOf(id: string): RobotView | null;
  /** The cave's placed bricks (a machine can't stand on them). */
  bricks(): readonly BrickAt[];
  reducedMotion: boolean;
}

export interface MachineEvents {
  onState(state: MachineState): void;
  onEvent(text: string): void;
  /** Being the mechanic changed which role the API gives you (the bricks should ask again). */
  onRoleChange(): void;
}

export interface Machines {
  command(command: MachineCommand): void;
  /** A key, if it's the mechanic's to take: true when it was. */
  key(code: string, shift: boolean): boolean;
  setBuilder(builder: Builder): void;
  /** Asks the API again who you are (after "Be the Lego bot" changed it). */
  recheck(): void;
  /** Where every machine stands (a brick can't go inside one): the same array until they change. */
  spots(): readonly MachineSpot[];
  update(frame: MachineFrame): void;
  dispose(): void;
}

const REFRESH_MS = 20_000;
const RETRY_MS = 5_000;
/** How long a blueprint's file that failed is left before a machine asks again (ms). */
const MODEL_RETRY_MS = 30_000;
const SCALE_STEP = 0.1;

const GHOST_FITS = new THREE.Color('#46e08a');
const GHOST_BLOCKED = new THREE.Color('#ff5d5d');
const LOADING = new THREE.Color('#5ee7ff');
const FAILED = new THREE.Color('#ff5d5d');

const spotOf = (machine: Machine): MachineSpot => ({ size: machine.size, x: machine.x, z: machine.z, turn: machine.turn, scale: machine.scale });
const metresOf = (blueprint: MachineBlueprint): [number, number, number] => machineExtent(blueprint.size, 1);
const itemOf = (blueprint: MachineBlueprint): LibraryItem => ({
  id: blueprint.id,
  name: blueprint.name,
  parts: blueprint.parts,
  bytes: blueprint.bytes,
  metres: metresOf(blueprint),
});
const round = (value: number, step: number): number => Math.round(value / step) * step;

interface ModelEntry {
  status: 'loading' | 'ready' | 'error';
  progress: number;
  model: MachineModel | null;
  failedAt: number;
}

/** A machine as drawn: its outline while its blueprint loads, then its parts going up. */
interface Drawn {
  machine: Machine;
  root: THREE.Group;
  outline: THREE.LineSegments;
  parts: THREE.Group[] | null;
  model: MachineModel | null;
  order: number[];
  /** The build's start, in performance.now() seconds (from the API's builtAt). */
  start: number;
  /** Where the parts fly from, in the machine's frame (null: worked out once its parts are here). */
  from: THREE.Vector3 | null;
  /** Parts already snapped in (sparks once each). */
  snapped: Set<number>;
  done: boolean;
}

export function createMachines(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  feed: () => PresenceFeed | null,
  events: MachineEvents,
  /** The robots' environment map, which lights the machines too (null: none yet). */
  envMap: THREE.Texture | null,
  client: MachineClient = createMachineClient(),
): Machines {
  const machines = new Map<string, Machine>();
  let rev: number | null = null;
  let sync: MachineState['sync'] = 'loading';
  /** The API's clock minus ours (ms), so a build plays in step for everyone. */
  let skew = 0;
  let builder: Builder | null = null;
  let access: MachineState['access'] = 'checking';
  let memberId: string | null = null;
  let mechanic = false;
  let canStandIn = false;
  let standIn = false;
  let busy: MachineBusy | null = null;
  let disposed = false;
  let changed = true;
  let frame: MachineFrame | null = null;
  /** The last frame's time (seconds), for the sparks' step. */
  let last = performance.now() / 1000;

  // ---------- the machines: read, and kept fresh ----------

  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading: AbortController | null = null;
  let again = false;

  const apply = (list: MachineList): void => {
    if (list.full) machines.clear();
    for (const machine of list.machines) machines.set(machine.id, machine);
    for (const id of list.gone) machines.delete(id);
    rev = list.rev;
    const now = Date.parse(list.now);
    if (Number.isFinite(now)) skew = now - Date.now();
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
      if (sync !== 'ready') sync = 'error';
      wait = error instanceof MachineRefusal && error.code === 'lobby-disabled' ? REFRESH_MS * 3 : RETRY_MS;
    } finally {
      reading = null;
      changed = true;
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

  // ---------- who you are ----------

  const whoAmI = async (): Promise<void> => {
    try {
      const me = await client.me();
      if (disposed || builder !== 'member') return;
      memberId = me.memberId;
      mechanic = me.mechanic;
      canStandIn = me.canStandIn;
      standIn = me.standIn;
      access = 'member';
      if ((mechanic || canStandIn) && library.status === 'idle') void loadLibrary();
    } catch (error) {
      if (disposed || builder !== 'member') return;
      memberId = null;
      mechanic = false;
      canStandIn = false;
      standIn = false;
      access = error instanceof MachineRefusal && error.code === 'practice_session' ? 'practice' : 'unavailable';
    } finally {
      changed = true;
    }
  };

  // ---------- the library ----------

  const library: MachineState['library'] = { status: 'idle', items: [] };
  const blueprints = new Map<string, MachineBlueprint>();
  const loadLibrary = async (): Promise<void> => {
    library.status = 'loading';
    changed = true;
    try {
      const list = await client.blueprints();
      if (disposed) return;
      blueprints.clear();
      for (const blueprint of list) blueprints.set(blueprint.id, blueprint);
      library.items = list.map(itemOf);
      library.status = 'ready';
    } catch {
      if (disposed) return;
      library.status = 'error';
    } finally {
      changed = true;
    }
  };

  // ---------- blueprints' files, read once each ----------

  const models = new Map<string, ModelEntry>();
  const model = (sha256: string, bytes: number): ModelEntry => {
    let entry = models.get(sha256);
    if (entry && entry.status === 'error' && performance.now() - entry.failedAt > MODEL_RETRY_MS) entry = undefined;
    if (entry) return entry;
    const fresh: ModelEntry = { status: 'loading', progress: 0, model: null, failedAt: 0 };
    models.set(sha256, fresh);
    client
      .file(sha256, bytes, (fraction) => {
        fresh.progress = fraction;
        changed = true;
      })
      .then((data) => readMachineModel(data, envMap))
      .then((read) => {
        if (disposed) {
          read.dispose();
          return;
        }
        fresh.model = read;
        fresh.status = 'ready';
      })
      .catch(() => {
        fresh.status = 'error';
        fresh.failedAt = performance.now();
      })
      .finally(() => {
        changed = true;
      });
    return fresh;
  };

  // ---------- hearing the others ----------

  let subscribed: PresenceFeed | null = null;
  let unsubscribe: (() => void) | null = null;
  const hear = (_from: string, action: LobbyAction): void => {
    if (action.kind !== 'machines') return;
    if (rev === null || action.rev > rev) void read();
  };
  const ping = (change: { rev: number }): void => {
    feed()?.sendAction({ kind: 'machines', rev: change.rev });
  };

  // ---------- drawing the machines ----------

  const sparks = createSparks(scene);
  const outlineGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const drawn = new Map<string, Drawn>();

  /** Seconds the build has been going, by the API's clock. */
  const elapsed = (machine: Machine): number => (Date.now() + skew - Date.parse(machine.builtAt)) / 1000;

  const place = (root: THREE.Object3D, machine: Machine): void => {
    root.position.set(machine.x, 0, machine.z);
    root.rotation.set(0, machineAngle(machine.turn), 0);
    root.scale.setScalar(drawScale(machine.scale));
  };

  const addDrawn = (machine: Machine): Drawn => {
    const root = new THREE.Group();
    root.name = `machine-${machine.id}`;
    place(root, machine);
    // Its outline, in the normalised frame (longest side 1): its size, from the floor up.
    const [w, h, d] = machine.size;
    const longest = Math.max(w, h, d);
    const outline = new THREE.LineSegments(
      outlineGeometry,
      new THREE.LineBasicMaterial({ color: LOADING, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    outline.scale.set(w / longest, h / longest, d / longest);
    root.add(outline);
    scene.add(root);
    const entry: Drawn = {
      machine,
      root,
      outline,
      parts: null,
      model: null,
      order: [],
      start: performance.now() / 1000 - elapsed(machine),
      from: null,
      snapped: new Set(),
      done: false,
    };
    drawn.set(machine.id, entry);
    return entry;
  };

  const removeDrawn = (entry: Drawn): void => {
    scene.remove(entry.root);
    (entry.outline.material as THREE.Material).dispose();
    drawn.delete(entry.machine.id);
  };

  /** Where a machine's parts fly from: its builder's ramp, or (him not around) high above it. In the machine's frame. */
  const launchFrom = (entry: Drawn): THREE.Vector3 => {
    const robot = !frame ? null : entry.machine.builtBy === memberId ? frame.selfRobot : frame.robotOf(entry.machine.builtBy);
    const at = new THREE.Vector3();
    const dir = new THREE.Vector3();
    if (!robot?.spout(at, dir)) {
      const height = machineExtent(entry.machine.size, entry.machine.scale)[1];
      at.set(entry.machine.x, height + 2.5, entry.machine.z);
    }
    entry.root.updateMatrixWorld(true);
    return entry.root.worldToLocal(at);
  };

  const finish = (entry: Drawn): void => {
    if (!entry.parts || !entry.model) return;
    entry.parts.forEach((part, p) => {
      part.position.copy(entry.model!.centres[p]!);
      part.scale.setScalar(1);
      part.rotation.set(0, 0, 0);
      part.visible = true;
    });
    entry.done = true;
  };

  const animate = (entry: Drawn, now: number, still: boolean): void => {
    if (!entry.parts || !entry.model || entry.done) return;
    const count = entry.parts.length;
    const t = now - entry.start;
    if (still || t >= buildTime(count)) {
      finish(entry);
      return;
    }
    entry.from ??= launchFrom(entry);
    const scratch = new THREE.Vector3();
    entry.order.forEach((p, k) => {
      const part = entry.parts![p]!;
      const centre = entry.model!.centres[p]!;
      const f = partFrame(t - partStart(k, count), entry.from!, centre);
      part.visible = f.phase !== 'waiting';
      part.position.set(f.at.x, f.at.y, f.at.z);
      part.scale.setScalar(f.scale);
      part.rotation.set(f.spin * 0.6, f.spin, 0);
      if (f.phase !== 'flying' && f.phase !== 'waiting' && !entry.snapped.has(p)) {
        entry.snapped.add(p);
        if (f.phase === 'snapping') {
          part.getWorldPosition(scratch);
          const span = entry.model!.parts[p]!;
          const across = Math.max(span.max.x - span.min.x, span.max.y - span.min.y, span.max.z - span.min.z);
          sparks.emit(scratch, 14, Math.min(0.6, across * drawScale(entry.machine.scale) * 0.05 + 0.1));
        }
      }
    });
  };

  /** Brings what's drawn in line with the machines: new ones added, gone ones taken away, blueprints swapped in as they arrive. */
  const sync3d = (): void => {
    for (const [id, entry] of drawn) if (!machines.has(id)) removeDrawn(entry);
    for (const machine of machines.values()) {
      let entry = drawn.get(machine.id);
      if (entry && (entry.machine.x !== machine.x || entry.machine.z !== machine.z || entry.machine.turn !== machine.turn || entry.machine.scale !== machine.scale)) {
        place(entry.root, machine);
      }
      entry ??= addDrawn(machine);
      entry.machine = machine;
      if (entry.parts) continue;
      const loaded = model(machine.sha256, machine.bytes);
      (entry.outline.material as THREE.LineBasicMaterial).color.copy(loaded.status === 'error' ? FAILED : LOADING);
      if (loaded.status !== 'ready' || !loaded.model) continue;
      const built = loaded.model.build();
      entry.model = loaded.model;
      entry.parts = built.parts;
      entry.order = buildOrder(loaded.model.parts);
      for (const part of built.parts) part.visible = false;
      entry.root.add(built.root);
      entry.outline.visible = false;
    }
  };

  // ---------- the mechanic's ghost, aim and target ----------

  let chosen: { blueprint: MachineBlueprint; turn: number; scale: number } | null = null;
  const ghostMaterial = new THREE.MeshBasicMaterial({ color: GHOST_FITS, transparent: true, opacity: 0.38, depthWrite: false });
  let ghost: { sha: string; group: THREE.Group } | null = null;
  let aimed: { x: number; z: number } | null = null;
  let aim: { fits: boolean; why: string | null } | null = null;
  let aimKey = '';
  /** The bricks the aim was checked against (the cave's layer hands over a new array whenever they change). */
  let aimBricks: readonly BrickAt[] | null = null;
  let target: Machine | null = null;
  let armed: { id: string; at: number } | null = null;

  const marker = (color: number): THREE.LineSegments => {
    const lines = new THREE.LineSegments(outlineGeometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }));
    lines.visible = false;
    lines.renderOrder = 2;
    scene.add(lines);
    return lines;
  };
  const targetOutline = marker(0xffffff);
  const armedOutline = marker(0xff5a4f);
  const drawMarker = (lines: THREE.LineSegments, machine: Machine | null): void => {
    if (!machine) {
      lines.visible = false;
      return;
    }
    const box = machineFootprint(spotOf(machine));
    const height = machineExtent(machine.size, machine.scale)[1];
    lines.visible = true;
    lines.position.set((box.minX + box.maxX) / 2, -0.01, (box.minZ + box.maxZ) / 2);
    lines.scale.set(box.maxX - box.minX + 0.06, height + 0.06, box.maxZ - box.minZ + 0.06);
  };

  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const ray = (): { ray: Ray; reach: number } => {
    camera.getWorldPosition(origin);
    camera.getWorldDirection(direction);
    const reach = MACHINE.reach + (frame ? origin.distanceTo(frame.eye) : 0);
    return { ray: { origin: [origin.x, origin.y, origin.z], dir: [direction.x, direction.y, direction.z] }, reach };
  };

  const chosenModel = (): ModelEntry | null => (chosen ? model(chosen.blueprint.sha256, chosen.blueprint.bytes) : null);

  const look = (): void => {
    target = null;
    if (!mechanic) {
      aimed = null;
      aim = null;
      return;
    }
    const { ray: r, reach } = ray();
    if (!chosen) {
      aimed = null;
      aim = null;
      target = machineUnderRay(r, [...machines.values()].map((machine) => ({ ...spotOf(machine), machine })), reach)?.machine ?? null;
      return;
    }
    if (busy !== null) return;
    const floor = aimFloor(r, reach);
    if (!floor) {
      aimed = null;
      aim = null;
      aimKey = '';
      return;
    }
    // On a 5 cm grid, so the ghost doesn't shiver and the rules run only when it moves.
    aimed = { x: round(floor.x, 0.05), z: round(floor.z, 0.05) };
    const bricks = frame?.bricks() ?? [];
    const key = `${aimed.x},${aimed.z}|${chosen.turn}|${chosen.scale}|${rev ?? ''}`;
    if (key === aimKey && bricks === aimBricks) return;
    aimKey = key;
    aimBricks = bricks;
    const spot: MachineSpot = { size: chosen.blueprint.size, x: aimed.x, z: aimed.z, turn: chosen.turn, scale: chosen.scale };
    const problem = machineProblem(spot, [...machines.values()].map(spotOf), bricks);
    aim = { fits: problem === null, why: problem === null ? null : MACHINE_PROBLEM_TEXT[problem] };
  };

  const drawGhost = (): void => {
    const loaded = chosenModel();
    if (!chosen || !aimed || !aim || !loaded?.model) {
      if (ghost) ghost.group.visible = false;
      return;
    }
    if (!ghost || ghost.sha !== chosen.blueprint.sha256) {
      if (ghost) scene.remove(ghost.group);
      const group = loaded.model.ghost(ghostMaterial);
      group.renderOrder = 1;
      ghost = { sha: chosen.blueprint.sha256, group };
      scene.add(group);
    }
    const { group } = ghost;
    group.visible = true;
    group.position.set(aimed.x, 0.002, aimed.z);
    group.rotation.set(0, machineAngle(chosen.turn), 0);
    group.scale.setScalar(drawScale(chosen.scale));
    ghostMaterial.color.copy(aim.fits ? GHOST_FITS : GHOST_BLOCKED);
  };

  const putAway = (): void => {
    chosen = null;
    aimed = null;
    aim = null;
    aimKey = '';
    if (ghost) ghost.group.visible = false;
    changed = true;
  };

  // ---------- writes ----------

  const canBuild = (): boolean => {
    if (access === 'member') return true;
    const why: Record<Exclude<MachineState['access'], 'member'>, string> = {
      checking: 'Just a moment: checking who you are…',
      'signed-out': 'Sign in with GitHub to build.',
      practice: 'The practice account can’t build: sign in with GitHub.',
      unavailable: 'Building isn’t available right now.',
    };
    events.onEvent(why[access]);
    return false;
  };
  const mechanicOnly = (): boolean => {
    if (!canBuild()) return false;
    if (mechanic) return true;
    events.onEvent('Only the mechanic builds machines.');
    return false;
  };
  const ready = (): boolean => {
    if (busy !== null) return false;
    if (sync !== 'ready') {
      events.onEvent(sync === 'loading' ? 'The machines are still loading…' : 'Couldn’t load the machines: trying again…');
      return false;
    }
    return true;
  };
  const say = (error: unknown, fallback: string): void => {
    events.onEvent(error instanceof MachineRefusal ? error.message : fallback);
  };

  let upload: MachineState['upload'] = null;
  let uploadError: string | null = null;
  let uploading: AbortController | null = null;
  let deleting: string | null = null;

  const startUpload = async (file: File): Promise<void> => {
    uploadError = null;
    if (!/\.glb$/i.test(file.name)) {
      uploadError = 'A blueprint is a .glb file (binary glTF): export one from Tripo, Blender or your CAD tool.';
      changed = true;
      return;
    }
    if (file.size > MACHINE_BLUEPRINT_MAX_BYTES) {
      uploadError = `That file is too big (${Math.round(file.size / 1024 / 1024)} MB; the most is ${MACHINE_BLUEPRINT_MAX_BYTES / 1024 / 1024} MB).`;
      changed = true;
      return;
    }
    const name = file.name.replace(/\.glb$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, MACHINE_NAME_MAX) || 'Blueprint';
    const controller = new AbortController();
    uploading = controller;
    upload = { name, stage: 'reading', progress: 0, parts: null };
    changed = true;
    let read: MachineModel | null = null;
    try {
      const data = await file.arrayBuffer();
      try {
        read = await readMachineModel(data, envMap);
      } catch {
        throw new MachineRefusal(400, 'invalid_request');
      }
      if (controller.signal.aborted) throw new DOMException('cancelled', 'AbortError');
      upload = { name, stage: 'uploading', progress: 0, parts: read.parts.length };
      changed = true;
      const parts = read.parts.length;
      const done = await client.upload({ name, parts, size: read.size }, data, (fraction) => {
        if (upload) upload = { ...upload, stage: fraction >= 1 ? 'finishing' : 'uploading', progress: fraction };
        changed = true;
      }, controller.signal);
      if (disposed) return;
      // Its model is read already: the cave needn't download it again.
      if (!models.has(done.sha256)) models.set(done.sha256, { status: 'ready', progress: 1, model: read, failedAt: 0 });
      else read.dispose();
      read = null;
      blueprints.set(done.id, done);
      library.items = [itemOf(done), ...library.items.filter((item) => item.id !== done.id)];
      if (library.status !== 'loading') library.status = 'ready';
      events.onEvent(`Added ${done.name} to the library: ${done.parts} part${done.parts === 1 ? '' : 's'}`);
    } catch (error) {
      if (disposed) return;
      if ((error as Error).name === 'AbortError') events.onEvent('Upload cancelled');
      else uploadError = error instanceof MachineRefusal ? error.message : 'Couldn’t upload that: try again.';
    } finally {
      read?.dispose();
      if (uploading === controller) uploading = null;
      upload = null;
      changed = true;
    }
  };

  const run = (command: MachineCommand): void => {
    switch (command.kind) {
      case 'retry': {
        void read();
        return;
      }
      case 'library': {
        if (library.status !== 'loading') void loadLibrary();
        return;
      }
      case 'stand-in': {
        if (!canBuild() || busy !== null) return;
        if (!canStandIn) {
          events.onEvent('Only admins can take over the mechanic.');
          return;
        }
        busy = 'switching';
        changed = true;
        client
          .standIn(command.on)
          .then((me) => {
            if (disposed) return;
            mechanic = me.mechanic;
            canStandIn = me.canStandIn;
            standIn = me.standIn;
            if (!mechanic) putAway();
            if (mechanic && library.status === 'idle') void loadLibrary();
            events.onEvent(me.standIn ? 'You’re the mechanic now (for testing)' : 'You’re yourself again');
            events.onRoleChange();
          })
          .catch((error: unknown) => {
            if (!disposed) say(error, 'Couldn’t switch: try again.');
          })
          .finally(() => {
            if (disposed) return;
            busy = null;
            changed = true;
          });
        return;
      }
      case 'upload': {
        if (!mechanicOnly()) return;
        if (upload) {
          events.onEvent('One upload at a time: wait for this one, or cancel it.');
          return;
        }
        void startUpload(command.file);
        return;
      }
      case 'cancel-upload': {
        uploading?.abort();
        return;
      }
      case 'dismiss-upload-error': {
        uploadError = null;
        changed = true;
        return;
      }
      case 'delete-blueprint': {
        if (!mechanicOnly() || deleting !== null) return;
        const blueprint = blueprints.get(command.id);
        if (!blueprint) return;
        deleting = command.id;
        changed = true;
        client
          .deleteBlueprint(command.id)
          .then(() => {
            if (disposed) return;
            blueprints.delete(command.id);
            library.items = library.items.filter((item) => item.id !== command.id);
            if (chosen?.blueprint.id === command.id) putAway();
            events.onEvent(`Deleted ${blueprint.name} from the library (machines built from it stay)`);
          })
          .catch((error: unknown) => {
            if (!disposed) say(error, 'Couldn’t delete it: try again.');
            if (error instanceof MachineRefusal && error.code === 'blueprint_not_found') void loadLibrary();
          })
          .finally(() => {
            if (disposed) return;
            deleting = null;
            changed = true;
          });
        return;
      }
      case 'choose': {
        if (!mechanicOnly() || busy !== null) return;
        const blueprint = blueprints.get(command.id);
        if (!blueprint) return;
        chosen = { blueprint, turn: chosen?.turn ?? 0, scale: chosen?.scale ?? 1 };
        armed = null;
        aimKey = '';
        model(blueprint.sha256, blueprint.bytes);
        changed = true;
        return;
      }
      case 'retry-model': {
        if (!chosen) return;
        const entry = models.get(chosen.blueprint.sha256);
        if (entry?.status === 'error') models.delete(chosen.blueprint.sha256);
        model(chosen.blueprint.sha256, chosen.blueprint.bytes);
        changed = true;
        return;
      }
      case 'put-away': {
        putAway();
        return;
      }
      case 'turn': {
        if (!chosen) return;
        chosen.turn = (chosen.turn + command.step + MACHINE_TURNS) % MACHINE_TURNS;
        changed = true;
        return;
      }
      case 'scale': {
        if (!chosen) return;
        chosen.scale = Math.min(MACHINE_SCALE_MAX, Math.max(MACHINE_SCALE_MIN, round(command.value, 0.05)));
        changed = true;
        return;
      }
      case 'build': {
        if (!mechanicOnly() || !ready() || !chosen) return;
        const loaded = chosenModel();
        if (loaded?.status !== 'ready') {
          events.onEvent(loaded?.status === 'error' ? 'Couldn’t load that blueprint: try again.' : 'The blueprint is still loading…');
          return;
        }
        if (!aimed || !aim) {
          events.onEvent('Aim at the floor where it should go.');
          return;
        }
        if (!aim.fits) {
          events.onEvent(aim.why ?? 'It doesn’t fit there.');
          return;
        }
        const body = { blueprint: chosen.blueprint.id, x: aimed.x, z: aimed.z, turn: chosen.turn, scale: chosen.scale };
        const name = chosen.blueprint.name;
        busy = 'building';
        changed = true;
        client
          .build(body)
          .then((change: MachineChange) => {
            if (disposed) return;
            if (change.machine) {
              machines.set(change.machine.id, change.machine);
              rev = Math.max(rev ?? 0, change.rev);
            }
            events.onEvent(`Building ${name}: ${change.machine?.parts ?? ''} parts`);
            ping(change);
            putAway();
            void read();
          })
          .catch((error: unknown) => {
            if (disposed) return;
            say(error, 'Couldn’t build it: try again.');
            if (error instanceof MachineRefusal && error.status !== 0) void read();
          })
          .finally(() => {
            if (disposed) return;
            busy = null;
            aimKey = '';
            changed = true;
          });
        return;
      }
      case 'cancel-take-down': {
        if (armed) {
          armed = null;
          changed = true;
        }
        return;
      }
      case 'take-down': {
        if (!mechanicOnly() || !ready()) return;
        const id = armed?.id ?? target?.id ?? null;
        const victim = id ? machines.get(id) : undefined;
        if (!victim) {
          events.onEvent('Point at a machine to take it down.');
          return;
        }
        if (!armed) {
          armed = { id: victim.id, at: performance.now() };
          changed = true;
          events.onEvent(`Take down ${victim.name}? Shift+X again to confirm.`);
          return;
        }
        armed = null;
        machines.delete(victim.id);
        busy = 'taking-down';
        changed = true;
        client
          .takeDown(victim.id)
          .then((change) => {
            if (disposed) return;
            events.onEvent(`Took down ${victim.name}`);
            ping(change);
          })
          .catch((error: unknown) => {
            if (disposed) return;
            machines.set(victim.id, victim);
            say(error, 'Couldn’t take it down: try again.');
          })
          .finally(() => {
            if (disposed) return;
            busy = null;
            changed = true;
            void read();
          });
        return;
      }
    }
  };

  // ---------- the shell's view ----------

  /** Where the machines stand, for the bricks: kept until the machines change. */
  let spotList: readonly MachineSpot[] = [];
  let spotsRev: number | null = -1;
  let spotsCount = -1;
  let shown = '';
  const assembling = (now: number): MachineState['assembling'] => {
    let best: Drawn | null = null;
    for (const entry of drawn.values()) if (entry.parts && !entry.done && (!best || entry.start > best.start)) best = entry;
    if (!best?.parts) return null;
    const count = best.parts.length;
    const t = now - best.start;
    let part = 0;
    while (part < count && t >= partStart(part, count) + MACHINE.fly) part += 1;
    return { name: best.machine.name, part, parts: count };
  };
  const state = (now: number): MachineState => {
    const loaded = chosenModel();
    let loadingModels = 0;
    for (const entry of drawn.values()) if (!entry.parts) loadingModels += 1;
    return {
      sync,
      access,
      mechanic,
      canStandIn,
      standIn,
      count: machines.size,
      busy,
      library: { status: library.status, items: library.items },
      upload: upload ? { ...upload, progress: Math.round(upload.progress * 100) / 100 } : null,
      uploadError,
      deleting,
      chosen:
        chosen && loaded
          ? {
              id: chosen.blueprint.id,
              name: chosen.blueprint.name,
              parts: chosen.blueprint.parts,
              load: loaded.status,
              progress: Math.round(loaded.progress * 100) / 100,
              turn: chosen.turn,
              scale: chosen.scale,
              aim,
            }
          : null,
      target: target && !chosen ? { id: target.id, name: target.name } : null,
      takeDown: armed ? { name: machines.get(armed.id)?.name ?? 'it' } : null,
      assembling: assembling(now),
      loadingModels,
    };
  };

  return {
    command: run,

    key(code, shift) {
      if (!mechanic) return false;
      if (chosen) {
        if (code === 'KeyE') run({ kind: 'build' });
        else if (code === 'KeyR') run({ kind: 'turn', step: shift ? -1 : 1 });
        else if (code === 'KeyQ') run({ kind: 'put-away' });
        else if (code === 'Equal') run({ kind: 'scale', value: chosen.scale + SCALE_STEP });
        else if (code === 'Minus') run({ kind: 'scale', value: chosen.scale - SCALE_STEP });
        else return false;
        return true;
      }
      if (code === 'KeyX' && shift && (armed || target)) {
        run({ kind: 'take-down' });
        return true;
      }
      return false;
    },

    setBuilder(next) {
      if (next === builder) return;
      builder = next;
      memberId = null;
      mechanic = false;
      canStandIn = false;
      standIn = false;
      putAway();
      access = next === 'member' ? 'checking' : next;
      changed = true;
      if (next === 'member') void whoAmI();
    },

    recheck() {
      if (builder === 'member') void whoAmI();
    },

    spots() {
      if (spotsRev !== rev || spotsCount !== machines.size) {
        spotsRev = rev;
        spotsCount = machines.size;
        spotList = [...machines.values()].map(spotOf);
      }
      return spotList;
    },

    update(f) {
      frame = f;
      const now = performance.now() / 1000;
      const current = feed();
      if (current !== subscribed) {
        unsubscribe?.();
        subscribed = current;
        unsubscribe = current ? current.onAction(hear) : null;
      }
      if (changed) sync3d();
      // Outlines of machines still loading breathe, so they read as on their way.
      const pulse = 0.45 + 0.4 * Math.abs(Math.sin(now * 2.4));
      for (const entry of drawn.values()) {
        if (!entry.parts) {
          (entry.outline.material as THREE.LineBasicMaterial).opacity = pulse;
          continue;
        }
        animate(entry, now, f.reducedMotion);
      }
      sparks.update(Math.min(0.1, Math.max(0, now - last)));
      last = now;
      if (armed && (performance.now() - armed.at > TAKE_DOWN_ARMED_MS || !machines.has(armed.id))) {
        armed = null;
        changed = true;
      }
      look();
      drawGhost();
      drawMarker(targetOutline, chosen || armed ? null : target);
      drawMarker(armedOutline, armed ? machines.get(armed.id) ?? null : null);
      changed = false;

      const next = state(now);
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
      uploading?.abort();
      unsubscribe?.();
      for (const entry of [...drawn.values()]) removeDrawn(entry);
      for (const entry of models.values()) entry.model?.dispose();
      models.clear();
      if (ghost) scene.remove(ghost.group);
      ghostMaterial.dispose();
      for (const lines of [targetOutline, armedOutline]) {
        scene.remove(lines);
        (lines.material as THREE.Material).dispose();
      }
      outlineGeometry.dispose();
      sparks.dispose();
    },
  };
}
