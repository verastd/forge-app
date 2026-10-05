/**
 * How a robot avatar moves, the pure half: the hover at rest, the lean and
 * bank of flight, the head turning toward whoever is looking, and the eyes'
 * blink. Every robot shares this motion; only the seed (from its member's id)
 * and the presence feed's positions differ. No clock and no unseeded random
 * numbers: the scene passes the time in, so the same inputs always give the
 * same pose.
 *
 * Angles are radians on the asset's axes (+Y up, the robot facing +Z):
 * `pitch` > 0 leans the top of the robot forward, `roll` > 0 banks it to its
 * own right.
 */

/** A seeded 32-bit generator (mulberry32): the same seed, the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit hash of a member id (FNV-1a), for every per-robot seed. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const BLINK = Object.freeze({
  /** Seconds to close. */
  close: 0.06,
  /** Seconds held shut. */
  hold: 0.03,
  /** Seconds to open again. */
  open: 0.09,
  /** The open eye's height while shut, as a fraction. */
  shut: 0.08,
  /** Seconds between blinks, at least and at most. */
  minGap: 2.5,
  maxGap: 6,
  /** The chance a blink is a double blink. */
  double: 0.15,
  /** Seconds between the two blinks of a double. */
  doubleGap: 0.16,
});

const BLINK_LENGTH = BLINK.close + BLINK.hold + BLINK.open;

/** How open one blink leaves the eye, `s` seconds into it: 1, down to BLINK.shut, and back. */
function blinkCurve(s: number): number {
  if (s < 0 || s >= BLINK_LENGTH) return 1;
  if (s < BLINK.close) {
    const k = s / BLINK.close;
    return 1 - (1 - BLINK.shut) * k * k;
  }
  if (s < BLINK.close + BLINK.hold) return BLINK.shut;
  const k = (s - BLINK.close - BLINK.hold) / BLINK.open;
  return BLINK.shut + (1 - BLINK.shut) * (1 - (1 - k) * (1 - k));
}

export interface Blinker {
  /**
   * How open the eyes are at time `t` (seconds, never decreasing between
   * calls): 1 open, BLINK.shut closed.
   */
  openness(t: number): number;
}

/**
 * One robot's blinking: a random gap of BLINK.minGap to BLINK.maxGap seconds
 * between blinks, sometimes a double blink, all from `seed`, so two robots
 * never blink in step and a robot's rhythm is the same on every screen.
 */
export function createBlinker(seed: number, start = 0): Blinker {
  const random = seededRandom(seed);
  const gap = (): number => BLINK.minGap + (BLINK.maxGap - BLINK.minGap) * random();
  // The first blink lands somewhere inside the first gap, not at once.
  let next = start + gap() * random();
  let twice = random() < BLINK.double;
  return {
    openness(t) {
      while (t >= next + BLINK_LENGTH + (twice ? BLINK.doubleGap : 0)) {
        next += gap() + (twice ? BLINK.doubleGap : 0);
        twice = random() < BLINK.double;
      }
      const first = blinkCurve(t - next);
      return twice ? Math.min(first, blinkCurve(t - next - BLINK.doubleGap)) : first;
    },
  };
}

/** A critically damped spring's state: where it is and how fast it moves. */
export interface Spring {
  value: number;
  velocity: number;
}

/**
 * Moves `spring` toward `target` over `dt` seconds with no overshoot.
 * `omega` is its stiffness (higher settles faster; about 4 / settle time).
 */
export function stepSpring(spring: Spring, target: number, dt: number, omega: number): void {
  const x = spring.value - target;
  const exp = Math.exp(-omega * dt);
  const temp = (spring.velocity + omega * x) * dt;
  spring.value = target + (x + temp) * exp;
  spring.velocity = (spring.velocity - omega * temp) * exp;
}

/** Wraps an angle into (−π, π]. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r <= -Math.PI) r += twoPi;
  if (r > Math.PI) r -= twoPi;
  return r;
}

export const HOVER = Object.freeze({
  /** Metres of bob, up and down. */
  bob: 0.04,
  /** Bob frequency, Hz. */
  bobHz: 1.3,
  /** Speed (m/s) at which flight is in full swing. */
  flySpeed: 4,
  /** The forward lean at full flight. */
  maxPitch: 0.32,
  /** The bank into a turn at full flight. */
  maxRoll: 0.45,
  /** The arms' sweep back at full flight. */
  armTrail: 0.7,
  /** How far the head turns to look, at most. */
  maxLook: Math.PI / 3,
  /** Within this many metres the robot looks at the viewer. */
  lookRange: 5,
});

