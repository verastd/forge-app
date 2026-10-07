/**
 * The robot body's material: one MeshStandardMaterial for the whole body (one
 * draw call per robot), painted per zone from the `zone` vertex attribute
 * (@forge/lobby's ZONE) with each robot's own uniforms.
 *
 * - shell, trim: the robot's two paints; joints a fixed dark gunmetal.
 * - torso: shell, with the chestplate on its front, lit from within like a
 *   screen so it reads in the dark cave. An uploaded image covers the whole
 *   visible front, bevels and all, stretched to it, and keeps its
 *   transparency: where it is clear the robot's own armour shows. The
 *   generated emblem fills the flat panel, with a thin line of the accent
 *   colour just past its edge, on the bevel. Until an image arrives the
 *   panel shows a moving scan in the accent colour, and the image fades in
 *   over it.
 * - head, headTrim: the robot's own head, with a dark glass face screen
 *   rimmed in the accent; hidden (collapsed into the neck) when the robot
 *   wears a head from the library.
 * - thruster: dark metal glowing in the eye colour, brighter toward the tip
 *   and with the thrust.
 *
 * A faint rim in the eye colour keeps the silhouette readable against the
 * black rock. The panels are found in the bind pose (`position`/`normal`
 * before skinning), so they ride the body however it moves.
 *
 * Every robot's material compiles to the same program (one
 * customProgramCacheKey), so a member joining never costs a shader compile.
 */

import * as THREE from 'three';
import { CHEST_PANEL, FACE_PANEL, ZONE } from '@forge/lobby';
import type { AvatarColors } from '@forge/lobby';

/** The dark gunmetal every robot's joints share. */
export const JOINT_COLOR = 0x2a2e35;

export interface RobotUniforms {
  uShell: { value: THREE.Color };
  uTrim: { value: THREE.Color };
  uJoint: { value: THREE.Color };
  uAccent: { value: THREE.Color };
  uEye: { value: THREE.Color };
  uChest: { value: THREE.Texture | null };
  /** The chest image's width / height. */
  uChestAspect: { value: number };
  /** 0: the loading scan; 1: the image. */
  uChestFade: { value: number };
  /** 1: an uploaded image, over the whole front and with its transparency; 0: the emblem, on the flat panel. */
  uChestFull: { value: number };
  uThrust: { value: number };
  uHideHead: { value: number };
  uTime: { value: number };
  /** Talking: the chest and face glow a little brighter. */
  uTalk: { value: number };
}

const f = (n: number): string => n.toFixed(4);

// The chestplate covers the torso's whole flat front panel.
const chestCentre = [(CHEST_PANEL.minX + CHEST_PANEL.maxX) / 2, (CHEST_PANEL.minY + CHEST_PANEL.maxY) / 2];
const chestHalf = [(CHEST_PANEL.maxX - CHEST_PANEL.minX) / 2, (CHEST_PANEL.maxY - CHEST_PANEL.minY) / 2];
// The torso's whole visible front, bevels included (bind pose): an uploaded chestplate stretches over it.
const CHEST_FRONT = { minX: -0.138, maxX: 0.138, minY: 0.479, maxY: 0.783 } as const;
const faceCentre = [(FACE_PANEL.minX + FACE_PANEL.maxX) / 2, (FACE_PANEL.minY + FACE_PANEL.maxY) / 2];
const faceHalf = [(FACE_PANEL.maxX - FACE_PANEL.minX) / 2 - 0.024, (FACE_PANEL.maxY - FACE_PANEL.minY) / 2 - 0.02];

const VERTEX_HEAD = /* glsl */ `
attribute float zone;
uniform float uHideHead;
varying float vZone;
varying vec3 vBind;
varying vec3 vBindN;
`;

