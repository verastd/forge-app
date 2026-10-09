/**
 * The helicopter that flies over a head (`placement.flyer`): drawn from
 * shapes, like the football (no asset to load, so it never waits or fails),
 * with spinning rotors, blinking nav lights and a searchlight: a soft cone of
 * light from its nose down to a pool on whatever is below. The searchlight is
 * drawn, not lit: no lamp in the scene, so a lobby full of them costs no more
 * shading than one.
 *
 * Its own frame is one long (nose to +Z, rotor up); `fly` puts it where
 * flyer.ts says, in the frame of whatever it's added to (the head pivot).
 * One set of geometry and materials for every helicopter in the lobby.
 */

import * as THREE from 'three';
import { flightPose, roofAt } from '@forge/lobby';
import type { FlightArea, RoofGrid } from '@forge/lobby';

/** The searchlight's half-angle, radians: how wide its pool is for how far it shines. */
const BEAM_HALF_ANGLE = 0.22;
/** Rotor turns a second (the blur disc does the rest). */
const ROTOR_SPEED = 38;
const TAIL_ROTOR_SPEED = 55;
/** Where the searchlight is, on the nose's belly (the helicopter's own frame). */
const LAMP = new THREE.Vector3(0, -0.15, 0.3);

interface Parts {
  body: THREE.SphereGeometry;
  canopy: THREE.SphereGeometry;
  boom: THREE.CylinderGeometry;
  fin: THREE.BoxGeometry;
  skid: THREE.CylinderGeometry;
  strut: THREE.BoxGeometry;
  mast: THREE.CylinderGeometry;
  blade: THREE.BoxGeometry;
  disc: THREE.CircleGeometry;
  tailBlade: THREE.BoxGeometry;
  lamp: THREE.SphereGeometry;
  beam: THREE.ConeGeometry;
  pool: THREE.CircleGeometry;
  paint: THREE.MeshStandardMaterial;
  stripe: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  blur: THREE.MeshBasicMaterial;
  lampGlass: THREE.MeshBasicMaterial;
  beamLight: THREE.ShaderMaterial;
  poolLight: THREE.ShaderMaterial;
}

let shared: Parts | null = null;
let users = 0;

/** The searchlight's cone: bright at the lamp, fading along it and toward its edges (as seen). */
const BEAM_VERTEX = /* glsl */ `
  varying float vAlong;
  varying float vFacing;
  void main() {
    vAlong = uv.y;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vFacing = abs(dot(n, normalize(-view.xyz)));
    gl_Position = projectionMatrix * view;
  }
`;
const BEAM_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying float vAlong;
  varying float vFacing;
  void main() {
    float fade = pow(vAlong, 1.6) * pow(vFacing, 1.4);
    gl_FragColor = vec4(uColor * fade * uStrength, 1.0);
  }
`;
/** The pool on the roofs: a soft disc, brightest in the middle. */
const POOL_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float glow = smoothstep(1.0, 0.0, r);
    gl_FragColor = vec4(uColor * glow * glow * uStrength, 1.0);
  }
`;
const POOL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

