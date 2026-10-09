/**
 * @forge/lobby — the Apps lobby's pure logic (PRD v0.2 §4).
 *
 * The wall's layout, the free-roaming camera and its persistence, the app
 * registry and its safety rules, the page chrome decision, (from
 * presence.ts) the multiplayer packet and name rules, and the voice: Fable's
 * attenuation and acoustics (attenuation.ts, acoustics.ts) and the cave's
 * settings for them (voice.ts), members bumping into each other
 * (collide.ts), fitting a library head to the robot (headFit.ts) and the
 * shared behaviours (behaviors/: the catalog, budgets, entities and the
 * world, ADR-009). No DOM, no three.js and no runtime
 * dependencies (tsconfig.json and eslint.config.mjs enforce it), so the
 * scene, the shell, the presence feeds, the voice engine and next.config.mjs
 * all share one source of truth, and vitest can prove it in Node.
 *
 * Conventions every consumer relies on (axes, the yaw and pitch signs, slot
 * order) are in layout.ts and camera.ts.
 */
export { WALL, isSlotIndex, slotFromIndex, slotIndex, slotPose, validateWall } from './layout.js';
export type { SlotPose, SlotRef, WallSpec } from './layout.js';
export { CAMERA_LIMITS, CAMERA_SPEED, INITIAL_CAMERA, clampCamera, facing, normalizeYaw } from './camera.js';
export type { CameraState } from './camera.js';
export { CAMERA_STORAGE_ITEM, parseCameraState, serializeCameraState } from './storage.js';
export { APPS, appAt, appBySlug, frameOrigin, sandboxFor, validateRegistry } from './registry.js';
export type { AppEntry, AppMedia } from './registry.js';
export { cspWithFrameSrc, framedAppHeaderRules } from './csp.js';
export { chromeModeFor } from './chrome.js';
export type { ChromeMode } from './chrome.js';
export * from './presence.js';
export * from './attenuation.js';
export * from './acoustics.js';
export * from './voice.js';
export * from './avatar.js';
export * from './avatarMotion.js';
export * from './collide.js';
export * from './chase.js';
export * from './actions.js';
export * from './play.js';
export * from './headFit.js';
export * from './behaviors/index.js';
