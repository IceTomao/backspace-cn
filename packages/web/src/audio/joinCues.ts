/**
 * Presets for the "someone joined the call" cue.
 *
 * `classic` is the bundled sample every previous build played; the remaining
 * presets are synthesized from the note tables below, so choosing a different
 * cue costs no download and stays deterministic in tests. `none` disables the
 * cue without muting the rest of the interface sounds.
 */
export type JoinSoundPresetId = 'classic' | 'soft' | 'chime' | 'marimba' | 'pop' | 'none';

/** Synth presets — everything except the bundled sample and the off switch. */
export type SynthJoinSoundPresetId = Exclude<JoinSoundPresetId, 'classic' | 'none'>;

export const JOIN_SOUND_PRESETS: readonly JoinSoundPresetId[] = [
  'classic',
  'soft',
  'chime',
  'marimba',
  'pop',
  'none',
];

/** Kept as the default so existing users recognise the cue. */
export const DEFAULT_JOIN_SOUND_PRESET: JoinSoundPresetId = 'classic';

/**
 * The bundled sample was perceived as too loud at the shared 100 % default, so
 * the dedicated slider starts well below unity.
 */
export const DEFAULT_JOIN_SOUND_VOLUME = 45;

/** Mirrors the 0–200 range of every other volume slider in the app. */
export const JOIN_SOUND_VOLUME_MIN = 0;
export const JOIN_SOUND_VOLUME_MAX = 200;

export interface JoinCueNote {
  /** Oscillator frequency in Hz. */
  frequency: number;
  /** Offset from the start of the cue, in milliseconds. */
  startMs: number;
  /** How long the note rings, in milliseconds. */
  durationMs: number;
  /** Peak gain of the note before the user's volume slider is applied. */
  peak: number;
  type: OscillatorType;
}

/**
 * Short, deliberately quiet cues: two or three notes, each under 600 ms, so a
 * busy channel does not turn the join sound into a melody.
 */
const SYNTH_JOIN_CUES: Record<SynthJoinSoundPresetId, readonly JoinCueNote[]> = {
  soft: [
    { frequency: 523.25, startMs: 0, durationMs: 260, peak: 0.3, type: 'sine' },
  ],
  chime: [
    { frequency: 880, startMs: 0, durationMs: 460, peak: 0.24, type: 'sine' },
    { frequency: 1174.66, startMs: 110, durationMs: 420, peak: 0.2, type: 'sine' },
  ],
  marimba: [
    { frequency: 523.25, startMs: 0, durationMs: 260, peak: 0.32, type: 'triangle' },
    { frequency: 659.25, startMs: 90, durationMs: 280, peak: 0.26, type: 'triangle' },
    { frequency: 783.99, startMs: 180, durationMs: 320, peak: 0.22, type: 'triangle' },
  ],
  pop: [
    { frequency: 740, startMs: 0, durationMs: 80, peak: 0.34, type: 'sine' },
    { frequency: 1108.73, startMs: 80, durationMs: 70, peak: 0.24, type: 'sine' },
  ],
};

const SYNTH_PRESET_IDS: readonly SynthJoinSoundPresetId[] = ['soft', 'chime', 'marimba', 'pop'];

export function isJoinSoundPreset(value: unknown): value is JoinSoundPresetId {
  return typeof value === 'string' && (JOIN_SOUND_PRESETS as readonly string[]).includes(value);
}

/** True for presets that are synthesized instead of played from `/sounds`. */
export function isSynthJoinSoundPreset(preset: JoinSoundPresetId): preset is SynthJoinSoundPresetId {
  return (SYNTH_PRESET_IDS as readonly string[]).includes(preset);
}

/**
 * Notes for a synthesized preset; the sample-backed presets have none.
 * Returns copies: callers schedule these as audio graph nodes and a shared
 * table must not become editable state.
 */
export function joinCueNotes(preset: JoinSoundPresetId): readonly JoinCueNote[] {
  if (!isSynthJoinSoundPreset(preset)) return [];
  return SYNTH_JOIN_CUES[preset].map((note) => ({ ...note }));
}

/** Total length of a synthesized cue, used for tests and for fade scheduling. */
export function joinCueDurationMs(preset: JoinSoundPresetId): number {
  return joinCueNotes(preset).reduce(
    (longest, note) => Math.max(longest, note.startMs + note.durationMs),
    0,
  );
}

/**
 * Clamps a persisted slider value into the 0–200 range. Anything that is not a
 * finite number falls back to the default so a corrupt store cannot silence the
 * cue or blast it at full scale.
 */
export function clampJoinSoundVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_JOIN_SOUND_VOLUME;
  return Math.min(JOIN_SOUND_VOLUME_MAX, Math.max(JOIN_SOUND_VOLUME_MIN, Math.round(value)));
}
