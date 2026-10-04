/**
 * The cave's colours, for three.js: every colour the scene draws with comes
 * from here, except a lit screen's own media and the light it throws
 * (screen.ts), which are the screen's.
 *
 * Kept in step with the custom properties at the top of Lobby.module.css,
 * which the page's own parts of the cave (the HUD, the tags, Exit) use.
 */

import * as THREE from 'three';

export const CAVE_PALETTE = {
  /** The hologram: the grid of slots, a slot's readout, the people's orbs and their lights. */
  accent: 0xc4ff4a,
  /** The light an empty slot's readout throws on the rock behind it. */
  glow: 0xc4ff4a,
  /** The faint fill that keeps the rock from black. */
  ambient: 0xc4ff4a,
} as const;

/**
 * A palette colour for the cave's own shaders (the grid and a slot's
 * readout), as three.js's colour management gives it to them.
 */
export function shaderColor(hex: number): THREE.Color {
  return new THREE.Color(hex);
}
