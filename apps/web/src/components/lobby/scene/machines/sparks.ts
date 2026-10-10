/**
 * Welding sparks: a burst where a machine's part snaps into place. One pool
 * of points for the whole cave, each spark thrown out and falling, fading
 * from white-hot to orange as it goes.
 */

import * as THREE from 'three';

const POOL = 480;
const LIFE = 0.45;
const GRAVITY = 6;

export interface Sparks {
  /** A burst of `count` sparks at `at` (world), about `size` metres wide. */
  emit(at: THREE.Vector3, count: number, size: number): void;
  update(dt: number): void;
  dispose(): void;
}

export function createSparks(scene: THREE.Scene): Sparks {
  const positions = new Float32Array(POOL * 3);
  const colours = new Float32Array(POOL * 3);
  const velocity = new Float32Array(POOL * 3);
  const age = new Float32Array(POOL).fill(LIFE);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  const material = new THREE.PointsMaterial({
    size: 0.018,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);
  let next = 0;
  let live = 0;
  const hot = new THREE.Color('#fff6d8');
  const cool = new THREE.Color('#ff7a1a');
  const colour = new THREE.Color();

  return {
    emit(at, count, size) {
      for (let i = 0; i < count; i += 1) {
        const k = next;
        next = (next + 1) % POOL;
        if (age[k]! >= LIFE) live += 1;
        age[k] = 0;
        positions[k * 3] = at.x + (Math.random() - 0.5) * size * 0.4;
        positions[k * 3 + 1] = at.y + (Math.random() - 0.5) * size * 0.4;
        positions[k * 3 + 2] = at.z + (Math.random() - 0.5) * size * 0.4;
        const angle = Math.random() * Math.PI * 2;
        const out = 0.3 + Math.random() * 0.9;
        velocity[k * 3] = Math.cos(angle) * out;
        velocity[k * 3 + 1] = 0.4 + Math.random() * 1.2;
        velocity[k * 3 + 2] = Math.sin(angle) * out;
      }
      points.visible = live > 0;
    },
    update(dt) {
      if (live === 0) return;
      live = 0;
      for (let k = 0; k < POOL; k += 1) {
        if (age[k]! >= LIFE) continue;
        age[k] = Math.min(LIFE, age[k]! + dt);
        const t = age[k]! / LIFE;
        velocity[k * 3 + 1] = velocity[k * 3 + 1]! - GRAVITY * dt;
        positions[k * 3] = positions[k * 3]! + velocity[k * 3]! * dt;
        positions[k * 3 + 1] = Math.max(0.01, positions[k * 3 + 1]! + velocity[k * 3 + 1]! * dt);
        positions[k * 3 + 2] = positions[k * 3 + 2]! + velocity[k * 3 + 2]! * dt;
        colour.copy(hot).lerp(cool, t).multiplyScalar(1 - t);
        colours[k * 3] = colour.r;
        colours[k * 3 + 1] = colour.g;
        colours[k * 3 + 2] = colour.b;
        if (age[k]! < LIFE) live += 1;
        else colours.fill(0, k * 3, k * 3 + 3);
      }
      geometry.getAttribute('position').needsUpdate = true;
      geometry.getAttribute('color').needsUpdate = true;
      points.visible = live > 0;
    },
    dispose() {
      scene.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}
