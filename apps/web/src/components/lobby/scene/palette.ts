/**
 * The cave's colours, for three.js: FORGE's own amber, from globals.css's
 * --accent family. The same values as the custom properties at the top of
 * Lobby.module.css (`.root`'s --cave-accent, --cave-line, --cave-text and
 * --cave-ink-rgb), which the page's own parts of the cave use: keep the two
 * in step. Every colour the scene draws with comes from here, except a lit
 * screen's own media and the light it throws (screen.ts), which are the
 * screen's.
 */

import * as THREE from 'three';

export const CAVE_PALETTE = {
  /** The hologram (the grid of slots, an empty slot's readout), the people's orbs and their lights: --cave-accent, the brand's --accent. */
  accent: 0xffc23d,
  /** Lines and borders: --cave-line (--accent-hover). */
  line: 0xffd36e,
  /** Text: --cave-text, a pale amber. */
  text: 0xffe8b8,
  /** Panel backgrounds: --cave-ink-rgb, a warm near-black (--accent-ink). */
  ink: 0x1c1402,
  /** The light an empty slot's readout throws on the rock behind it. */
  glow: 0xffc23d,
  /** The faint fill that keeps the rock from black. */
  ambient: 0xffc23d,
} as const;

/**
 * A palette colour for the cave's own shaders (the grid and an empty slot's
 * readout). They write their colour to the screen as it is, with no
 * linear-to-sRGB step at the end (three.js's colour management only reaches
 * its built-in materials), so they take the sRGB value as it is too: the wall
 * then reads as the brand's own #ffc23d. Converted the managed way, it would
 * land a much deeper orange, about #ff890c.
 */
export function shaderColor(hex: number): THREE.Color {
  return new THREE.Color().setRGB(
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
    THREE.LinearSRGBColorSpace,
  );
}