function light(vertexShader: string, fragmentShader: string, strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xfff1d0) }, uStrength: { value: strength } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    // Light adds to what's behind it and leaves its alpha alone: over a see-through canvas (the
    // editor's preview), a dim stretch of beam would otherwise darken the page behind it.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function parts(): Parts {
  if (shared) return shared;
  // The cone's tip at its origin, its open end one down (−Y): scaled to reach, turned to aim.
  const beam = new THREE.ConeGeometry(1, 1, 24, 1, true);
  beam.translate(0, -0.5, 0);
  const pool = new THREE.CircleGeometry(1, 32);
  pool.rotateX(-Math.PI / 2);
  shared = {
    body: new THREE.SphereGeometry(0.5, 20, 14),
    canopy: new THREE.SphereGeometry(0.5, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
    boom: new THREE.CylinderGeometry(0.035, 0.06, 1, 10),
    fin: new THREE.BoxGeometry(0.025, 0.2, 0.12),
    skid: new THREE.CylinderGeometry(0.018, 0.018, 0.62, 8),
    strut: new THREE.BoxGeometry(0.02, 0.12, 0.02),
    mast: new THREE.CylinderGeometry(0.03, 0.03, 0.1, 8),
    blade: new THREE.BoxGeometry(1.15, 0.012, 0.06),
    disc: new THREE.CircleGeometry(0.58, 32),
    tailBlade: new THREE.BoxGeometry(0.01, 0.24, 0.035),
    lamp: new THREE.SphereGeometry(0.05, 10, 8),
    beam,
    pool,
    // A little light of its own: the cave is dark, and the helicopter should read against a city.
    paint: new THREE.MeshStandardMaterial({ name: 'helicopter', color: 0x34507a, emissive: 0x16243a, metalness: 0.45, roughness: 0.32 }),
    stripe: new THREE.MeshStandardMaterial({ name: 'helicopter-stripe', color: 0xe8e4da, emissive: 0x3a3832, metalness: 0.2, roughness: 0.4 }),
    glass: new THREE.MeshStandardMaterial({ name: 'helicopter-glass', color: 0x2a5d8a, emissive: 0x0d2a44, metalness: 0.9, roughness: 0.08 }),
    metal: new THREE.MeshStandardMaterial({ name: 'helicopter-metal', color: 0x8a919c, emissive: 0x1a1d22, metalness: 0.8, roughness: 0.3 }),
    blur: new THREE.MeshBasicMaterial({ color: 0x9aa3b0, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }),
    lampGlass: new THREE.MeshBasicMaterial({ color: 0xfff6dc, toneMapped: false }),
    beamLight: light(BEAM_VERTEX, BEAM_FRAGMENT, 0.7),
    poolLight: light(POOL_VERTEX, POOL_FRAGMENT, 1.1),
  };
  return shared;
}

export interface Helicopter {
  /** Add this to the frame `fly` is given in (the head pivot). */
  readonly root: THREE.Group;
  /** Flies it over `area` at `t` seconds (`phase` round), the searchlight on `grid`'s roofs; reduced: hovering. */
  fly(area: FlightArea, grid: RoofGrid, t: number, phase: number, reduced: boolean): void;
  dispose(): void;
}

/** One navigation light: a glowing dot, its own material (it blinks). */
function navLight(glow: THREE.Texture, color: number, at: [number, number, number], size: number): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glow, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  sprite.position.set(at[0], at[1], at[2]);
  sprite.scale.setScalar(size);
  return sprite;
}

