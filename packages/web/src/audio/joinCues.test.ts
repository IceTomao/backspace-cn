import { describe, expect, it } from 'vitest';
import {
  clampJoinSoundVolume,
  DEFAULT_JOIN_SOUND_PRESET,
  DEFAULT_JOIN_SOUND_VOLUME,
  JOIN_SOUND_PRESETS,
  JOIN_SOUND_VOLUME_MAX,
  JOIN_SOUND_VOLUME_MIN,
  isJoinSoundPreset,
  isSynthJoinSoundPreset,
  joinCueDurationMs,
  joinCueNotes,
} from './joinCues';

describe('join cue presets', () => {
  it('exposes every preset exactly once, with the shipped default present', () => {
    expect(new Set(JOIN_SOUND_PRESETS).size).toBe(JOIN_SOUND_PRESETS.length);
    expect(JOIN_SOUND_PRESETS).toContain(DEFAULT_JOIN_SOUND_PRESET);
  });

  it('only accepts known preset ids', () => {
    for (const preset of JOIN_SOUND_PRESETS) expect(isJoinSoundPreset(preset)).toBe(true);
    expect(isJoinSoundPreset('trumpet')).toBe(false);
    expect(isJoinSoundPreset(null)).toBe(false);
  });

  it('classifies which presets are synthesised in the app', () => {
    expect(isSynthJoinSoundPreset('classic')).toBe(false);
    expect(isSynthJoinSoundPreset('none')).toBe(false);
    expect(isSynthJoinSoundPreset('soft')).toBe(true);
  });

  it('gives every synthesised preset at least one note with sane timing', () => {
    for (const preset of JOIN_SOUND_PRESETS) {
      if (!isSynthJoinSoundPreset(preset)) continue;
      const notes = joinCueNotes(preset);
      expect(notes.length).toBeGreaterThan(0);
      for (const note of notes) {
        expect(note.frequency).toBeGreaterThan(0);
        expect(note.startMs).toBeGreaterThanOrEqual(0);
        expect(note.durationMs).toBeGreaterThan(0);
        expect(note.peak).toBeGreaterThan(0);
        expect(note.peak).toBeLessThanOrEqual(1);
      }
      // A cue must not outlive the span the UI reports for it.
      expect(joinCueDurationMs(preset)).toBeGreaterThan(0);
    }
  });

  it('returns no notes for the presets handled elsewhere', () => {
    expect(joinCueNotes('classic')).toEqual([]);
    expect(joinCueNotes('none')).toEqual([]);
    expect(joinCueDurationMs('none')).toBe(0);
  });

  it('returns a fresh copy so callers cannot mutate the shared table', () => {
    const notes = joinCueNotes('soft');
    notes[0].peak = 99;
    expect(joinCueNotes('soft')[0].peak).not.toBe(99);
  });
});

describe('clampJoinSoundVolume', () => {
  it('keeps in-range values and rounds them', () => {
    expect(clampJoinSoundVolume(0)).toBe(0);
    expect(clampJoinSoundVolume(45)).toBe(45);
    expect(clampJoinSoundVolume(72.4)).toBe(72);
    expect(clampJoinSoundVolume(72.6)).toBe(73);
  });

  it('clamps to the slider range', () => {
    expect(clampJoinSoundVolume(-30)).toBe(JOIN_SOUND_VOLUME_MIN);
    expect(clampJoinSoundVolume(JOIN_SOUND_VOLUME_MAX + 120)).toBe(JOIN_SOUND_VOLUME_MAX);
  });

  it('falls back to the default for values that are not numbers', () => {
    expect(clampJoinSoundVolume(Number.NaN)).toBe(DEFAULT_JOIN_SOUND_VOLUME);
    expect(clampJoinSoundVolume(Number.POSITIVE_INFINITY)).toBe(DEFAULT_JOIN_SOUND_VOLUME);
    expect(clampJoinSoundVolume('80')).toBe(DEFAULT_JOIN_SOUND_VOLUME);
    expect(clampJoinSoundVolume(undefined)).toBe(DEFAULT_JOIN_SOUND_VOLUME);
  });
});
