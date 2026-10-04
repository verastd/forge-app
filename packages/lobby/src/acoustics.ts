/**
 * Acoustics: reverb impulse responses, distance muffling, occlusion.
 *
 * Everything here is pure math against Web Audio primitives. The engine owns
 * one shared ConvolverNode (a send/return reverb bus) and each peer gets a
 * dry path plus a wet send into that bus. Realism comes from the ratio: in a
 * real space the direct sound falls off fast with distance while the
 * reverberant field barely does, so far voices turn into mostly echo.
 *
 * FORGE: Fable's module (voice drop 2, lib/voice/acoustics.ts) made pure, so
 * Node can test it: `synthesizeImpulseResponse` renders into two
 * Float32Arrays, which the engine copies into an AudioBuffer, with Fable's
 * algorithm, seed and normalisation unchanged. The 'custom' preset and
 * `loadImpulseResponse` are gone: nothing in FORGE picks an IR URL, and
 * fetching arbitrary URLs is surface the lobby doesn't need (its CSP
 * `connect-src` wouldn't allow it either). `'loading'` stays in
 * `ReverbStatus` so the engine stays a close port; FORGE never enters it.
 */

import { clamp01 } from './attenuation.js';

export type ReverbPreset = 'none' | 'room' | 'cave' | 'hall';

export type ReverbStatus = 'off' | 'generating' | 'loading' | 'ready' | 'failed';

export interface ReverbPresetParams {
  /** RT60: seconds for the tail to fall 60 dB. */
  decay: number;
  /** Silence before the first reflection, seconds. Grows with room size. */
  preDelay: number;
  /** Discrete early reflections as [time s, gain]. */
  earlyReflections: Array<[number, number]>;
  /**
   * One-pole lowpass coefficient applied to the noise tail. 1 = no filtering.
   * Start applies at t = 0, end at t = decay, so highs die faster than lows.
   */
  brightnessStart: number;
  brightnessEnd: number;
  /** Sensible wet level for this space, used when the preset is selected. */
  defaultWet: number;
  label: string;
}

export const REVERB_PRESETS: Record<Exclude<ReverbPreset, 'none'>, ReverbPresetParams> = {
  room: {
    label: 'Small room',
    decay: 0.6,
    preDelay: 0.008,
    earlyReflections: [
      [0.012, 0.5],
      [0.021, 0.35],
      [0.033, 0.25],
    ],
    brightnessStart: 0.8,
    brightnessEnd: 0.3,
    defaultWet: 0.15,
  },
  cave: {
    label: 'Cave',
    decay: 3.4,
    preDelay: 0.028,
    earlyReflections: [
      [0.035, 0.6],
      [0.052, 0.45],
      [0.074, 0.4],
      [0.098, 0.3],
      [0.131, 0.22],
      [0.17, 0.15],
    ],
    brightnessStart: 0.55,
    brightnessEnd: 0.06,
    defaultWet: 0.4,
  },
  hall: {
    label: 'Hall',
    decay: 2.2,
    preDelay: 0.02,
    earlyReflections: [
      [0.025, 0.5],
      [0.041, 0.35],
      [0.06, 0.25],
      [0.085, 0.18],
    ],
    brightnessStart: 0.75,
    brightnessEnd: 0.15,
    defaultWet: 0.3,
  },
};

/**
 * Synthesize a stereo impulse response. Deterministic (seeded LCG) so the
 * same preset sounds identical on every client.
 *
 * FORGE: Fable's `generateImpulseResponse(ctx, p)`, rendering into two
 * Float32Arrays (left, right) at `sampleRate` instead of an AudioBuffer from
 * a context. A Float32Array rounds each write exactly as an AudioBuffer's
 * channel data does, so the samples are Fable's.
 */
export function synthesizeImpulseResponse(sampleRate: number, p: ReverbPresetParams): [Float32Array, Float32Array] {
  const sr = sampleRate;
  const preDelaySamples = Math.floor(p.preDelay * sr);
  const decaySamples = Math.ceil(p.decay * sr);
  const total = preDelaySamples + decaySamples;
  const channels: [Float32Array, Float32Array] = [new Float32Array(total), new Float32Array(total)];

  // Amplitude envelope hits -60 dB (1/1000) at t = decay.
  const k = Math.log(1000) / decaySamples;

  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const data = channels[ch] as Float32Array;
    let seed = (0x9e3779b9 ^ (ch * 0x85ebca6b)) >>> 0;
    let lp = 0;

    for (let i = 0; i < decaySamples; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed / 0xffffffff) * 2 - 1;
      const t = i / decaySamples;
      const coef = p.brightnessStart + (p.brightnessEnd - p.brightnessStart) * t;
      lp += coef * (noise - lp);
      data[preDelaySamples + i] = lp * Math.exp(-k * i);
    }

    // Early reflections: slightly offset and quieter in the right channel for width.
    for (const [time, gain] of p.earlyReflections) {
      const idx = preDelaySamples + Math.floor((time + (ch === 1 ? 0.0013 : 0)) * sr);
      if (idx < total) data[idx] = (data[idx] as number) + gain * (ch === 1 ? 0.9 : 1);
    }

    for (let i = 0; i < total; i++) {
      const a = Math.abs(data[i] as number);
      if (a > peak) peak = a;
    }
  }

  if (peak > 0) {
    const scale = 1 / peak;
    for (const data of channels) {
      for (let i = 0; i < total; i++) data[i] = (data[i] as number) * scale;
    }
  }
  return channels;
}

/**
 * Wet send level for a peer. alpha is 0 inside full-volume distance and 1 at
 * falloff. sqrt makes the reverb fade far slower than the direct path, so the
 * wet/dry ratio climbs with distance.
 */
export function reverbSendGain(alpha: number, wet: number): number {
  const a = clamp01(alpha);
  if (a >= 1) return 0;
  return clamp01(wet) * Math.sqrt(1 - a);
}

const CUTOFF_NEAR_HZ = 18000;
const CUTOFF_FAR_HZ = 1800;
const CUTOFF_FLOOR_HZ = 300;

/**
 * Lowpass cutoff for air absorption (distance) and occlusion (something
 * between the speaker and listener). Log interpolation so it feels even.
 */
export function lowpassCutoff(alpha: number, occlusion: number, distanceMuffling: boolean): number {
  const a = distanceMuffling ? clamp01(alpha) : 0;
  const base = CUTOFF_NEAR_HZ * Math.pow(CUTOFF_FAR_HZ / CUTOFF_NEAR_HZ, a);
  return Math.max(CUTOFF_FLOOR_HZ, base * (1 - 0.85 * clamp01(occlusion)));
}

/** Occlusion kills the direct path hard but leaves most of the reverberant field. */
export function occlusionDryGain(occlusion: number): number {
  return 1 - 0.7 * clamp01(occlusion);
}

export function occlusionWetGain(occlusion: number): number {
  return 1 - 0.3 * clamp01(occlusion);
}
