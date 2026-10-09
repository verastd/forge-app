/**
 * The football: a prolate leather ball with white laces, drawn from shapes
 * (no asset to load, so it never waits or fails). Its long axis is +Y and
 * it's BALL.length × BALL.radius in world metres. One geometry and material
 * for every ball in the lobby.
 */

import * as THREE from 'three';
import { BALL } from '@forge/lobby';

let shared: { body: THREE.LatheGeometry; lace: THREE.BoxGeometry; leather: THREE.MeshStandardMaterial; white: THREE.MeshStandardMaterial } | null = null;
let users = 0;

function parts(): NonNullable<typeof shared> {
  if (shared) return shared;
  // The profile of half a football, tip to tip: a sine bulge, a touch pointed.
  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const k = i / 24;
    const y = (k * 2 - 1) * BALL.length;
    points.push(new THREE.Vector2(Math.max(0.004, BALL.radius * Math.pow(Math.sin(Math.PI * k), 0.85)), y));
  }
  shared = {
    body: new THREE.LatheGeometry(points, 28),
    lace: new THREE.BoxGeometry(0.03, 0.006, 0.006),
    // A little light of its own: the cave is dark, and a ball you can't see is no game.
    leather: new THREE.MeshStandardMaterial({ name: 'football', color: 0xb5652e, emissive: 0x5a2a10, roughness: 0.55, metalness: 0.02 }),
    white: new THREE.MeshStandardMaterial({ name: 'football-laces', color: 0xf4efe6, emissive: 0x8a8680, roughness: 0.5 }),
  };
  return shared;
}

/** A new football; `disposeBall` when it's gone. */
export function createBall(): THREE.Group {
  const { body, lace, leather, white } = parts();
  users += 1;
  const ball = new THREE.Group();
  ball.name = 'football';
  ball.add(new THREE.Mesh(body, leather));
  // The laces: a seam along the top, with stitches across it.
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.1, 0.004), white);
  seam.position.set(0, 0, BALL.radius * 0.98);
  ball.add(seam);
  for (let i = -3; i <= 3; i += 1) {
    const stitch = new THREE.Mesh(lace, white);
    stitch.position.set(0, i * 0.014, BALL.radius * 0.99);
    ball.add(stitch);
  }
  return ball;
}

/** Takes a ball out of the scene; the shared parts go with the last one. */
export function disposeBall(ball: THREE.Group): void {
  ball.removeFromParent();
  ball.traverse((object) => {
    const mesh = object as THREE.Mesh;
    // Only the seam's geometry is the ball's own.
    if (mesh.isMesh && mesh.geometry.type === 'BoxGeometry' && mesh.geometry !== shared?.lace) mesh.geometry.dispose();
  });
  users = Math.max(0, users - 1);
  if (users === 0 && shared) {
    shared.body.dispose();
    shared.lace.dispose();
    shared.leather.dispose();
    shared.white.dispose();
    shared = null;
  }
}