const VERTEX_BODY = /* glsl */ `
#include <begin_vertex>
vZone = zone;
vBind = position;
vBindN = normal;
if (uHideHead > 0.5 && zone > ${f(ZONE.thruster + 0.5)}) {
  // Collapse the robot's own head into its neck: the library head takes its place.
  transformed = vec3(0.0, ${f(FACE_PANEL.minY)}, 0.0);
}
`;

const FRAGMENT_HEAD = /* glsl */ `
uniform vec3 uShell;
uniform vec3 uTrim;
uniform vec3 uJoint;
uniform vec3 uAccent;
uniform vec3 uEye;
uniform sampler2D uChest;
uniform float uChestAspect;
uniform float uChestFade;
uniform float uChestFull;
uniform float uThrust;
uniform float uTime;
uniform float uTalk;
varying float vZone;
varying vec3 vBind;
varying vec3 vBindN;

float robotRoundRect(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const FRAGMENT_COLOR = /* glsl */ `
#include <color_fragment>
int robotZone = int(vZone + 0.5);
float robotRough = 0.4;
float robotMetal = 0.25;
vec3 robotEmit = vec3(0.0);
vec3 robotBase = uShell;
if (robotZone == ${ZONE.trim} || robotZone == ${ZONE.headTrim}) {
  robotBase = uTrim; robotRough = 0.3; robotMetal = 0.55;
} else if (robotZone == ${ZONE.joint}) {
  robotBase = uJoint; robotRough = 0.34; robotMetal = 0.85;
} else if (robotZone == ${ZONE.thruster}) {
  robotBase = uJoint; robotRough = 0.3; robotMetal = 0.8;
  // Brightest at the tip, fading up the cone.
  float tip = 1.0 - smoothstep(0.0, 0.16, vBind.y);
  robotEmit = uEye * (0.25 + 2.4 * tip * tip) * uThrust;
} else if (robotZone == ${ZONE.torso} && vBind.z > 0.05) {
  // Which way this face of the torso looks (flat, from the bind-pose position's derivatives), so the
  // front and its bevels count and the sides, top and bottom do not.
  vec3 flatN = normalize(cross(dFdx(vBind), dFdy(vBind)));
  if (dot(flatN, vBindN) < 0.0) flatN = -flatN;
  float front = smoothstep(0.25, 0.35, flatN.z);
  vec2 p = vBind.xy - vec2(${f(chestCentre[0]!)}, ${f(chestCentre[1]!)});
  vec2 halfSize = vec2(${f(chestHalf[0]!)}, ${f(chestHalf[1]!)});
  float d = robotRoundRect(p, halfSize, 0.012);
  float aa = fwidth(d) * 1.2;
  // The flat panel, and the accent line just outside it, on the bevel.
  float plate = (1.0 - smoothstep(-aa, aa, d)) * front;
  float frame = ((1.0 - smoothstep(-aa, aa, d - 0.004)) * front - plate) * (1.0 - uChestFull);
  vec2 uv = p / (2.0 * halfSize) + 0.5;
  // Loading: a scan sweeping down a dark panel.
  float sweep = fract(uv.y + uTime * 0.55);
  float scan = smoothstep(0.82, 1.0, sweep) * 0.9 + 0.08 * step(0.5, fract(uv.y * 40.0));
  vec3 waiting = vec3(0.012) + uAccent * scan * 0.45;
  // The emblem covers the panel, cropped to it and centred.
  float plateAspect = ${f(chestHalf[0]! / chestHalf[1]!)};
  vec2 scale = uChestAspect > plateAspect ? vec2(plateAspect / uChestAspect, 1.0) : vec2(1.0, uChestAspect / plateAspect);
  vec2 panelUv = (uv - 0.5) * scale + 0.5;
  // An uploaded image is stretched over the whole front, edge to edge, bevels and all.
  vec2 fullUv = (vBind.xy - vec2(${f(CHEST_FRONT.minX)}, ${f(CHEST_FRONT.minY)})) / vec2(${f(CHEST_FRONT.maxX - CHEST_FRONT.minX)}, ${f(CHEST_FRONT.maxY - CHEST_FRONT.minY)});
  vec4 image = texture2D(uChest, uChestFull > 0.5 ? clamp(fullUv, 0.0, 1.0) : panelUv);
  // Where the image is shown: the panel for the emblem; the whole front (its opaque part) for an upload.
  float shown = mix(plate, front * image.a, uChestFull);
  // What lights up: the scan on the panel until the image fades in, then the image where it is shown.
  float lit = mix(plate, shown, uChestFade);
  vec3 screen = mix(waiting, image.rgb, uChestFade);
  robotBase = mix(robotBase, screen * 0.45, lit);
  robotRough = mix(robotRough, 0.14, lit);
  robotMetal = mix(robotMetal, 0.0, lit);
  robotEmit += screen * (0.75 + 0.35 * uTalk) * lit;
  robotBase = mix(robotBase, uAccent * 0.5, frame);
  robotEmit += uAccent * frame * 0.9;
} else if (robotZone == ${ZONE.head} && vBindN.z > 0.55 && vBind.z > 0.09) {
  vec2 p = vBind.xy - vec2(${f(faceCentre[0]!)}, ${f(faceCentre[1]!)});
  float d = robotRoundRect(p, vec2(${f(faceHalf[0]!)}, ${f(faceHalf[1]!)}), 0.03);
  float aa = fwidth(d) * 1.2;
  float glass = 1.0 - smoothstep(-aa, aa, d + 0.005);
  float rim = (1.0 - smoothstep(-aa, aa, d)) - glass;
  robotBase = mix(robotBase, vec3(0.008, 0.01, 0.012), glass);
  robotRough = mix(robotRough, 0.08, glass);
  robotMetal = mix(robotMetal, 0.0, glass);
  robotEmit += uEye * glass * (0.025 + 0.02 * uTalk);
  robotBase = mix(robotBase, uAccent * 0.5, rim);
  robotEmit += uAccent * rim * 0.7;
}
diffuseColor.rgb = robotBase;
`;

const FRAGMENT_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
float robotFacing = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
totalEmissiveRadiance += robotEmit + uEye * pow(1.0 - robotFacing, 3.0) * 0.12;
`;

