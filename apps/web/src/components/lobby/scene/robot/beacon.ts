/**
 * A rotating beacon on a head that has one (builtin.ts says which: the helper
 * bot's amber lamp). Drawn over the model's own dome: a band of light that
 * goes round it as a reflector would, a beam swept round with it, and a glow
 * that flares as the beam comes round to face you. The beam is drawn, not
 * lit; the light it throws on the cave is one real spotlight per bot, which
 * the scene keeps (it reads the beam from `aim`), so a robot appearing never
 * changes how many lights the cave's materials are compiled for.
 *
 * Its frame is the head pivot's (the robot's unscaled head frame, metres);
 * the dome is given in it. With reduced motion it holds still: the dome
 * glows, with no sweep and no beam.
 */

import * as THREE from 'three';

/** Turns a second. */
const SPIN = 1.2;
/** How far below level the beam points, radians: it sweeps the floor round the bot as well as the wall. */
const DIP = 0.16;
/** The beam's half-angle and length (head frame, metres: the robot's scale makes it longer in the cave). */
const BEAM_HALF_ANGLE = 0.2;
const BEAM_LENGTH = 5;

/** Where a dome is, in the head frame: its middle, radius and height. */
export interface BeaconDome {
  center: [number, number, number];
  radius: number;
  height: number;
}

export interface Beacon {
  readonly root: THREE.Group;
  /** Puts it on `dome`. */
  fit(dome: BeaconDome): void;
  /**
   * One frame. `viewerBearing` is where the viewer is from the robot's point of
   * view (radians, > 0 to its left, as robotPose takes it): the glow flares as
   * the beam faces them.
   */
  update(t: number, viewerBearing: number, reducedMotion: boolean): void;
  /** Where the beam starts and which way it points, in the world; false while it isn't shining. */
  aim(at: THREE.Vector3, direction: THREE.Vector3): boolean;
  dispose(): void;
}

/** A band of light round the dome, brightest where the reflector faces (uAngle, about +Y from +Z). */
const BAND_VERTEX = /* glsl */ `
  varying vec3 vLocal;
  varying float vFacing;
  void main() {
    vLocal = position;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-view.xyz)));
    gl_Position = projectionMatrix * view;
  }
`;
const BAND_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAngle;
  uniform float uSweep;
  varying vec3 vLocal;
  varying float vFacing;
  void main() {
    float around = atan(vLocal.x, vLocal.z);
    float lit = pow(max(cos(around - uAngle), 0.0), 6.0) * uSweep;
    float glow = 0.22 + 1.6 * lit;
    gl_FragColor = vec4(uColor * glow * (0.35 + 0.65 * vFacing), 1.0);
  }
`;

/** The beam: bright at the lamp, fading along it and toward its edges (as seen). */
const BEAM_VERTEX = /* glsl */ `
  varying float vAlong;
  varying float vFacing;
  void main() {
    vAlong = uv.y;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-view.xyz)));
    gl_Position = projectionMatrix * view;
  }
`;
const BEAM_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying float vAlong;
  varying float vFacing;
  void main() {
    float fade = pow(vAlong, 2.2) * pow(vFacing, 1.6);
    gl_FragColor = vec4(uColor * fade * uStrength, 1.0);
  }
`;

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export function createBeacon(glow: THREE.Texture, color: THREE.ColorRepresentation): Beacon {
  const tint = new THREE.Color(color);
  const root = new THREE.Group();
  root.name = 'beacon';

  // The band, just proud of the model's dome.
  const bandGeometry = new THREE.CylinderGeometry(1, 1, 1, 40, 1, true);
  const bandMaterial = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: tint }, uAngle: { value: 0 }, uSweep: { value: 1 } },
    vertexShader: BAND_VERTEX,
    fragmentShader: BAND_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const band = new THREE.Mesh(bandGeometry, bandMaterial);
  band.name = 'beacon-band';
  band.renderOrder = 4;
  root.add(band);

  // The beam: a cone along +Z from its tip at the lamp, on a spinner that turns about +Y.
  const spinner = new THREE.Group();
  root.add(spinner);
  const beamGeometry = new THREE.ConeGeometry(Math.tan(BEAM_HALF_ANGLE) * BEAM_LENGTH, BEAM_LENGTH, 28, 1, true);
  // Tip at the origin, opening along +Z (a cone's tip is its +Y end, where uv.y is 1: the beam is brightest there).
  beamGeometry.translate(0, -BEAM_LENGTH / 2, 0);
  beamGeometry.rotateX(-Math.PI / 2);
  const beamMaterial = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: tint }, uStrength: { value: 0.45 } },
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(beamGeometry, beamMaterial);
  beam.name = 'beacon-beam';
  beam.rotation.x = DIP;
  beam.renderOrder = 4;
  beam.frustumCulled = false;
  spinner.add(beam);

  // The flare at the lamp.
  const flareMaterial = new THREE.SpriteMaterial({
    map: glow,
    color: tint,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flare = new THREE.Sprite(flareMaterial);
  flare.renderOrder = 5;
  root.add(flare);

  let size = 0.07;
  let shining = false;
  const forward = new THREE.Vector3();

  return {
    root,
    fit(dome) {
      root.position.fromArray(dome.center);
      size = dome.radius;
      band.scale.set(dome.radius * 1.04, dome.height * 0.86, dome.radius * 1.04);
    },
    update(t, viewerBearing, reducedMotion) {
      const angle = reducedMotion ? 0 : wrap(t * SPIN * Math.PI * 2);
      bandMaterial.uniforms.uAngle!.value = angle;
      bandMaterial.uniforms.uSweep!.value = reducedMotion ? 0 : 1;
      spinner.rotation.y = angle;
      beam.visible = !reducedMotion;
      shining = !reducedMotion;
      // Flares as the beam comes round to face the viewer.
      const facing = reducedMotion ? 0 : Math.pow(Math.max(Math.cos(angle - viewerBearing), 0), 10);
      flare.scale.setScalar(size * (3 + 9 * facing));
      flareMaterial.opacity = 0.35 + 0.65 * facing;
    },
    aim(at, direction) {
      if (!shining || !root.parent) return false;
      beam.updateWorldMatrix(true, false);
      at.setFromMatrixPosition(beam.matrixWorld);
      direction.copy(forward.set(0, 0, 1).transformDirection(beam.matrixWorld));
      return true;
    },
    dispose() {
      root.removeFromParent();
      bandGeometry.dispose();
      bandMaterial.dispose();
      beamGeometry.dispose();
      beamMaterial.dispose();
      flareMaterial.dispose();
    },
  };
}
