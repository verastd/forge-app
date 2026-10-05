/**
 * The avatar editor's preview: one robot on a turntable, lit like a studio
 * (a key, a cool fill and a warm rim over the robots' own environment map),
 * on the site's dark background. It turns by itself, and a drag turns it by
 * hand (it resumes turning a moment after). "Flying" plays the flight pose
 * the lobby shows when its member moves.
 *
 * It reports its own state so the page can show it: 'loading' until the body
 * is in (and while a head or chest image is on its way), 'ready', or 'error'
 * (the page then builds a new preview on a new canvas). Uses the same assets, material, eyes and motion as the
 * lobby, so what the admin sees is what everyone will see.
 */

import * as THREE from 'three';

import { createRobotAssets } from './assets';
import type { RobotAssets, RobotBody } from './assets';
import { ROBOT_SCALE, createRobot } from './view';
import type { RobotLook, RobotView } from './view';

export type PreviewState = 'loading' | 'ready' | 'error';

export interface RobotPreview {
  setLook(look: RobotLook): void;
  /** The chestplate's loading scan while an upload is on its way. */
  holdChest(loading: boolean): void;
  setFlying(flying: boolean): void;
  dispose(): void;
}

export function createRobotPreview(
  canvas: HTMLCanvasElement,
  onState: (state: PreviewState) => void,
  reducedMotion = false,
): RobotPreview {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  camera.position.set(0, 0.8 * ROBOT_SCALE, 3.7);
  camera.lookAt(0, 0.56 * ROBOT_SCALE, 0);

  scene.add(new THREE.HemisphereLight(0x9fb4d8, 0x0a0d14, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2.5, 4, 3.5);
  const rim = new THREE.DirectionalLight(0xffc23d, 1.2);
  rim.position.set(-3, 2.5, -3);
  const fill = new THREE.DirectionalLight(0x7aa2ff, 0.45);
  fill.position.set(-3, 1, 2);
  scene.add(key, rim, fill);

  // A soft pool of light under the robot, so it reads as standing in a place.
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = floorCanvas.height = 128;
  const ctx = floorCanvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,194,61,0.22)');
    g.addColorStop(1, 'rgba(255,194,61,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  const floorTexture = new THREE.CanvasTexture(floorCanvas);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 2.4),
    new THREE.MeshBasicMaterial({ map: floorTexture, transparent: true, depthWrite: false }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.05;
  scene.add(floor);

  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 64;
  const gctx = glowCanvas.getContext('2d');
  if (gctx) {
    const g = gctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    gctx.fillStyle = g;
    gctx.fillRect(0, 0, 64, 64);
  }
  const glow = new THREE.CanvasTexture(glowCanvas);
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;

  const assets: RobotAssets = createRobotAssets(renderer);
  let robot: RobotView | null = null;
  let body: RobotBody | null = null;
  let look: RobotLook | null = null;
  let holding = false;
  let flying = false;
  let state: PreviewState | null = null;
  let disposed = false;

  const report = (next: PreviewState): void => {
    if (next !== state) {
      state = next;
      onState(next);
    }
  };

  /** The robot, once there is both a body and a look to give it. */
  const ensureRobot = (): void => {
    if (robot || !body || !look) return;
    robot = createRobot({ assets, body, glow, blank }, look);
    robot.holdChest(holding);
    scene.add(robot.root);
  };

  const load = (): void => {
    report('loading');
    assets.body.then(
      (loaded) => {
        if (disposed) return;
        body = loaded;
        ensureRobot();
      },
      () => {
        if (!disposed) report('error');
      },
    );
  };
  load();

  // Turntable, with a drag to turn it by hand.
  let spin = 0.5;
  let dragging = false;
  let lastX = 0;
  let idleSince = 0;
  const onDown = (event: PointerEvent): void => {
    dragging = true;
    lastX = event.clientX;
    canvas.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent): void => {
    if (!dragging) return;
    spin += (event.clientX - lastX) * 0.01;
    lastX = event.clientX;
  };
  const onUp = (event: PointerEvent): void => {
    dragging = false;
    idleSince = performance.now();
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  let raf = 0;
  let last = performance.now();
  let t = 0;
  let speed = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    t += dt;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width > 0 && height > 0 && (canvas.width !== Math.round(width * renderer.getPixelRatio()) || canvas.height !== Math.round(height * renderer.getPixelRatio()))) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    if (!dragging && !reducedMotion && now - idleSince > 1500) spin += dt * 0.35;
    speed += ((flying ? 5 : 0) - speed) * (1 - Math.exp(-dt * 3));
    if (robot) {
      robot.root.rotation.y = spin;
      robot.update({
        t,
        dt,
        speed,
        climb: 0,
        turnRate: 0,
        viewerBearing: 0,
        viewerDistance: 99,
        reducedMotion,
        talking: false,
      });
      report(robot.state);
    }
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  return {
    setLook(next) {
      look = next;
      if (robot) robot.setLook(next);
      else ensureRobot();
    },
    holdChest(loading) {
      holding = loading;
      robot?.holdChest(loading);
    },
    setFlying(next) {
      flying = next;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      robot?.dispose();
      assets.dispose();
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      floorTexture.dispose();
      glow.dispose();
      blank.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
