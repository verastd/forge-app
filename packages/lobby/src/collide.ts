/**
 * Members bump into each other: the local member's body against everyone
 * else's, in the lobby's units (metres, metres per second, +Y up).
 *
 * A body is an upright cylinder hung from the member's eye, sized to the
 * robot avatar (1.4 m tall, about 0.9 m across). Each client resolves only
 * its own member: it pushes itself out of whoever it overlaps, along the
 * shallower way out (sideways, or over and under), and bounces off them a
 * little. The other member's client does the same from their side, so both
 * feel the bump without anyone moving anyone else.
 *
 * Pure and deterministic like the rest of the package: no DOM, no three.js.
 */
import { CAMERA_LIMITS } from './camera.js';
import type { Vec3 } from './attenuation.js';

export const BODY = Object.freeze({
  /** Metres from the centre line to the shell. */
  radius: 0.45,
  /** Metres from the eye down to the feet (the robot's root sits 1.34 m under its eye). */
  below: 1.34,
  /** Metres from the eye up to the top of the head. */
  above: 0.12,
  /** How much of the speed into a body comes back out of it: 0 stops dead, 1 is a perfect bounce. */
  restitution: 0.35,
  /** Passes over everyone, so being squeezed between two bodies settles in one frame. */
  passes: 3,
});

/** Where the member ends up, how fast it's going, and how many bodies it was pushed out of. */
export interface Bump {
  pos: Vec3;
  vel: Vec3;
  hits: number;
}

/**
 * Pushes the body at `pos`, moving at `vel`, out of every body in `others`
 * (each given by its eye position) and bounces it off them. `tieAngle`
 * (radians) is the way out when two bodies sit exactly on one spot: give
 * each client its own, so two members who arrive together go different
 * ways. The result stays inside the cave (CAMERA_LIMITS); positions or
 * speeds that aren't finite numbers are left alone.
 */
export function collideBodies(pos: Vec3, vel: Vec3, others: readonly Vec3[], tieAngle = 0): Bump {
  const p = { ...pos };
  const v = { ...vel };
  let hits = 0;
  if (!finite(p) || !finite(v)) {
    return { pos: p, vel: v, hits };
  }
  const reach = 2 * BODY.radius;
  const height = BODY.below + BODY.above;
  for (let pass = 0; pass < BODY.passes; pass += 1) {
    let moved = false;
    for (const other of others) {
      if (!finite(other)) continue;
      const dx = p.x - other.x;
      const dz = p.z - other.z;
      const dy = p.y - other.y;
      const across = Math.hypot(dx, dz);
      if (across >= reach || Math.abs(dy) >= height) continue;

      const intoSide = reach - across;
      const intoTop = height - Math.abs(dy);
      const up = dy >= 0 ? 1 : -1;
      // Over or under when that's the shorter way out, unless it would put the member through the floor.
      const vertical = intoTop < intoSide && p.y + up * intoTop >= CAMERA_LIMITS.minY;
      let nx = 0;
      let ny = 0;
      let nz = 0;
      let depth: number;
      if (vertical) {
        ny = up;
        depth = intoTop;
      } else {
        if (across > 1e-6) {
          nx = dx / across;
          nz = dz / across;
        } else {
          nx = Math.cos(tieAngle);
          nz = Math.sin(tieAngle);
        }
        depth = intoSide;
      }
      p.x += nx * depth;
      p.y += ny * depth;
      p.z += nz * depth;
      const closing = v.x * nx + v.y * ny + v.z * nz;
      if (closing < 0) {
        const kick = (1 + BODY.restitution) * closing;
        v.x -= kick * nx;
        v.y -= kick * ny;
        v.z -= kick * nz;
      }
      hits += 1;
      moved = true;
    }
    if (!moved) break;
  }

  const r = Math.hypot(p.x, p.z);
  if (r > CAMERA_LIMITS.radius) {
    p.x *= CAMERA_LIMITS.radius / r;
    p.z *= CAMERA_LIMITS.radius / r;
  }
  p.y = Math.min(CAMERA_LIMITS.maxY, Math.max(CAMERA_LIMITS.minY, p.y));
  return {
    pos: { x: p.x + 0, y: p.y + 0, z: p.z + 0 },
    vel: { x: v.x + 0, y: v.y + 0, z: v.z + 0 },
    hits,
  };
}

function finite(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
