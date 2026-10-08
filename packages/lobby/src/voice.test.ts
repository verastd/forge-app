import { describe, expect, it } from 'vitest';

import { REVERB_PRESETS, reverbSendGain } from './acoustics.js';
import { computeGain, distanceAlpha, shouldSubscribe } from './attenuation.js';
import {
  REVERB_LEVEL,
  VOICE,
  clampReverbLevel,
  parseReverbLevel,
  reverbWetFor,
  serializeReverbLevel,
  hearSpeaking,
  liveVoices,
  nearness,
  pannerMoved,
  permitted,
  retryDelay,
  voiceConfigProblem,
} from './voice.js';
import type { Speaking, VoiceNumbers } from './voice.js';

describe('VOICE', () => {
  it("is the cave's config, frozen", () => {
    expect(VOICE).toEqual({
      fullVolumeDistance: 5,
      falloffDistance: 35,
      curve: 'natural',
      naturalDbAtMax: -40,
      subscribeMargin: 5,
      permitRange: 50,
      positionHz: 10,
      spatialPanning: true,
      reverb: 'cave',
      reverbWet: 0.3,
      distanceMuffling: true,
      maxVoicesCoarse: 8,
      maxVoicesFine: 16,
      dwellMs: 2000,
      retryMs: 1000,
      retryMaxMs: 30_000,
      pannerTurnDegrees: 3,
      pannerStepMetres: 0.25,
      speakingOn: 0.01,
      speakingOff: 0.005,
      speakingHoldMs: 600,
    });
    expect(voiceConfigProblem({ ...VOICE, positionStaleMs: Infinity })).toBeNull();
    expect(Object.isFrozen(VOICE)).toBe(true);
    expect(REVERB_PRESETS[VOICE.reverb as 'cave']).toBeDefined();
  });

  it('receives a voice from 40 m, keeps it to 45 m, and the sender permits to 50 m', () => {
    expect(shouldSubscribe(40, VOICE, VOICE.subscribeMargin, false)).toBe(true);
    expect(shouldSubscribe(40.5, VOICE, VOICE.subscribeMargin, false)).toBe(false);
    expect(shouldSubscribe(45, VOICE, VOICE.subscribeMargin, true)).toBe(true);
    expect(shouldSubscribe(45.5, VOICE, VOICE.subscribeMargin, true)).toBe(false);
    // An honest listener's hysteresis never runs into the sender's own check.
    expect(VOICE.permitRange).toBeGreaterThan(VOICE.falloffDistance + 2 * VOICE.subscribeMargin);
  });

  it('at 3, 15 and 30 m: a near voice is direct, a far one mostly reverb', () => {
    const at = (d: number) => ({
      dry: computeGain(d, VOICE),
      send: reverbSendGain(distanceAlpha(d, VOICE.fullVolumeDistance, VOICE.falloffDistance), VOICE.reverbWet),
    });
    expect(at(3)).toEqual({ dry: 1, send: 0.3 });
    expect(at(15).dry).toBeCloseTo(0.2154, 4);
    expect(at(15).send).toBeCloseTo(0.2449, 4);
    expect(at(30).dry).toBeCloseTo(0.0215, 4);
    expect(at(30).send).toBeCloseTo(0.1225, 4);
    expect(at(30).send).toBeGreaterThan(5 * at(30).dry);
  });
});

describe('nearness', () => {
  it('is 1 within full volume, linear to 0 at falloff, and 0 beyond', () => {
    expect(nearness(0)).toBe(1);
    expect(nearness(5)).toBe(1);
    expect(nearness(20)).toBe(0.5);
    expect(nearness(27.5)).toBe(0.25);
    expect(nearness(35)).toBe(0);
    expect(nearness(200)).toBe(0);
    expect(nearness(Infinity)).toBe(0);
  });

  it('is 0 for a distance that is not a number', () => {
    expect(nearness(Number.NaN)).toBe(0);
  });

  it('never grows with distance', () => {
    let previous = nearness(0);
    for (let d = 0; d <= 50; d += 0.25) {
      expect(nearness(d)).toBeLessThanOrEqual(previous);
      previous = nearness(d);
    }
  });
});

describe('permitted', () => {
  it('lets anyone within 50 m receive your mic, and nobody farther', () => {
    expect(permitted(0)).toBe(true);
    expect(permitted(45)).toBe(true);
    expect(permitted(50)).toBe(true);
    expect(permitted(50.01)).toBe(false);
    expect(permitted(224)).toBe(false);
  });

  it('refuses a distance that is not a number', () => {
    expect(permitted(Number.NaN)).toBe(false);
  });
});

