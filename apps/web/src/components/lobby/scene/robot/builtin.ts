/**
 * Heads the lobby ships with, rather than an admin's uploads: static files in
 * public/lobby/, worn like any library head and loaded by their sha256
 * (assets.ts reads them from here rather than the avatars BFF). Today one:
 * the helper bot's (its gunmetal box with an amber beacon on top), which a
 * helper bot wears until an admin gives it another in the avatar editor.
 *
 * A head is known by its file's sha256, so the same file uploaded to the
 * library is the same head, beacon and all. No three.js here: the avatar
 * editor reads this before its preview's chunk loads.
 */

import { isHelperBot } from '@forge/lobby';
import type { AvatarHead } from '@forge/shared';

import type { BeaconDome } from './beacon';

/** The helper bot's head: Tripo's model as delivered (facing +Z, its origin under the middle of its base). */
export const HELPER_HEAD: Readonly<AvatarHead> = Object.freeze<AvatarHead>({
  id: 'helper-bot',
  name: 'Helper bot',
  sha256: '101782b47216b1cd13f0cebee8af549763969d0b3b408a4f76a30eaa07fe7615',
  bytes: 808_996,
  fit: 'replace',
  eyes: false,
  // The editor's own first fit (@forge/lobby's autoPlacement): its base band the robot's head width, on the
  // neck, with its recessed face closed by the glossy screen. The eyes sit where the model has them painted.
  placement: {
    scale: 0.4112,
    offset: [0, 0, -0.0017],
    eyes: [
      [-0.068, 0.105, 0.1051],
      [0.068, 0.105, 0.1051],
    ],
    eyeAngles: [0, 0, 0],
    eyeScale: 1.25,
    screen: { center: [0, 0.1085, 0.1011], size: [0.235, 0.13] },
  },
  updatedAt: '2026-10-29T00:00:00.000Z',
});

interface BuiltIn {
  url: string;
  /** Its beacon's dome, in the file's own frame (metres): its middle, radius and height. */
  beacon: { center: [number, number, number]; radius: number; height: number } | null;
}

const BUILT_IN: ReadonlyMap<string, BuiltIn> = new Map([
  [HELPER_HEAD.sha256, { url: '/lobby/helper-head.glb', beacon: { center: [0, 0.7, 0.01], radius: 0.18, height: 0.3 } }],
]);

/** Where a built-in head's file is served, by its sha256; null for a library upload. */
export function builtInHeadUrl(sha256: string): string | null {
  return BUILT_IN.get(sha256)?.url ?? null;
}

/** A head's beacon dome as worn (head frame, by its placement's scale), or null if it has none. */
export function headBeacon(head: AvatarHead): BeaconDome | null {
  const beacon = head.fit === 'replace' ? BUILT_IN.get(head.sha256)?.beacon : null;
  if (!beacon) return null;
  const { scale } = head.placement;
  const [x, y, z] = beacon.center;
  return { center: [x * scale, y * scale, z * scale], radius: beacon.radius * scale, height: beacon.height * scale };
}

/** The head `id` wears when nobody has given it one: a helper bot's own, or (null) the robot's. */
export function defaultHead(id: string): AvatarHead | null {
  return isHelperBot(id) ? HELPER_HEAD : null;
}