/** What drives one frame of a robot's pose. */
export interface MotionInput {
  /** Seconds. */
  t: number;
  /** The robot's own bob phase (radians). */
  phase: number;
  /** Horizontal speed, m/s, smoothed. */
  speed: number;
  /** Vertical speed, m/s (> 0 rising), smoothed. */
  climb: number;
  /** Turn rate, rad/s (> 0 turning right), smoothed. */
  turnRate: number;
  /**
   * The bearing from the robot to the viewer relative to where the robot
   * faces (radians, > 0 to the robot's left), and how far away the viewer
   * is: the head turns to look within HOVER.lookRange.
   */
  viewerBearing: number;
  viewerDistance: number;
  reducedMotion: boolean;
}

/** One frame of a robot's procedural pose. */
export interface MotionPose {
  /** Metres added to the hover height. */
  bob: number;
  /** Whole-body lean, radians (> 0 forward). */
  pitch: number;
  /** Whole-body bank, radians (> 0 to the robot's right). */
  roll: number;
  /** 0 at rest, 1 in full flight. */
  flight: number;
  /** Arms' swing back from hanging, radians (both arms). */
  armSwing: number;
  /** A small opposite sway between the arms at rest, radians. */
  armSway: number;
  /** Chest breathing, radians of spine bend. */
  breath: number;
  /** The head's turn, radians (> 0 to the robot's left). */
  headYaw: number;
  /** The head's nod, radians (> 0 down). */
  headPitch: number;
  /** The thruster's brightness, 0..1. */
  thrust: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The robot's pose this frame: hovering at rest, leaning and banking in flight. */
export function robotPose(input: MotionInput): MotionPose {
  const { t, phase, speed, climb, turnRate, reducedMotion } = input;
  const flight = clamp(speed / HOVER.flySpeed, 0, 1);
  const ease = flight * flight * (3 - 2 * flight);
  const climbing = clamp(climb / HOVER.flySpeed, -1, 1);

  const near = input.viewerDistance < HOVER.lookRange;
  // Looking eases out over the last metre of range, so the head never snaps.
  const lookWeight = near ? clamp(HOVER.lookRange - input.viewerDistance, 0, 1) * (1 - ease) : 0;
  const headYaw = clamp(wrapAngle(input.viewerBearing), -HOVER.maxLook, HOVER.maxLook) * lookWeight;

  const thrust = clamp(0.35 + 0.65 * Math.max(ease, climbing), 0, 1);

  if (reducedMotion) {
    return {
      bob: 0,
      pitch: 0,
      roll: 0,
      flight: ease,
      armSwing: 0,
      armSway: 0,
      breath: 0,
      headYaw,
      headPitch: 0,
      thrust,
    };
  }

  const w = Math.PI * 2 * HOVER.bobHz;
  const bob = Math.sin(t * w + phase) * HOVER.bob * (1 - 0.6 * ease);
  // A climb tips the nose up a little, a dive down.
  const pitch = HOVER.maxPitch * ease - 0.12 * climbing;
  const roll = clamp(turnRate * 0.35, -1, 1) * HOVER.maxRoll * Math.max(ease, 0.25);
  const idleSway = Math.sin(t * 0.9 + phase * 1.7) * 0.06;
  return {
    bob,
    pitch,
    roll,
    flight: ease,
    // The arms lag the bob a quarter turn, and trail back in flight.
    armSwing: HOVER.armTrail * ease + Math.sin(t * w + phase - Math.PI / 2) * 0.05 * (1 - ease),
    armSway: idleSway * (1 - ease),
    breath: Math.sin(t * 1.6 + phase) * 0.025,
    headYaw: headYaw + Math.sin(t * 0.37 + phase * 2.3) * 0.12 * (1 - lookWeight) * (1 - ease),
    headPitch: -0.18 * ease + Math.sin(t * 0.53 + phase) * 0.04 * (1 - ease),
    thrust,
  };
}
