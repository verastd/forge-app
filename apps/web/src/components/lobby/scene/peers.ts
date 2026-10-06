/**
 * Other people in the lobby. With robot avatars on (`lobby_avatars`), each is
 * a hovering robot (robot/view.ts) in the look an admin gave them, or their
 * default; otherwise, and always while their robot is still loading, a
 * glowing orb as the prototype drew them. The orb is the loading state: a
 * robot takes over from it with a quick fade and a pop once the shared body
 * is in, so nobody is ever invisible or frozen half-drawn. If the body can't
 * load at all, everyone stays an orb.
 *
 * Each has a point light (pooled: the nearest four) and an HTML name tag
 * above them that brightens as they come within earshot (`nearness`: full
 * within 5 m, gone at 35 m, the voice's own range). Everything comes from the
 * presence feed, read every frame: positions (smoothed a little between
 * packets), headings, names and who is talking, which the feed only says of
 * someone you can hear. Nothing here invents movement or speech: a robot
 * leans, banks and burns its thruster from how its member actually moves.
 *
 * The people panel (VoicePanel.tsx) lists everyone in the room, nearest first
 * with their distance, so nobody who could be listening is invisible:
 * someone whose position hasn't arrived yet gets no orb, and a row reading
 * "joining".
 *
 * Names are untrusted: they go through `sanitizeName` (at most 39 characters,
 * no control or bidi characters) and into the page with `textContent` only.
 */

import * as THREE from 'three';
import { nearness, normalizeYaw, sanitizeName, stepSpring, wrapAngle } from '@forge/lobby';
import type { Spring, Vec3 } from '@forge/lobby';

import type { PeerState } from '../presence/types';
import { CAVE_PALETTE } from './palette';
import type { RobotAssets, RobotBody } from './robot/assets';
import type { AvatarDirectory } from './robot/directory';
import { EYE_DROP, ROBOT_SCALE, TAG_HEIGHT, createRobot } from './robot/view';
import type { RobotView } from './robot/view';

/** CSS module class names the tags use (Lobby.module.css). */
export interface PeerClasses {
  peer: string;
  tag: string;
  talking: string;
}

/** What robots need, when avatars are on. */
export interface PeerRobots {
  assets: RobotAssets;
  directory: AvatarDirectory;
}

export interface Peers {
  /** Draws `peers` for this frame. */
  update(
    dt: number,
    t: number,
    camera: THREE.PerspectiveCamera,
    peers: ReadonlyMap<string, PeerState>,
    reducedMotion: boolean,
  ): void;
  /** How many peers are drawn as robots now (the rest are orbs). */
  robotCount(): number;
  /** Where everyone is drawn now, eye positions: what the local member bumps into. */
  bodies(): readonly Vec3[];
  dispose(): void;
}

const ORB_COLOR = CAVE_PALETTE.accent;
/** Point lights are pooled: a fixed count keeps three.js from recompiling every lit material when someone joins. */
const LIGHT_POOL = 4;
/** Orbs float a little under a visitor's eye height, where the prototype kept them. */
const ORB_DROP = 0.2;
const TAG_LIFT = 0.55;
/** Seconds for an orb to hand over to its robot. */
const HANDOVER = 0.45;
/** The robot's eye height above its root, scaled: its root sits this far under the member's eye. */
const ROBOT_EYE = 0.9 * ROBOT_SCALE + EYE_DROP;

interface PeerView {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  el: HTMLDivElement;
  nameEl: HTMLSpanElement;
  name: string;
  shown: THREE.Vector3;
  phase: number;
  dist: number;
  nearness: number;
  talking: boolean;
  robot: RobotView | null;
  /** The directory version the robot's look was last read at. */
  lookVersion: number;
  /** 0 → 1 as the orb hands over to the robot. */
  handover: number;
  yaw: number;
  lastShown: THREE.Vector3;
  speed: Spring;
  climb: Spring;
  turn: Spring;
}

/** A stable bob phase from the id, so an orb never jumps when it reappears. */
function phaseFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

/** A robot facing along the member's yaw: the asset faces +Z, a yaw of 0 looks down −Z. */
const robotYaw = (yaw: number): number => Math.PI - yaw;

/** easeOutBack: a small overshoot, so a robot arriving reads as a pop. */
const pop = (k: number): number => 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2;

