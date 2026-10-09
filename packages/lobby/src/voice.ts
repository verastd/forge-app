/**
 * The lobby's voice: how far a voice carries in the cave, how it echoes, and
 * who may hear it. One place for every number, so the cave is tuned here and
 * nowhere else. The engine (apps/web, components/lobby/voice/engine.ts) takes
 * its config from `VOICE`, and its rules (how many voices at once, how soon a
 * voice may come back, when someone is speaking) from the functions below;
 * the scene and the people panel take their "within earshot" cue from
 * `nearness`.
 *
 * The cave is 51 m across and up to 220 m tall, so a voice carries most of
 * the way over: full volume within 5 m, then Unreal's natural-sound curve
 * down to −40 dB at 35 m and silence past it. Unreal's own −60 dB is too
 * steep without a reverb carrying far voices; with the cave's reverb, −40 dB
 * still lets a far voice turn mostly into echo instead of vanishing. The
 * reverb send is 0.3, not the cave preset's 0.4, which is thick: Fable's own
 * note puts intelligibility at 8 to 12 m at 0.25 to 0.3.
 */

import type { ReverbPreset } from './acoustics.js';
import { distanceAlpha } from './attenuation.js';
import type { AttenuationCurve, Vec3 } from './attenuation.js';

export interface VoiceSettings {
  /** Full volume within this many metres. */
  fullVolumeDistance: number;
  /** Silent from here. */
  falloffDistance: number;
  curve: AttenuationCurve;
  /** The natural curve's level at `falloffDistance`, in dB. */
  naturalDbAtMax: number;
  /** Hysteresis: receive a voice from falloff + margin (40 m), keep it until falloff + 2 × margin (45 m). */
  subscribeMargin: number;
  /** The sender's own check: who the SFU lets receive your mic at all. */
  permitRange: number;
  /** Position packets and voice evaluation, per second. */
  positionHz: number;
  /** HRTF panning, so a voice comes from where its speaker stands. */
  spatialPanning: boolean;
  reverb: ReverbPreset;
  /** The reverb send at full-volume distance, 0..1. */
  reverbWet: number;
  /** Highs roll off with distance. */
  distanceMuffling: boolean;
  /**
   * The most voices received at once, nearest first (people speaking are
   * kept on top of these): each is an HRTF panner, which a phone's audio
   * thread can't afford many of.
   */
  maxVoicesCoarse: number;
  maxVoicesFine: number;
  /** A voice taken or let go stays so for at least this long, so nobody can make everyone churn. */
  dwellMs: number;
  /** After a refused subscription, wait this long, doubling each time, up to `retryMaxMs`. */
  retryMs: number;
  retryMaxMs: number;
  /** A panner moves only once its speaker has turned more than this many degrees around you… */
  pannerTurnDegrees: number;
  /** …or come nearer or gone farther by more than this many metres. */
  pannerStepMetres: number;
  /** Speaking, as heard: an RMS level at or above `speakingOn` starts it… */
  speakingOn: number;
  /** …and it ends once the level has stayed under `speakingOff` for `speakingHoldMs`. */
  speakingOff: number;
  speakingHoldMs: number;
}

