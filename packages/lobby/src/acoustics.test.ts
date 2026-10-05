import { describe, expect, it } from 'vitest';

import {
  REVERB_PRESETS,
  lowpassCutoff,
  occlusionDryGain,
  occlusionWetGain,
  reverbSendGain,
  synthesizeImpulseResponse,
} from './acoustics.js';
import type { ReverbPresetParams } from './acoustics.js';

const SR = 48_000;
const CAVE = REVERB_PRESETS.cave;
/** Rendered once and shared: about 165 000 samples a channel. */
const [LEFT, RIGHT] = synthesizeImpulseResponse(SR, CAVE);
const PRE_DELAY = Math.floor(CAVE.preDelay * SR);
const DECAY = Math.ceil(CAVE.decay * SR);

function peakOf(...channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  }
  return peak;
}

/** The smoothed envelope: RMS over a 50 ms window centred on `seconds`, in dB against full scale. */
function envelopeDb(channel: Float32Array, seconds: number): number {
  const from = Math.floor((seconds - 0.025) * SR);
  const to = Math.floor((seconds + 0.025) * SR);
  let sum = 0;
  for (let i = from; i < to; i++) sum += (channel[i] as number) ** 2;
  return 20 * Math.log10(Math.sqrt(sum / (to - from)));
}

/** Sign changes per sample over [from, to). */
function zeroCrossingRate(channel: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if ((channel[i - 1] as number) < 0 !== (channel[i] as number) < 0) crossings += 1;
  }
  return crossings / (to - from - 1);
}

function correlation(a: Float32Array, b: Float32Array): number {
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < a.length; i++) {
    meanA += a[i] as number;
    meanB += b[i] as number;
  }
  meanA /= a.length;
  meanB /= b.length;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = (a[i] as number) - meanA;
    const y = (b[i] as number) - meanB;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return ab / Math.sqrt(aa * bb);
}

describe('REVERB_PRESETS', () => {
  it("keeps Fable's room, cave and hall, and no custom IR", () => {
    expect(Object.keys(REVERB_PRESETS).sort()).toEqual(['cave', 'hall', 'room']);
    expect(CAVE).toMatchObject({ label: 'Cave', decay: 3.4, preDelay: 0.028, brightnessStart: 0.55, brightnessEnd: 0.06, defaultWet: 0.4 });
    expect(CAVE.earlyReflections).toHaveLength(6);
  });
});

