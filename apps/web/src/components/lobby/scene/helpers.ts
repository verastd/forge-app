/**
 * The cave's helper bots (with avatars on): robots of the cave's own that go
 * round its edge and stop for whoever comes up to them. @forge/lobby's
 * helpers.ts has how they move, and why everyone sees them in the same place
 * with no server: their place on the loop comes from the wall clock, and who
 * they stop for from everyone's positions, which every client already has.
 *
 * They're drawn exactly as people are (peers.ts): an orb while the robot body
 * loads, then a robot in the look an admin gave them in the avatar editor (or
 * their own amber default), with a name tag marked as a bot, and you bump
 * into them as you would anyone. They aren't in the people panel, the people
 * count or `data-robots`: there's nobody on the other end. Each is stepped by
 * the wall clock every frame, from where you and everyone the feed has are.
 *
 * A bot's head carries a rotating beacon (robot/beacon.ts draws it), and each
 * bot has one real amber spotlight here that follows its beam round, so the
 * sweep lights the floor, the rock and anyone it passes. The lights are made
 * with the scene, dark until a beam shines (the body, or the head, still
 * loading; reduced motion), so the cave's materials are compiled for them
 * once and a bot arriving never stalls a frame.
 */

import * as THREE from 'three';
import { HELPER_BOTS, gesturePose, helperMode, helperWave, loopPoint, startHelper, stepHelper } from '@forge/lobby';
import type { HelperMode, HelperState, Vec3 } from '@forge/lobby';

import type { PeerState } from '../presence/types';
import type { RobotAct, RobotView } from './robot/view';

/** The beacon's light: amber, how bright, how far it reaches, and how wide its pool is. */
const BEACON = { color: 0xffa62b, intensity: 36, distance: 26, angle: 0.3, penumbra: 0.65, decay: 1.6 };

export interface Helpers {
  /** Steps every bot to `nowMs` (the wall clock), with everyone in the cave (their eyes) round it. */
  step(nowMs: number, people: readonly Vec3[]): void;
  /** `peers` with the bots among them, for drawing. */
  withPeers(peers: ReadonlyMap<string, PeerState>): ReadonlyMap<string, PeerState>;
  /** A bot's arms (a wave hello as it stops for someone); undefined for anyone else, or while it isn't waving. */
  act(id: string, reducedMotion: boolean): RobotAct | undefined;
  /** What each bot is doing, in HELPER_BOTS order. */
  modes(): HelperMode[];
  /** Where each bot's eye is, in HELPER_BOTS order. */
  where(): Vec3[];
  /** Points each bot's spotlight down its beam (`robotOf` finds its robot, once it's drawn); dark without one. */
  light(robotOf: (id: string) => RobotView | null): void;
  dispose(): void;
}

export function createHelpers(scene: THREE.Scene, nowMs: number): Helpers {
  let now = nowMs;
  const lamps = HELPER_BOTS.map(() => {
    const spot = new THREE.SpotLight(BEACON.color, 0, BEACON.distance, BEACON.angle, BEACON.penumbra, BEACON.decay);
    spot.name = 'helper-beacon';
    scene.add(spot, spot.target);
    return spot;
  });
  const at = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const states = new Map<string, HelperState>(HELPER_BOTS.map((bot) => [bot.id, startHelper(bot, nowMs)]));
  const drawn = new Map<string, PeerState>();
  const stateOf = (id: string): HelperState => states.get(id) as HelperState;

  return {
    step(nowMs, people) {
      now = nowMs;
      for (const bot of HELPER_BOTS) states.set(bot.id, stepHelper(bot, stateOf(bot.id), people, nowMs));
    },
    withPeers(peers) {
      drawn.clear();
      for (const [id, peer] of peers) drawn.set(id, peer);
      for (const bot of HELPER_BOTS) {
        const state = stateOf(bot.id);
        const { at } = loopPoint(state.arc);
        drawn.set(bot.id, { id: bot.id, name: bot.name, x: at.x, y: at.y, z: at.z, yaw: state.yaw, talking: false });
      }
      return drawn;
    },
    act(id, reducedMotion) {
      const state = states.get(id);
      const seconds = state ? helperWave(state, now) : null;
      return seconds === null ? undefined : { arms: gesturePose('wave', seconds, false, reducedMotion), reach: null };
    },
    modes() {
      return HELPER_BOTS.map((bot) => helperMode(stateOf(bot.id)));
    },
    where() {
      return HELPER_BOTS.map((bot) => loopPoint(stateOf(bot.id).arc).at);
    },
    light(robotOf) {
      HELPER_BOTS.forEach((bot, i) => {
        const spot = lamps[i]!;
        const robot = robotOf(bot.id);
        if (!robot?.beacon(at, direction)) {
          spot.intensity = 0;
          return;
        }
        spot.position.copy(at);
        spot.target.position.copy(at).addScaledVector(direction, 10);
        spot.intensity = BEACON.intensity;
      });
    },
    dispose() {
      for (const spot of lamps) {
        scene.remove(spot, spot.target);
        spot.dispose();
      }
    },
  };
}
