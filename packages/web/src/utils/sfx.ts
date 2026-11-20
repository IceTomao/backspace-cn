import { useVoiceStore } from '../stores/voiceStore';
import {
  DEFAULT_JOIN_SOUND_PRESET,
  type JoinSoundPresetId,
} from '../audio/joinCues';

/** Base gain applied to every sound effect before the user's SFX slider. */
export const SFX_BASE_VOLUME = 0.8;

/**
 * Base gain of the join cue, before its dedicated slider. Lower than
 * {@link SFX_BASE_VOLUME} because the notification fires every time somebody
 * enters the channel and the perceived loudness is dominated by that repetition.
 */
export const JOIN_SOUND_BASE_VOLUME = 0.7;

/**
 * Effective sound-effect gain: the base SFX volume scaled by the user's SFX
 * slider (0–200, where 100 = unity). Read at play time so volume changes take
 * effect on the next cue without re-subscribing.
 */
export function getSfxVolume(): number {
  return SFX_BASE_VOLUME * (useVoiceStore.getState().soundEffectVolume / 100);
}

/**
 * Effective gain of the join cue: its own base level scaled by the dedicated
 * "notification sound" slider, independent of the general SFX volume.
 */
export function getJoinSoundVolume(): number {
  return JOIN_SOUND_BASE_VOLUME * (useVoiceStore.getState().joinSoundVolume / 100);
}

/** The preset the user picked, falling back to the bundled cue. */
export function getJoinSoundPreset(): JoinSoundPresetId {
  return useVoiceStore.getState().joinSoundPreset ?? DEFAULT_JOIN_SOUND_PRESET;
}
