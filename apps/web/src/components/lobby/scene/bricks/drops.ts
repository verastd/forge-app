/**
 * Bricks dropping out of the Lego bot's backpack: a new brick slides out of
 * the ramp tiny and falls to where it landed on the floor, growing on the way
 * (@forge/lobby's `dropFrame`); while it's in the air it isn't drawn in the
 * cave's layer (`dropping`). A blueprint's burst: a dozen little bricks shot
 * from the ramp toward the build, gone as they land.
 */

import type * as THREE from 'three';
import { BRICK_DROP, DROP_TIME, brickBox, dropFrame } from '@forge/lobby';
import type { BrickAt } from '@forge/lobby';

import { brickColour, brickMaterial, createLoneBrick } from './meshes';

type Vec3 = { x: number; y: number; z: number };

export interface DropLayer {
  /** `brick` (where it landed) drops out of the ramp at `from`, pointing `dir`. */
  drop(brick: BrickAt & { id: string; color: string }, from: Vec3, dir: Vec3): void;
  /** Little bricks from the ramp at `from` to each of `targets`. */
  burst(from: Vec3, dir: Vec3, targets: readonly Vec3[], colors: readonly string[]): void;
  /** Whether the brick `id` is still in the air. */
  dropping(id: string): boolean;
  /** Moves everything to `now` (seconds); true when a brick landed (the cave's layer should draw it now). */
  update(now: number): boolean;
  dispose(): void;
}

interface Flight {
  id: string | null;
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  from: Vec3;
  dir: Vec3;
  to: Vec3;
  /** Its turn once landed (radians about up). */
  yaw: number;
  /** Seconds since it started; null until the first update. */
  start: number | null;
  /** How much faster than a brick's drop it plays, and its size (null: grows as it falls). */
  speed: number;
  scale: number | null;
}

export function createDropLayer(scene: THREE.Scene, envMap: THREE.Texture | null): DropLayer {
  const flights: Flight[] = [];
  const add = (shape: string, color: string, flight: Omit<Flight, 'group' | 'material' | 'start'>): void => {
    const material = brickMaterial(envMap);
    material.color.copy(brickColour(color));
    const group = createLoneBrick(shape, material, true);
    group.visible = false;
    scene.add(group);
    flights.push({ ...flight, group, material, start: null });
  };
  const land = (flight: Flight): void => {
    flight.group.removeFromParent();
    flight.material.dispose();
  };

  return {
    drop(brick, from, dir) {
      const box = brickBox(brick);
      const to = { x: (box.min[0] + box.max[0]) / 2, y: (box.min[1] + box.max[1]) / 2, z: (box.min[2] + box.max[2]) / 2 };
      add(brick.shape, brick.color, { id: brick.id, from, dir, to, yaw: (-brick.rot * Math.PI) / 2, speed: 1, scale: null });
    },
    burst(from, dir, targets, colors) {
      targets.forEach((to, i) => {
        add('brick-1x1', colors[i % colors.length] ?? 'yellow', {
          id: null,
          from,
          dir,
          to,
          yaw: i,
          speed: DROP_TIME / BRICK_DROP.burstTime,
          scale: BRICK_DROP.burstScale,
        });
      });
    },
    dropping(id) {
      return flights.some((flight) => flight.id === id);
    },
    update(now) {
      let landed = false;
      for (let i = flights.length - 1; i >= 0; i -= 1) {
        const flight = flights[i]!;
        flight.start ??= now;
        const frame = dropFrame((now - flight.start) * flight.speed, flight.from, flight.dir, flight.to);
        if (frame.done) {
          land(flight);
          flights.splice(i, 1);
          if (flight.id !== null) landed = true;
          continue;
        }
        const { group } = flight;
        group.visible = true;
        group.position.set(frame.at.x, frame.at.y, frame.at.z);
        group.scale.setScalar(flight.scale ?? frame.scale);
        group.rotation.set(frame.spin, flight.yaw, 0, 'YXZ');
      }
      return landed;
    },
    dispose() {
      for (const flight of flights) land(flight);
      flights.length = 0;
    },
  };
}
