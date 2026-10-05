/**
 * Other people in the lobby, drawn as the prototype draws them: a glowing
 * orb with a point light, and an HTML name tag above it that brightens as
 * they come within earshot (`nearness`: full within 5 m, gone at 35 m, the
 * voice's own range). Everything comes from the presence feed, read every
 * frame: positions (smoothed a little between packets), names and who is
 * talking, which the feed only says of someone you can hear. Nothing here
 * invents movement or speech.
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
import { nearness, sanitizeName } from '@forge/lobby';

import type { PeerState } from '../presence/types';
import { CAVE_PALETTE } from './palette';

/** CSS module class names the tags use (Lobby.module.css). */
export interface PeerClasses {
  peer: string;
  tag: string;
  talking: string;
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
  dispose(): void;
}

const ORB_COLOR = CAVE_PALETTE.accent;
/** Point lights are pooled: a fixed count keeps three.js from recompiling every lit material when someone joins. */
const LIGHT_POOL = 4;
/** Orbs float a little under a visitor's eye height, where the prototype kept them. */
const ORB_DROP = 0.2;
const TAG_LIFT = 0.55;

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
}

/** A stable bob phase from the id, so an orb never jumps when it reappears. */
function phaseFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

export function createPeers(scene: THREE.Scene, layer: HTMLElement, classes: PeerClasses): Peers {
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

  const lights = Array.from({ length: LIGHT_POOL }, () => {
    const light = new THREE.PointLight(ORB_COLOR, 0, 5, 2);
    light.name = 'peer-light';
    scene.add(light);
    return light;
  });

  const views = new Map<string, PeerView>();
  const projected = new THREE.Vector3();
  const target = new THREE.Vector3();

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
    };
  }

  function remove(view: PeerView): void {
    scene.remove(view.sprite);
    view.material.dispose();
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
        target.set(peer.x, peer.y - ORB_DROP, peer.z);
        if (fresh) {
          view.shown.copy(target);
        } else {
          view.shown.lerp(target, smoothing);
        }
        const bob = reducedMotion ? 0 : Math.sin(t * 1.3 + view.phase) * 0.08;
        view.sprite.position.set(view.shown.x, view.shown.y + bob, view.shown.z);

        view.dist = view.sprite.position.distanceTo(camera.position);
        view.nearness = nearness(view.dist);
        // The feed's `talking` is speaking and audible to us: nobody shows as talking whom we can't hear.
        view.talking = peer.talking;
        const pulse = view.talking && !reducedMotion ? 0.12 * Math.sin(t * 18) : 0;
        view.material.opacity = 0.55 + 0.45 * view.nearness;
        view.sprite.scale.setScalar(0.4 + 0.2 * view.nearness + pulse);

        // The name tag, projected above the orb.
        projected.copy(view.sprite.position).setY(view.sprite.position.y + TAG_LIFT).project(camera);
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

      // The pooled lights go to the nearest orbs.
      const nearest = [...views.values()].sort((a, b) => a.dist - b.dist);
      lights.forEach((light, i) => {
        const view = nearest[i];
        if (view) {
          light.position.copy(view.sprite.position);
          light.intensity = 2;
        } else {
          light.intensity = 0;
        }
      });
    },
    dispose() {
      for (const view of views.values()) {
        remove(view);
      }
      views.clear();
      for (const light of lights) {
        scene.remove(light);
        light.dispose();
      }
      orbTexture.dispose();
    },
  };
}