/** A new helicopter; `dispose` when it's gone. `glow` is the soft dot its lights are drawn with. */
export function createHelicopter(glow: THREE.Texture): Helicopter {
  const p = parts();
  users += 1;
  const root = new THREE.Group();
  root.name = 'flyer';
  const craft = new THREE.Group();
  craft.name = 'helicopter';
  root.add(craft);
  craft.rotation.order = 'YXZ';

  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh => new THREE.Mesh(geometry, material);
  const body = mesh(p.body, p.paint);
  body.scale.set(0.36, 0.34, 0.62);
  body.position.set(0, 0, 0.12);
  const canopy = mesh(p.canopy, p.glass);
  canopy.scale.set(0.3, 0.28, 0.36);
  canopy.rotation.x = Math.PI / 2 - 0.35;
  canopy.position.set(0, 0.02, 0.26);
  const stripe = mesh(p.body, p.stripe);
  stripe.scale.set(0.365, 0.07, 0.5);
  stripe.position.set(0, -0.03, 0.1);
  const boom = mesh(p.boom, p.paint);
  boom.rotation.x = Math.PI / 2 - 0.08;
  boom.scale.set(1, 0.52, 1);
  boom.position.set(0, 0.04, -0.4);
  const fin = mesh(p.fin, p.paint);
  fin.position.set(0, 0.12, -0.64);
  fin.rotation.x = -0.25;
  const mast = mesh(p.mast, p.metal);
  mast.position.set(0, 0.21, 0.1);
  craft.add(body, canopy, stripe, boom, fin, mast);
  for (const side of [-1, 1]) {
    const skid = mesh(p.skid, p.metal);
    skid.rotation.x = Math.PI / 2;
    skid.position.set(side * 0.15, -0.24, 0.1);
    craft.add(skid);
    for (const z of [-0.04, 0.24]) {
      const strut = mesh(p.strut, p.metal);
      strut.position.set(side * 0.12, -0.18, z);
      strut.rotation.z = side * 0.35;
      craft.add(strut);
    }
  }
  // The rotors: blades, and a faint disc where they blur.
  const rotor = new THREE.Group();
  rotor.position.set(0, 0.26, 0.1);
  for (const turn of [0, Math.PI / 2]) {
    const blade = mesh(p.blade, p.metal);
    blade.rotation.y = turn;
    rotor.add(blade);
  }
  const disc = mesh(p.disc, p.blur);
  disc.rotation.x = -Math.PI / 2;
  rotor.add(disc);
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.035, 0.12, -0.68);
  for (const turn of [0, Math.PI / 2]) {
    const blade = mesh(p.tailBlade, p.metal);
    blade.rotation.x = turn;
    tailRotor.add(blade);
  }
  craft.add(rotor, tailRotor);
  // The lights: red to port (its left, +X with its nose to +Z), green to starboard, a white tail
  // strobe, a red beacon on top, and the searchlight's lamp.
  const port = navLight(glow, 0xff3030, [0.19, -0.02, 0.1], 0.14);
  const starboard = navLight(glow, 0x30ff70, [-0.19, -0.02, 0.1], 0.14);
  const strobe = navLight(glow, 0xffffff, [0, 0.22, -0.66], 0.2);
  const beacon = navLight(glow, 0xff2020, [0, -0.17, -0.05], 0.18);
  const lampGlow = navLight(glow, 0xfff1d0, [LAMP.x, LAMP.y, LAMP.z], 0.28);
  const lamp = mesh(p.lamp, p.lampGlass);
  lamp.position.copy(LAMP);
  craft.add(port, starboard, strobe, beacon, lampGlow, lamp);

  // The searchlight, in the frame it flies in (it points at the roofs, not along the craft).
  const beam = mesh(p.beam, p.beamLight);
  beam.renderOrder = 2;
  const pool = mesh(p.pool, p.poolLight);
  pool.renderOrder = 2;
  root.add(beam, pool);

  const lampAt = new THREE.Vector3();
  const spotAt = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);

  return {
    root,
    fly(area, grid, t, phase, reduced) {
      // Hovering still (rotors slowly turning) for anyone who'd rather nothing moved.
      const flying = reduced ? 0 : t;
      const pose = flightPose(area, grid, flying, phase);
      craft.position.set(pose.position[0], pose.position[1], pose.position[2]);
      craft.rotation.set(reduced ? 0 : pose.pitch, pose.yaw, reduced ? 0 : -pose.bank);
      craft.scale.setScalar(area.size);
      const spin = reduced ? 0.1 : 1;
      rotor.rotation.y = t * ROTOR_SPEED * spin;
      tailRotor.rotation.x = t * TAIL_ROTOR_SPEED * spin;
      // Blinking: the beacon once a second, the strobe twice in quick succession.
      const beat = t % 1;
      beacon.material.opacity = beat < 0.12 ? 1 : 0.15;
      const flash = t % 1.4;
      strobe.material.opacity = flash < 0.06 || (flash > 0.16 && flash < 0.22) ? 1 : 0;
      // The searchlight: from the lamp to the roofs, a cone just wide enough for its pool.
      craft.updateMatrix();
      lampAt.copy(LAMP).applyMatrix4(craft.matrix);
      const spot = reduced ? [pose.position[0], roofAt(grid, pose.position[0], pose.position[2]), pose.position[2]] : pose.spot;
      spotAt.set(spot[0]!, spot[1]!, spot[2]!);
      aim.subVectors(spotAt, lampAt);
      const reach = Math.max(aim.length(), area.size * 0.2);
      const radius = reach * Math.tan(BEAM_HALF_ANGLE);
      beam.position.copy(lampAt);
      beam.quaternion.setFromUnitVectors(down, aim.normalize());
      beam.scale.set(radius, reach, radius);
      pool.position.set(spotAt.x, spotAt.y + area.size * 0.04, spotAt.z);
      // A slight shimmer, as a real lamp has.
      const shimmer = reduced ? 1 : 0.95 + 0.05 * Math.sin(t * 23 + phase * 7);
      pool.scale.setScalar(radius * 1.35 * shimmer);
    },
    dispose() {
      root.removeFromParent();
      for (const sprite of [port, starboard, strobe, beacon, lampGlow]) sprite.material.dispose();
      users = Math.max(0, users - 1);
      if (users === 0 && shared) {
        const all = shared;
        for (const geometry of [all.body, all.canopy, all.boom, all.fin, all.skid, all.strut, all.mast, all.blade, all.disc, all.tailBlade, all.lamp, all.beam, all.pool]) {
          geometry.dispose();
        }
        for (const material of [all.paint, all.stripe, all.glass, all.metal, all.blur, all.lampGlass, all.beamLight, all.poolLight]) material.dispose();
        shared = null;
      }
    },
  };
}