describe('liveVoices', () => {
  const at = (id: string, distance: number, speaking = false) => ({ id, distance, speaking });

  it('keeps the nearest few within reach', () => {
    const candidates = [at('far', 30), at('near', 2), at('mid', 12), at('next', 6)];
    expect([...liveVoices(candidates, 2)].sort()).toEqual(['near', 'next']);
    expect([...liveVoices(candidates, 8)].sort()).toEqual(['far', 'mid', 'near', 'next']);
    expect(liveVoices([], 8).size).toBe(0);
  });

  it('keeps anyone heard speaking on top of the nearest, so a conversation is not cut off', () => {
    const candidates = [at('a', 1), at('b', 2), at('talker', 25, true), at('c', 3)];
    expect([...liveVoices(candidates, 2)].sort()).toEqual(['a', 'b', 'talker']);
    // A cap of 0 (or less) still lets the speakers through.
    expect([...liveVoices(candidates, 0)]).toEqual(['talker']);
    expect([...liveVoices(candidates, -3)]).toEqual(['talker']);
  });

  it('does not reorder or change what it is given', () => {
    const candidates = [at('b', 9), at('a', 1)];
    liveVoices(candidates, 1);
    expect(candidates.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('retryDelay', () => {
  it('waits 1 s after the first refusal, doubling to 30 s at most', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(retryDelay(1000)).toBe(30_000);
  });

  it('does not wait before any refusal, or for a count that is not a number', () => {
    expect(retryDelay(0)).toBe(0);
    expect(retryDelay(-1)).toBe(0);
    expect(retryDelay(Number.NaN)).toBe(0);
  });
});

describe('pannerMoved', () => {
  const v = (x: number, y: number, z: number) => ({ x, y, z });

  it('aims a panner that was never aimed, unless the target is not a number', () => {
    expect(pannerMoved(null, v(3, 0, 0))).toBe(true);
    expect(pannerMoved(null, v(Number.NaN, 0, 0))).toBe(false);
    expect(pannerMoved(null, v(0, Number.NaN, 0))).toBe(false);
    expect(pannerMoved(null, v(0, 0, Infinity))).toBe(false);
  });

  it('moves it once the speaker comes 0.25 m nearer or goes 0.25 m farther', () => {
    expect(pannerMoved(v(0, 0, -10), v(0, 0, -10.2))).toBe(false);
    expect(pannerMoved(v(0, 0, -10), v(0, 0, -10.3))).toBe(true);
    expect(pannerMoved(v(0, 0, -10), v(0, 0, -9.7))).toBe(true);
  });

  it('moves it once the speaker turns more than 3° around the listener', () => {
    const turned = (degrees: number) => {
      const r = (degrees * Math.PI) / 180;
      return v(10 * Math.sin(r), 0, -10 * Math.cos(r));
    };
    expect(pannerMoved(v(0, 0, -10), turned(2.9))).toBe(false);
    expect(pannerMoved(v(0, 0, -10), turned(3.1))).toBe(true);
    expect(pannerMoved(v(0, 0, -10), turned(180))).toBe(true);
  });

  it('leaves a panner at the listener alone until the speaker steps away', () => {
    expect(pannerMoved(v(0, 0, 0), v(0, 0, 0))).toBe(false);
    expect(pannerMoved(v(0, 0, 0), v(0.1, 0, 0))).toBe(false);
    expect(pannerMoved(v(0.1, 0, 0), v(0, 0, 0))).toBe(false);
    expect(pannerMoved(v(0, 0, 0), v(0.3, 0, 0))).toBe(true);
  });

  it('never moves it to a target that is not a number', () => {
    expect(pannerMoved(v(0, 0, -10), v(Number.NaN, 0, -10))).toBe(false);
  });
});

describe('hearSpeaking', () => {
  const quiet: Speaking = { speaking: false, quietSince: null };

  it('starts at the "on" level', () => {
    expect(hearSpeaking(quiet, 0.009, 0)).toEqual(quiet);
    expect(hearSpeaking(quiet, 0.01, 0)).toEqual({ speaking: true, quietSince: null });
    expect(hearSpeaking(quiet, 0.3, 0)).toEqual({ speaking: true, quietSince: null });
  });

  it('holds through a level between "off" and "on", and through a short gap', () => {
    const on: Speaking = { speaking: true, quietSince: null };
    expect(hearSpeaking(on, 0.007, 100)).toEqual(on);
    const gap = hearSpeaking(on, 0.001, 100);
    expect(gap).toEqual({ speaking: true, quietSince: 100 });
    expect(hearSpeaking(gap, 0.001, 699)).toEqual({ speaking: true, quietSince: 100 });
    // A word in the gap starts the hold again.
    expect(hearSpeaking(gap, 0.02, 400)).toEqual(on);
    expect(hearSpeaking(gap, 0.006, 400)).toEqual(on);
  });

  it('ends after 600 ms under "off"', () => {
    const gap: Speaking = { speaking: true, quietSince: 100 };
    expect(hearSpeaking(gap, 0.001, 700)).toEqual(quiet);
    expect(hearSpeaking(gap, 0, 5000)).toEqual(quiet);
  });

  it('takes a level that is not a number for silence', () => {
    expect(hearSpeaking(quiet, Number.NaN, 0)).toEqual(quiet);
    expect(hearSpeaking({ speaking: true, quietSince: null }, Number.NaN, 0)).toEqual({ speaking: true, quietSince: 0 });
    expect(hearSpeaking({ speaking: true, quietSince: 0 }, Infinity, 600)).toEqual(quiet);
  });
});

describe('voiceConfigProblem', () => {
  const good: VoiceNumbers = {
    fullVolumeDistance: 5,
    falloffDistance: 35,
    subscribeMargin: 5,
    positionHz: 10,
    positionStaleMs: 3000,
    reverbWet: 0.3,
    naturalDbAtMax: -40,
  };

  it('passes a config the engine can run on, with or without the natural curve level', () => {
    expect(voiceConfigProblem(good)).toBeNull();
    expect(voiceConfigProblem({ ...good, naturalDbAtMax: undefined })).toBeNull();
    expect(voiceConfigProblem({ ...good, positionStaleMs: Infinity, subscribeMargin: 0, positionHz: 0, reverbWet: 0 })).toBeNull();
  });

  it('refuses a number that is NaN or infinite', () => {
    for (const key of ['fullVolumeDistance', 'falloffDistance', 'subscribeMargin', 'positionHz', 'reverbWet', 'naturalDbAtMax'] as const) {
      expect(voiceConfigProblem({ ...good, [key]: Number.NaN })).toBe(`${key} is not a finite number`);
      expect(voiceConfigProblem({ ...good, [key]: Infinity })).toBe(`${key} is not a finite number`);
    }
    expect(voiceConfigProblem({ ...good, positionStaleMs: Number.NaN })).toBe('positionStaleMs must be more than 0');
    expect(voiceConfigProblem({ ...good, positionStaleMs: 0 })).toBe('positionStaleMs must be more than 0');
  });

  it('refuses a negative margin, distance or rate, a falloff at or inside full volume, and a send past 0..1', () => {
    const negative = 'distances, the margin and the rate must not be negative';
    expect(voiceConfigProblem({ ...good, subscribeMargin: -5 })).toBe(negative);
    expect(voiceConfigProblem({ ...good, fullVolumeDistance: -1 })).toBe(negative);
    expect(voiceConfigProblem({ ...good, positionHz: -10 })).toBe(negative);
    expect(voiceConfigProblem({ ...good, falloffDistance: 5 })).toBe('falloffDistance must be past fullVolumeDistance');
    expect(voiceConfigProblem({ ...good, falloffDistance: 2 })).toBe('falloffDistance must be past fullVolumeDistance');
    expect(voiceConfigProblem({ ...good, reverbWet: 1.5 })).toBe('reverbWet must be within 0..1');
    expect(voiceConfigProblem({ ...good, reverbWet: -0.1 })).toBe('reverbWet must be within 0..1');
  });
});

describe('each listener’s reverb level', () => {
  it('scales the cave’s own wet send: all of it, none, or between', () => {
    expect(reverbWetFor(1)).toBe(VOICE.reverbWet);
    expect(reverbWetFor(0)).toBe(0);
    expect(reverbWetFor(0.5)).toBeCloseTo(VOICE.reverbWet / 2, 6);
    expect(reverbWetFor(3)).toBe(VOICE.reverbWet);
    expect(reverbWetFor(-1)).toBe(0);
    expect(reverbWetFor(Number.NaN)).toBe(VOICE.reverbWet);
  });

  it('is stored as a whole percent and read back', () => {
    expect(serializeReverbLevel(0.35)).toBe('35');
    expect(serializeReverbLevel(2)).toBe('100');
    expect(parseReverbLevel('35')).toBe(0.35);
    expect(parseReverbLevel('0')).toBe(0);
    expect(parseReverbLevel(serializeReverbLevel(REVERB_LEVEL.default))).toBe(REVERB_LEVEL.default);
  });

  it.each([null, '', '101', '-5', '0.5', 'abc', '1000', ' 50'])('rejects a stored %j', (raw) => {
    expect(parseReverbLevel(raw)).toBeNull();
  });

  it('keeps any level in range', () => {
    expect(clampReverbLevel(0.4)).toBe(0.4);
    expect(clampReverbLevel(Number.POSITIVE_INFINITY)).toBe(REVERB_LEVEL.default);
    expect(Object.isFrozen(REVERB_LEVEL)).toBe(true);
  });
});