export function createPeers(
  scene: THREE.Scene,
  layer: HTMLElement,
  classes: PeerClasses,
  robots: PeerRobots | null = null,
): Peers {
  const orbCanvas = document.createElement('canvas');
  orbCanvas.width = orbCanvas.height = 64;
  const orbCtx = orbCanvas.getContext('2d');
  if (orbCtx) {
    const g = orbCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    orbCtx.fillStyle = g;
    orbCtx.fillRect(0, 0, 64, 64);
  }
  const orbTexture = new THREE.CanvasTexture(orbCanvas);
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;

  const lights = Array.from({ length: LIGHT_POOL }, () => {
    const light = new THREE.PointLight(ORB_COLOR, 0, 5, 2);
    light.name = 'peer-light';
    scene.add(light);
    return light;
  });

  // The shared body: robots wait for it, and without it everyone stays an orb.
  let body: RobotBody | null = null;
  let disposed = false;
  robots?.assets.body.then(
    (loaded) => {
      if (!disposed) body = loaded;
    },
    (error: unknown) => {
      console.warn('lobby: the robot avatars could not load; showing orbs', error);
    },
  );

  const views = new Map<string, PeerView>();
  const projected = new THREE.Vector3();
  const target = new THREE.Vector3();
  const local = new THREE.Vector3();
  const lightAt = new THREE.Vector3();

  function create(id: string): PeerView {
    const material = new THREE.SpriteMaterial({
      map: orbTexture,
      color: ORB_COLOR,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.name = 'peer';
    sprite.scale.setScalar(0.5);
    scene.add(sprite);

    const el = document.createElement('div');
    el.className = classes.peer;
    const tag = document.createElement('div');
    tag.className = classes.tag;
    const dot = document.createElement('i');
    const nameEl = document.createElement('span');
    // A right-to-left name keeps its own direction (and its beginning) inside the tag.
    nameEl.dir = 'auto';
    tag.append(dot, nameEl);
    el.append(tag);
    el.style.display = 'none';
    layer.append(el);

    return {
      sprite,
      material,
      el,
      nameEl,
      name: '',
      shown: new THREE.Vector3(),
      phase: phaseFor(id),
      dist: Infinity,
      nearness: 0,
      talking: false,
      robot: null,
      lookVersion: -1,
      handover: 0,
      yaw: 0,
      lastShown: new THREE.Vector3(),
      speed: { value: 0, velocity: 0 },
      climb: { value: 0, velocity: 0 },
      turn: { value: 0, velocity: 0 },
    };
  }

  function remove(view: PeerView): void {
    scene.remove(view.sprite);
    view.material.dispose();
    view.robot?.dispose();
    view.el.remove();
  }

  return {
    update(dt, t, camera, peers, reducedMotion) {
      const smoothing = 1 - Math.exp(-dt * 12);
      const width = layer.clientWidth;
      const height = layer.clientHeight;
      const seen = new Set<string>();

      for (const [id, peer] of peers) {
        seen.add(id);
        let view = views.get(id);
        const fresh = !view;
        if (!view) {
          view = create(id);
          views.set(id, view);
        }
        const name = sanitizeName(peer.name);
        if (name !== view.name) {
          view.name = name;
          view.nameEl.textContent = name;
        }
        target.set(peer.x, peer.y, peer.z);
        if (fresh) {
          view.shown.copy(target);
          view.lastShown.copy(target);
          view.yaw = normalizeYaw(peer.yaw);
        } else {
          view.shown.lerp(target, smoothing);
        }
        // The feed's `talking` is speaking and audible to us: nobody shows as talking whom we can't hear.
        view.talking = peer.talking;

        // How they move, smoothed: what a robot leans, banks and thrusts by.
        const step = Math.max(dt, 1e-3);
        const moved = local.subVectors(view.shown, view.lastShown);
        view.lastShown.copy(view.shown);
        const yawStep = wrapAngle(normalizeYaw(peer.yaw) - view.yaw);
        view.yaw = normalizeYaw(view.yaw + yawStep * smoothing);
        stepSpring(view.speed, Math.hypot(moved.x, moved.z) / step, dt, 6);
        stepSpring(view.climb, moved.y / step, dt, 6);
        stepSpring(view.turn, (yawStep * smoothing) / step, dt, 5);

        // A robot, once the body is in: the directory says how this member looks.
        if (robots && body && !view.robot) {
          view.robot = createRobot({ assets: robots.assets, body, glow: orbTexture, blank }, robots.directory.look(id, name));
          view.lookVersion = robots.directory.version;
          scene.add(view.robot.root);
        }
        const { robot } = view;
        if (robot && robots && (view.lookVersion !== robots.directory.version || robot.look.name !== name)) {
          view.lookVersion = robots.directory.version;
          robot.setLook(robots.directory.look(id, name));
        }
        if (robot) {
          view.handover = Math.min(1, view.handover + dt / (reducedMotion ? 0.01 : HANDOVER));
        }

        const bob = reducedMotion ? 0 : Math.sin(t * 1.3 + view.phase) * 0.08;
        view.sprite.position.set(view.shown.x, view.shown.y - ORB_DROP + bob, view.shown.z);
        view.dist = view.shown.distanceTo(camera.position);
        view.nearness = nearness(view.dist);
        const pulse = view.talking && !reducedMotion ? 0.12 * Math.sin(t * 18) : 0;
        view.material.opacity = (0.55 + 0.45 * view.nearness) * (1 - view.handover);
        view.sprite.scale.setScalar((0.4 + 0.2 * view.nearness + pulse) * (1 + 0.6 * view.handover));
        view.sprite.visible = view.handover < 1;

        let tagY = view.sprite.position.y + TAG_LIFT;
        if (robot) {
          robot.root.position.set(view.shown.x, view.shown.y - ROBOT_EYE, view.shown.z);
          const facing = robotYaw(view.yaw);
          robot.root.rotation.y = facing;
          robot.root.scale.setScalar(Math.max(0.001, pop(view.handover)));
          // Where the viewer is, from the robot's own point of view.
          local.copy(camera.position).sub(robot.root.position);
          const bearing = Math.atan2(local.x, local.z) - facing;
          robot.update({
            t,
            dt,
            speed: view.speed.value,
            climb: view.climb.value,
            turnRate: view.turn.value,
            viewerBearing: bearing,
            viewerDistance: view.dist,
            reducedMotion,
            talking: view.talking,
          });
          tagY = robot.root.position.y + TAG_HEIGHT;
        }

        // The name tag, projected above them.
        projected.set(view.shown.x, tagY, view.shown.z).project(camera);
        const onScreen = projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
        view.el.style.display = onScreen ? 'block' : 'none';
        if (onScreen) {
          const x = (projected.x * 0.5 + 0.5) * width;
          const y = (-projected.y * 0.5 + 0.5) * height;
          view.el.style.transform = `translate(-50%,-100%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
          view.el.style.opacity = (0.25 + 0.75 * view.nearness).toFixed(3);
          view.el.style.setProperty('--near', view.nearness.toFixed(3));
          view.el.classList.toggle(classes.talking, view.talking);
        }
      }

      for (const [id, view] of views) {
        if (!seen.has(id)) {
          remove(view);
          views.delete(id);
        }
      }

      // The pooled lights go to the nearest: an orb's own glow, or a rim on a robot in its eye colour.
      const nearest = [...views.values()].sort((a, b) => a.dist - b.dist);
      lights.forEach((light, i) => {
        const view = nearest[i];
        if (!view) {
          light.intensity = 0;
          return;
        }
        if (view.robot && view.handover >= 1) {
          const { root, look } = view.robot;
          lightAt.set(0, 0.75 * ROBOT_SCALE, 0.55).applyEuler(root.rotation).add(root.position);
          light.position.copy(lightAt);
          light.color.set(look.colors.eye);
          light.intensity = 1.4;
        } else {
          light.position.copy(view.sprite.position);
          light.color.set(ORB_COLOR);
          light.intensity = 2;
        }
      });
    },
    bodies() {
      return [...views.values()].map((view) => view.shown);
    },
    robotCount() {
      let count = 0;
      for (const view of views.values()) if (view.robot) count += 1;
      return count;
    },
    dispose() {
      disposed = true;
      for (const view of views.values()) {
        remove(view);
      }
      views.clear();
      for (const light of lights) {
        scene.remove(light);
        light.dispose();
      }
      orbTexture.dispose();
      blank.dispose();
    },
  };
}
