/**
 * A chestplate that is a short clip: what a clip may be (checked in the
 * editor, where the browser has just read it), and when one plays in the
 * lobby (near enough to see it, never with reduced motion: far off, or for
 * someone who'd rather nothing moved, it holds its frame). Pure and
 * deterministic like the rest of the package: no DOM, no three.js.
 */

/** A chestplate clip's limits (@forge/shared's AVATAR_CHEST_VIDEO_*), and how near it plays. Frozen. */
export const CHEST_VIDEO = Object.freeze({
  types: Object.freeze(['video/mp4', 'video/webm'] as const),
  /** Its most, decoded: its base64 stays under a 4.5 MB request. */
  maxBytes: 3 * 1024 * 1024,
  /** Its longest, seconds: it loops. */
  maxSeconds: 15,
  /** Its widest or tallest, pixels. */
  maxPixels: 1280,
  /** It plays when the viewer is within this many metres of the robot. */
  playDistance: 14,
});

/** What the browser read of a clip. */
export interface ChestClip {
  type: string;
  bytes: number;
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
}

/** Why a clip can't be a chestplate, and the numbers that say so; null when it can. */
export type ChestVideoProblem =
  | { reason: 'type' }
  | { reason: 'unreadable' }
  | { reason: 'too_big'; bytes: number; max: number }
  | { reason: 'too_long'; seconds: number; max: number }
  | { reason: 'too_many_pixels'; width: number; height: number; max: number };

/** Whether `clip` can be a chestplate; if not, why. */
export function chestVideoProblem(clip: ChestClip): ChestVideoProblem | null {
  if (!(CHEST_VIDEO.types as readonly string[]).includes(clip.type)) return { reason: 'type' };
  if (clip.bytes > CHEST_VIDEO.maxBytes) return { reason: 'too_big', bytes: clip.bytes, max: CHEST_VIDEO.maxBytes };
  const sized = [clip.width, clip.height, clip.duration].every((v) => Number.isFinite(v) && v > 0);
  if (!sized) return { reason: 'unreadable' };
  if (clip.duration > CHEST_VIDEO.maxSeconds) return { reason: 'too_long', seconds: clip.duration, max: CHEST_VIDEO.maxSeconds };
  if (clip.width > CHEST_VIDEO.maxPixels || clip.height > CHEST_VIDEO.maxPixels) {
    return { reason: 'too_many_pixels', width: clip.width, height: clip.height, max: CHEST_VIDEO.maxPixels };
  }
  return null;
}

/** Whether a chestplate clip should be playing for a viewer this far away (metres). */
export function chestPlays(input: { viewerDistance: number; reducedMotion: boolean }): boolean {
  return !input.reducedMotion && Number.isFinite(input.viewerDistance) && input.viewerDistance <= CHEST_VIDEO.playDistance;
}