describe('synthesizeImpulseResponse', () => {
  it('is deterministic: the same arrays every time, so every client hears the same cave', () => {
    const [left, right] = synthesizeImpulseResponse(SR, CAVE);
    expect(left.length).toBe(LEFT.length);
    expect(left.every((sample, i) => sample === LEFT[i])).toBe(true);
    expect(right.every((sample, i) => sample === RIGHT[i])).toBe(true);
    // Two different channels, not one copied.
    expect(left.every((sample, i) => sample === RIGHT[i])).toBe(false);
  });

  it('is pre-delay plus decay samples long, silent before the pre-delay', () => {
    expect(LEFT).toBeInstanceOf(Float32Array);
    expect(LEFT.length).toBe(PRE_DELAY + DECAY);
    expect(RIGHT.length).toBe(LEFT.length);
    // (0.028 + 3.4) s at 48 kHz.
    expect(LEFT.length).toBe(164_544);
    expect(LEFT.subarray(0, PRE_DELAY).every((sample) => sample === 0)).toBe(true);
    expect(RIGHT.subarray(0, PRE_DELAY).every((sample) => sample === 0)).toBe(true);
    expect(LEFT[PRE_DELAY]).not.toBe(0);
  });

  it('is normalised so its peak, across both channels, is 1', () => {
    expect(peakOf(LEFT, RIGHT)).toBeCloseTo(1, 6);
  });

  it('adds each early reflection at its time after the pre-delay, 1.3 ms later and at 0.9 of its gain on the right', () => {
    // The same seed makes the same noise, so away from the reflections a
    // render without them differs from this one only by its normalisation.
    const [dryLeft, dryRight] = synthesizeImpulseResponse(SR, { ...CAVE, earlyReflections: [] });
    const scale = (dryLeft[PRE_DELAY + 10] as number) / (LEFT[PRE_DELAY + 10] as number);
    const added = (wet: Float32Array, dry: Float32Array): number[] =>
      Array.from(wet, (sample, i) => sample * scale - (dry[i] as number));
    const spikes = (signal: number[]): number[] =>
      signal.flatMap((value, i) => (Math.abs(value) > 1e-3 ? [i] : []));
    const left = added(LEFT, dryLeft);
    const right = added(RIGHT, dryRight);

    const leftAt = CAVE.earlyReflections.map(([time]) => PRE_DELAY + Math.floor(time * SR));
    const rightAt = CAVE.earlyReflections.map(([time]) => PRE_DELAY + Math.floor((time + 0.0013) * SR));
    expect(spikes(left)).toEqual(leftAt);
    expect(spikes(right)).toEqual(rightAt);
    const first = left[leftAt[0] as number] as number;
    CAVE.earlyReflections.forEach(([, gain], k) => {
      const onLeft = left[leftAt[k] as number] as number;
      expect(onLeft / first).toBeCloseTo(gain / 0.6, 4);
      expect((right[rightAt[k] as number] as number) / onLeft).toBeCloseTo(0.9, 4);
    });
  });

  it('decays to −60 dB or lower by 3.2 s, on a smoothed envelope', () => {
    expect(envelopeDb(LEFT, 0.5)).toBeGreaterThan(-30);
    expect(envelopeDb(LEFT, 3.2)).toBeLessThanOrEqual(-60);
    expect(envelopeDb(RIGHT, 3.2)).toBeLessThanOrEqual(-60);
    // Steadily: each half second quieter than the one before.
    for (let t = 1; t <= 3; t += 0.5) {
      expect(envelopeDb(LEFT, t)).toBeLessThan(envelopeDb(LEFT, t - 0.5));
    }
  });

  it('darkens: the tail’s zero-crossing rate falls from the first third to the last', () => {
    const third = Math.floor(DECAY / 3);
    for (const channel of [LEFT, RIGHT]) {
      const first = zeroCrossingRate(channel, PRE_DELAY, PRE_DELAY + third);
      const last = zeroCrossingRate(channel, channel.length - third, channel.length);
      expect(first).toBeGreaterThan(0.3);
      expect(last).toBeLessThan(first * 0.6);
    }
  });

  it('decorrelates left and right', () => {
    expect(Math.abs(correlation(LEFT, RIGHT))).toBeLessThan(0.05);
  });

  it('renders every preset at any sample rate, each normalised', () => {
    for (const preset of Object.values(REVERB_PRESETS)) {
      for (const rate of [22_050, 44_100]) {
        const [left, right] = synthesizeImpulseResponse(rate, preset);
        expect(left.length).toBe(Math.floor(preset.preDelay * rate) + Math.ceil(preset.decay * rate));
        expect(peakOf(left, right)).toBeCloseTo(1, 6);
      }
    }
  });

  it('drops an early reflection that would land past the end', () => {
    const short: ReverbPresetParams = { ...REVERB_PRESETS.room, decay: 0.01 };
    const [left, right] = synthesizeImpulseResponse(SR, short);
    expect(left.length).toBe(Math.floor(short.preDelay * SR) + Math.ceil(0.01 * SR));
    // Only the noise is left, normalised.
    expect(peakOf(left, right)).toBeCloseTo(1, 6);
  });

  it('leaves silence silent rather than dividing by a zero peak', () => {
    const [left, right] = synthesizeImpulseResponse(SR, { ...CAVE, decay: 0, earlyReflections: [] });
    expect(left.length).toBe(PRE_DELAY);
    expect(peakOf(left, right)).toBe(0);
  });
});

