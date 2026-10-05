/**
 * Proximity attenuation math.
 *
 * Mirrors the model Epic exposes in UEFN Island Settings for proximity chat:
 *   - Full Volume Distance: speaker is heard at 1.0 gain up to this radius (Epic default 5 m)
 *   - Falloff Distance: gain reaches 0 here (Epic default 35 m)
 *   - Attenuation Function: Linear | Log Reverse | Natural Sound
 *
 * The three curves are Unreal's EAttenuationDistanceModel evaluated over
 * alpha = (d - full) / (falloff - full), clamped to [0, 1].
 *
 * FORGE: Fable's module (voice drop 2, lib/voice/attenuation.ts) without its
 * float32 position codec, since the lobby keeps its own validated 9-byte
 * packet (presence.ts). `listenerSpace` is FORGE's: the cave has a heading,
 * and `relativePosition` ignores which way the listener faces.
 */

export type Vec3 = { x: number; y: number; z: number };

export type AttenuationCurve = 'linear' | 'logReverse' | 'natural';

export interface AttenuationParams {
  /** Radius at which gain is still 1.0. */
  fullVolumeDistance: number;
  /** Radius at which gain hits 0. Must be > fullVolumeDistance. */
  falloffDistance: number;
  curve: AttenuationCurve;
  /** Only used by the 'natural' curve. Unreal default is -60 dB at max distance. */
  naturalDbAtMax?: number;
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// FORGE: NaN is 0 here, where Fable's let it through. Every gain, send and
// cutoff goes through this, and one NaN in an AudioParam's setTargetAtTime
// throws: a NaN occlusion or alpha now counts as none.
export function clamp01(v: number): number {
  return !(v > 0) ? 0 : v > 1 ? 1 : v;
}

/** 0 inside the full-volume radius, 1 at (and beyond) the falloff radius. */
export function distanceAlpha(d: number, fullVolumeDistance: number, falloffDistance: number): number {
  const span = falloffDistance - fullVolumeDistance;
  if (span <= 0) return d <= fullVolumeDistance ? 0 : 1;
  return clamp01((d - fullVolumeDistance) / span);
}

/** Evaluate an Unreal-style attenuation curve. Returns gain in [0, 1]. */
export function evalCurve(alpha: number, curve: AttenuationCurve, naturalDbAtMax = -60): number {
  const a = clamp01(alpha);
  if (a >= 1) return 0;
  switch (curve) {
    case 'linear':
      return 1 - a;
    case 'logReverse':
      // UE: 1 + 0.5 * ln(1 - alpha). Stays near 1 for a long time then drops hard.
      return clamp01(1 + 0.5 * Math.log(1 - a));
    case 'natural':
      // UE NaturalSound: 10^((alpha * dBAtMax) / 20). Perceptually even fade.
      return clamp01(Math.pow(10, (a * naturalDbAtMax) / 20));
    default:
      return 1 - a;
  }
}

/** Gain for a speaker at distance d from the listener. */
export function computeGain(d: number, p: AttenuationParams): number {
  if (d <= p.fullVolumeDistance) return 1;
  if (d >= p.falloffDistance) return 0;
  return evalCurve(distanceAlpha(d, p.fullVolumeDistance, p.falloffDistance), p.curve, p.naturalDbAtMax);
}

/**
 * Subscription decision with hysteresis.
 *
 * Subscribing costs a renegotiation with the SFU, so we do not want a peer
 * oscillating at the falloff edge to thrash. We subscribe when they come inside
 * falloff + margin and only drop them once they are past falloff + 2 * margin.
 *
 * d === null means we have no position for that peer yet; treat as out of range.
 */
export function shouldSubscribe(
  d: number | null,
  p: AttenuationParams,
  margin: number,
  currentlySubscribed: boolean,
): boolean {
  if (d === null) return false;
  if (currentlySubscribed) return d <= p.falloffDistance + margin * 2;
  return d <= p.falloffDistance + margin;
}

/** Relative position of a peer from the listener, for a Web Audio PannerNode. */
export function relativePosition(listener: Vec3, peer: Vec3): Vec3 {
  return { x: peer.x - listener.x, y: peer.y - listener.y, z: peer.z - listener.z };
}

/**
 * Where a peer is from the listener's point of view, for a PannerNode under
 * a Web Audio listener left at its default orientation (looking down −Z,
 * +Y up, so +X is to the right): the peer's offset rotated by the
 * listener's heading. The lobby's yaw is 0 looking down −Z and grows turning
 * right, toward +X (camera.ts), so whichever way the listener faces, a peer
 * on their right comes out at +x and a peer ahead at −z. Height is left as
 * it is: a visitor's head doesn't pitch for sound.
 */
export function listenerSpace(listener: Vec3 & { yaw: number }, peer: Vec3): Vec3 {
  const dx = peer.x - listener.x;
  const dz = peer.z - listener.z;
  const cos = Math.cos(listener.yaw);
  const sin = Math.sin(listener.yaw);
  return { x: cos * dx + sin * dz, y: peer.y - listener.y, z: cos * dz - sin * dx };
}