export const VOICE: Readonly<VoiceSettings> = Object.freeze({
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

/**
 * How near someone `d` metres away is, for the eye: 1 within full-volume
 * distance, falling linearly to 0 at falloff and beyond. Name tags and the
 * people panel's dots brighten with it. A distance that is not a number is 0.
 */
export function nearness(d: number): number {
  return Number.isNaN(d) ? 0 : 1 - distanceAlpha(d, VOICE.fullVolumeDistance, VOICE.falloffDistance);
}

/**
 * Whether someone `d` metres away may receive your mic at all: the sender's
 * own range check, which holds even against a listener's client that skips
 * its own. Wider than the 45 m a listener keeps a voice, so an honest
 * listener's hysteresis never runs into it.
 */
export function permitted(d: number): boolean {
  return d <= VOICE.permitRange;
}

/** Someone whose voice is within reach: how far, and whether they're speaking (as heard, so only someone received). */
export interface VoiceCandidate {
  id: string;
  distance: number;
  speaking: boolean;
}

/**
 * Whose voices to receive, of everyone within reach: the nearest `cap`, and
 * anyone already heard speaking on top of them, so a conversation isn't cut
 * off because someone else walked nearer. Ties keep their order.
 */
export function liveVoices(candidates: readonly VoiceCandidate[], cap: number): Set<string> {
  const live = new Set<string>();
  const nearest = [...candidates].sort((a, b) => a.distance - b.distance);
  for (const candidate of nearest.slice(0, Math.max(0, cap))) {
    live.add(candidate.id);
  }
  for (const candidate of candidates) {
    if (candidate.speaking) {
      live.add(candidate.id);
    }
  }
  return live;
}

/** How long to wait before asking for someone's voice again after `failures` refusals in a row: 0, then 1 s doubling to 30 s. */
export function retryDelay(failures: number): number {
  if (!(failures > 0)) {
    return 0;
  }
  return Math.min(VOICE.retryMaxMs, VOICE.retryMs * 2 ** (failures - 1));
}

/**
 * Whether a panner aimed at `from` (listener space, or null for never
 * aimed) should be moved to `to`: once the speaker has turned around the
 * listener by more than `pannerTurnDegrees`, or come nearer or gone farther
 * by more than `pannerStepMetres`. Moving a panner makes the browser cross-fade
 * its HRTFs, which costs, so a still crowd's panners stay put. A target that
 * isn't a number never moves one.
 */
export function pannerMoved(from: Vec3 | null, to: Vec3): boolean {
  if (from === null) {
    return Number.isFinite(to.x) && Number.isFinite(to.y) && Number.isFinite(to.z);
  }
  const a = Math.hypot(from.x, from.y, from.z);
  const b = Math.hypot(to.x, to.y, to.z);
  if (Math.abs(a - b) > VOICE.pannerStepMetres) {
    return true;
  }
  if (a === 0 || b === 0) {
    return false;
  }
  const cos = (from.x * to.x + from.y * to.y + from.z * to.z) / (a * b);
  return cos < Math.cos((VOICE.pannerTurnDegrees * Math.PI) / 180);
}

/** Whether someone is speaking, as heard, and since when the level has been low (null while it isn't). */
export interface Speaking {
  speaking: boolean;
  quietSince: number | null;
}

/**
 * Speaking, from what is actually heard of someone (an RMS level, read every
 * tick at `now`, in milliseconds): on at `speakingOn`, and off only once the
 * level has stayed under `speakingOff` for `speakingHoldMs`, so the gaps
 * between words don't make it flicker. A level that isn't a number is
 * silence.
 */
export function hearSpeaking(previous: Speaking, rms: number, now: number): Speaking {
  const level = Number.isFinite(rms) ? rms : 0;
  if (level >= VOICE.speakingOn) {
    return { speaking: true, quietSince: null };
  }
  if (!previous.speaking) {
    return { speaking: false, quietSince: null };
  }
  if (level >= VOICE.speakingOff) {
    return { speaking: true, quietSince: null };
  }
  const quietSince = previous.quietSince ?? now;
  return now - quietSince >= VOICE.speakingHoldMs ? { speaking: false, quietSince: null } : { speaking: true, quietSince };
}

/** The numbers in an engine config that a typo, or a NaN, could break. */
export interface VoiceNumbers {
  fullVolumeDistance: number;
  falloffDistance: number;
  subscribeMargin: number;
  positionHz: number;
  positionStaleMs: number;
  reverbWet: number;
  naturalDbAtMax?: number;
}

/**
 * Why `config` can't drive the engine, or null when it can: every distance,
 * rate and level a finite number (the staleness may be Infinity, never
 * NaN), the margin and rates not negative, the falloff past full volume, and
 * the reverb send within 0..1. One NaN in the gains would throw inside every
 * tick.
 */
export function voiceConfigProblem(config: VoiceNumbers): string | null {
  const finite: Array<[string, number | undefined]> = [
    ['fullVolumeDistance', config.fullVolumeDistance],
    ['falloffDistance', config.falloffDistance],
    ['subscribeMargin', config.subscribeMargin],
    ['positionHz', config.positionHz],
    ['reverbWet', config.reverbWet],
    ['naturalDbAtMax', config.naturalDbAtMax],
  ];
  for (const [name, value] of finite) {
    if (value !== undefined && !Number.isFinite(value)) {
      return `${name} is not a finite number`;
    }
  }
  if (Number.isNaN(config.positionStaleMs) || config.positionStaleMs <= 0) {
    return 'positionStaleMs must be more than 0';
  }
  if (config.fullVolumeDistance < 0 || config.subscribeMargin < 0 || config.positionHz < 0) {
    return 'distances, the margin and the rate must not be negative';
  }
  if (config.falloffDistance <= config.fullVolumeDistance) {
    return 'falloffDistance must be past fullVolumeDistance';
  }
  if (config.reverbWet < 0 || config.reverbWet > 1) {
    return 'reverbWet must be within 0..1';
  }
  return null;
}

/**
 * Each listener's own reverb level: how much of the cave's echo they hear,
 * as a share of `VOICE.reverbWet` (1 is the cave as designed, 0 is dry). It
 * only changes the listener's own mix: everyone else hears their own level.
 */
export const REVERB_LEVEL = Object.freeze({ min: 0, max: 1, default: 1, step: 0.05 });

/** The Web Storage item a listener's reverb level is kept under, versioned in its name. */
export const REVERB_LEVEL_STORAGE_ITEM = 'forge.lobby.reverb.v1' as const;

/** The level kept inside its range (a non-number is the default). */
export function clampReverbLevel(level: number): number {
  if (!Number.isFinite(level)) return REVERB_LEVEL.default;
  return Math.min(REVERB_LEVEL.max, Math.max(REVERB_LEVEL.min, level));
}

/** The engine's wet send for a listener's level: the cave's own, scaled. */
export function reverbWetFor(level: number): number {
  return Math.round(VOICE.reverbWet * clampReverbLevel(level) * 1000) / 1000;
}

/** A level as stored: a whole percent. */
export function serializeReverbLevel(level: number): string {
  return String(Math.round(clampReverbLevel(level) * 100));
}

/**
 * A stored level, or null when there is nothing usable (no value, not a
 * whole number of percent, or out of range). Stored values are untrusted
 * input, so it rejects rather than repairs. Never throws.
 */
export function parseReverbLevel(raw: string | null): number | null {
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return null;
  const percent = Number(raw);
  if (percent < REVERB_LEVEL.min * 100 || percent > REVERB_LEVEL.max * 100) return null;
  return percent / 100;
}