describe('reverbSendGain', () => {
  it('is the wet level close by, falling as √(1 − alpha) to 0 at falloff', () => {
    expect(reverbSendGain(0, 0.3)).toBe(0.3);
    expect(reverbSendGain(0.5, 0.3)).toBeCloseTo(0.3 * Math.sqrt(0.5), 12);
    expect(reverbSendGain(0.75, 0.4)).toBeCloseTo(0.2, 12);
    expect(reverbSendGain(1, 0.3)).toBe(0);
    expect(reverbSendGain(1.5, 0.3)).toBe(0);
    expect(reverbSendGain(-1, 0.3)).toBe(0.3);
  });

  it('clamps the wet level', () => {
    expect(reverbSendGain(0, 2)).toBe(1);
    expect(reverbSendGain(0, -1)).toBe(0);
  });

  it('fades slower than the direct path, so a far voice is mostly reverb', () => {
    // At alpha 0.75 the natural curve at −40 dB is down to 10^(−1.5) ≈ 0.03; the send is still 0.15.
    expect(reverbSendGain(0.75, 0.3) / 0.3).toBeCloseTo(0.5, 12);
  });
});

describe('lowpassCutoff', () => {
  it('slides from 18 kHz close by to 1.8 kHz at falloff, on a log scale', () => {
    expect(lowpassCutoff(0, 0, true)).toBe(18_000);
    expect(lowpassCutoff(1, 0, true)).toBeCloseTo(1_800, 9);
    // Halfway is the geometric mean.
    expect(lowpassCutoff(0.5, 0, true)).toBeCloseTo(Math.sqrt(18_000 * 1_800), 9);
    expect(lowpassCutoff(2, 0, true)).toBeCloseTo(1_800, 9);
  });

  it('without distance muffling stays open whatever the distance', () => {
    expect(lowpassCutoff(0.8, 0, false)).toBe(18_000);
  });

  it('closes further with occlusion, down to a 300 Hz floor', () => {
    expect(lowpassCutoff(0, 1, true)).toBeCloseTo(18_000 * 0.15, 9);
    expect(lowpassCutoff(0, 0.5, false)).toBeCloseTo(18_000 * (1 - 0.425), 9);
    expect(lowpassCutoff(1, 1, true)).toBe(300);
    expect(lowpassCutoff(1, 3, true)).toBe(300);
  });
});

describe('occlusion gains', () => {
  it('cut the direct path hard and the reverb only a little', () => {
    expect(occlusionDryGain(0)).toBe(1);
    expect(occlusionDryGain(1)).toBeCloseTo(0.3, 12);
    expect(occlusionDryGain(0.5)).toBeCloseTo(0.65, 12);
    expect(occlusionWetGain(0)).toBe(1);
    expect(occlusionWetGain(1)).toBeCloseTo(0.7, 12);
    expect(occlusionDryGain(1)).toBeLessThan(occlusionWetGain(1));
  });

  it('clamp the occlusion', () => {
    expect(occlusionDryGain(-1)).toBe(1);
    expect(occlusionDryGain(2)).toBeCloseTo(0.3, 12);
    expect(occlusionWetGain(2)).toBeCloseTo(0.7, 12);
  });
});

describe('NaN in, a number out (FORGE: clamp01 maps NaN to 0)', () => {
  it('a NaN alpha, wet or occlusion never yields a NaN gain or cutoff', () => {
    expect(reverbSendGain(Number.NaN, 0.3)).toBe(0.3);
    expect(reverbSendGain(0.5, Number.NaN)).toBe(0);
    expect(lowpassCutoff(Number.NaN, 0, true)).toBe(18_000);
    expect(lowpassCutoff(0, Number.NaN, true)).toBe(18_000);
    expect(occlusionDryGain(Number.NaN)).toBe(1);
    expect(occlusionWetGain(Number.NaN)).toBe(1);
  });
});
