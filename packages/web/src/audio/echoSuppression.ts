/**
 * Reference-guided echo suppression for the outgoing microphone signal.
 *
 * The browser's own acoustic echo canceller only knows about audio this tab
 * renders. Everything else the machine plays — music, a game, another app's
 * call — reaches the microphone through the speakers and gets transmitted back.
 * That is what this module is about: take a capture of what the device is
 * playing, compare it with the microphone in the frequency domain, and attenuate
 * the bins the microphone only contains because the speakers played them.
 *
 * Deliberate design choices, all of them aimed at "never make the voice worse":
 *
 * - **Suppression, not cancellation.** A bin is attenuated by at most
 *   `ECHO_SUPPRESSION_FLOOR_DB` (9 dB). A bad estimate is then a slightly dull
 *   bin, never a hole in the sentence.
 * - **No delay alignment.** The acoustic path plus the playback buffer delays the
 *   reference by tens of milliseconds, and that delay is unknowable here (it
 *   depends on the sound card, the OS mixer and the speaker placement). Instead
 *   of chasing it, the reference is held as a short-term peak per bin: a played
 *   sound stays "recently played" for `ECHO_SUPPRESSION_PEAK_HOLD_MS`, which
 *   covers every plausible delay without any cross-correlation or lock-in.
 * - **Double-talk protection is structural.** The gain is
 *   `1 - overSubtraction * reference / microphone`, so when the speaker talks over
 *   the playback the microphone magnitude dominates and the bin passes through
 *   untouched. There is no separate voice detector to mistune.
 *
 * The worklet in `worklets/systemEchoSuppressor.js` carries the same formulas;
 * everything that can be tested without an audio graph lives here.
 */

/** FFT size used by the suppressor (1024 samples ≈ 21 ms at 48 kHz). */
export const ECHO_SUPPRESSION_FFT_SIZE = 1024;

/** Analysis hop equals the AudioWorklet render quantum. */
export const ECHO_SUPPRESSION_HOP_SIZE = 128;

/** How long a played bin stays "recently played" while the echo arrives. */
export const ECHO_SUPPRESSION_PEAK_HOLD_MS = 240;

/** Maximum attenuation applied to a suppressed bin. */
export const ECHO_SUPPRESSION_FLOOR_DB = -9;

/** Gain multiplier on the reference magnitude (>1 suppresses more aggressively). */
export const ECHO_SUPPRESSION_OVER_SUBTRACTION = 1.4;

/** Per-hop smoothing when a bin starts being suppressed (0..1, higher = faster). */
export const ECHO_SUPPRESSION_ATTACK = 0.55;

/** Per-hop smoothing when a bin is released back to unity. */
export const ECHO_SUPPRESSION_RELEASE = 0.18;

/** Below this reference level (dBFS) the suppressor is fully transparent. */
export const ECHO_SUPPRESSION_GATE_DB = -62;

/**
 * How far above the leak estimate the microphone has to be before the bin is
 * left completely untouched. Speaking over playback is the normal case here, and
 * a voice that is clearly louder than the leaked playback must not lose a single
 * decibel to a subtractive formula that would otherwise shave a little off it.
 */
export const ECHO_SUPPRESSION_DOMINANCE = 2;

/**
 * Which capture feeds the reference input of the suppressor.
 *
 * - `system` — a loopback capture of the whole device output (Electron only).
 * - `app` — the app's own playback bus, used when no loopback is available. It
 *   still removes the loudest echo source (the call itself).
 * - `none` — neither, so the suppressor stays transparent.
 */
export type EchoReferenceKind = 'system' | 'app' | 'none';

/** What the settings UI shows about the feature's live state. */
export type EchoSuppressionStatus = 'off' | 'system' | 'app' | 'unavailable';

export const ECHO_SUPPRESSION_FLOOR = 10 ** (ECHO_SUPPRESSION_FLOOR_DB / 20);
export const ECHO_SUPPRESSION_GATE = 10 ** (ECHO_SUPPRESSION_GATE_DB / 20);

/** Per-hop decay applied to the peak-hold, derived from the hold time. */
export function peakHoldDecay(sampleRate: number): number {
  const hopMs = (ECHO_SUPPRESSION_HOP_SIZE / sampleRate) * 1000;
  if (!Number.isFinite(hopMs) || hopMs <= 0) return 0.9;
  return Math.exp(-hopMs / ECHO_SUPPRESSION_PEAK_HOLD_MS);
}

/**
 * Advance one bin of the reference peak-hold.
 *
 * The peak rises instantly and decays geometrically, so a burst of playback
 * keeps the bin marked as "played" for roughly the hold window.
 */
export function advancePeakHold(previous: number, magnitude: number, decay: number): number {
  const decayed = previous * decay;
  return magnitude > decayed ? magnitude : decayed;
}

/**
 * Target gain for one frequency bin.
 *
 * `reference` is the peak-held reference magnitude, `microphone` the current
 * microphone magnitude. Returns 1 when the microphone carries something the
 * reference cannot explain, and approaches `ECHO_SUPPRESSION_FLOOR` when the
 * microphone bin is no louder than the reference scaled by the acoustic path —
 * i.e. when the bin is plausibly nothing but leaked playback.
 */
export function suppressionGain(
  microphone: number,
  reference: number,
  overSubtraction = ECHO_SUPPRESSION_OVER_SUBTRACTION,
): number {
  if (!(reference > ECHO_SUPPRESSION_GATE)) return 1;
  if (!(microphone > 0)) return ECHO_SUPPRESSION_FLOOR;
  const leaked = reference * overSubtraction;
  // The speaker is clearly louder than what the playback could have leaked:
  // this bin is their voice, leave it alone.
  if (microphone >= leaked * ECHO_SUPPRESSION_DOMINANCE) return 1;
  const gain = 1 - leaked / microphone;
  if (gain >= 1) return 1;
  if (gain <= ECHO_SUPPRESSION_FLOOR) return ECHO_SUPPRESSION_FLOOR;
  return gain;
}

/**
 * Smooth a bin gain towards its target. Suppression engages quickly and lets go
 * slowly: a fast release would chop the tail of the playback into an audibly
 * pumping "flutter" (the classic gating artefact), while a slow attack would
 * briefly leak the loudest part of a sound.
 */
export function smoothGain(previous: number, target: number): number {
  const rate = target < previous ? ECHO_SUPPRESSION_ATTACK : ECHO_SUPPRESSION_RELEASE;
  const next = previous + (target - previous) * rate;
  return next < ECHO_SUPPRESSION_FLOOR ? ECHO_SUPPRESSION_FLOOR : next > 1 ? 1 : next;
}

/** Status shown in settings for the given preference and reference state. */
export function echoSuppressionStatus(
  enabled: boolean,
  reference: EchoReferenceKind,
): EchoSuppressionStatus {
  if (!enabled) return 'off';
  if (reference === 'system') return 'system';
  if (reference === 'app') return 'app';
  return 'unavailable';
}