/** A body material for one robot. Every one shares its program; each has its own uniforms. */
export function createBodyMaterial(envMap: THREE.Texture, placeholder: THREE.Texture): {
  material: THREE.MeshStandardMaterial;
  uniforms: RobotUniforms;
} {
  const uniforms: RobotUniforms = {
    uShell: { value: new THREE.Color() },
    uTrim: { value: new THREE.Color() },
    uJoint: { value: new THREE.Color(JOINT_COLOR) },
    uAccent: { value: new THREE.Color() },
    uEye: { value: new THREE.Color() },
    uChest: { value: placeholder },
    uChestAspect: { value: 1 },
    uChestFade: { value: 0 },
    uChestFull: { value: 0 },
    uThrust: { value: 0.35 },
    uHideHead: { value: 0 },
    uTime: { value: 0 },
    uTalk: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({ envMap, envMapIntensity: 0.55 });
  material.name = 'robot-body';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
      .replace('#include <begin_vertex>', VERTEX_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}`)
      .replace('#include <color_fragment>', FRAGMENT_COLOR)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = robotRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = robotMetal;')
      .replace('#include <emissivemap_fragment>', FRAGMENT_EMISSIVE);
  };
  material.customProgramCacheKey = () => 'forge-robot-body-v1';
  return { material, uniforms };
}

/** Sets a robot's paint. */
export function paint(uniforms: RobotUniforms, colors: AvatarColors): void {
  uniforms.uShell.value.set(colors.shell);
  uniforms.uTrim.value.set(colors.trim);
  uniforms.uAccent.value.set(colors.accent);
  uniforms.uEye.value.set(colors.eye);
}
