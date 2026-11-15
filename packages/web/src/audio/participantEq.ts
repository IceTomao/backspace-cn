/**
 * Per-participant equalizer.
 *
 * Every remote microphone track can be shaped individually before its volume
 * gain, because a participant's microphone, room and speakers differ from
 * everyone else's: one voice is thin and needs weight in the low end, another
 * is boomy and needs the 200 Hz shelf pulled down, another has harsh sibilance
 * that a presence cut fixes. The sliders cover the same idea as a music
 * player's EQ, applied to one voice at a time.
 *
 * Two presets cover the common cases and "custom" keeps whatever the user
 * dialled in:
 *
 *   - `bass` lifts the low end and takes a little edge off the top.
 *   - `vocal` removes rumble and adds presence so speech cuts through.
 *
 * The chain is a plain serial stack of biquad filters, so it can be dropped
 * between the source node and the volume gain without changing anything else
 * in the pipeline. All five filters always exist, even for a flat preset:
 * a biquad at 0 dB is transparent, and keeping the graph stable means moving
 * a slider later only changes gain values instead of rebuilding Web Audio
 * nodes mid-call.
 *
 * The data model is pure (no Web Audio objects) so it can be persisted,
 * sanitized after a schema change, and unit-tested without an AudioContext.
 */

export type EqBandId = 'low' | 'lowMid' | 'mid' | 'presence' | 'high';
export type EqFilterKind = 'lowshelf' | 'peaking' | 'highshelf';
export type EqPresetId = 'flat' | 'bass' | 'vocal' | 'custom';
/** Presets that carry fixed gains; `custom` keeps the user's own values. */
export type EqPresetName = Exclude<EqPresetId, 'custom'>;

export interface EqBandDefinition {
  id: EqBandId;
  kind: EqFilterKind;
  /** Centre (peaking) or corner (shelf) frequency in hertz. */
  frequency: number;
  /** Only meaningful for peaking filters; shelves ignore it. */
  q: number;
}

/**
 * Five bands cover the range that matters for speech intelligibility without
 * turning the menu into a mixing console. The shelf corners sit low enough to
 * catch room rumble and high enough to catch sibilance; the three peaking
 * bands sit on the formant and presence ranges of a human voice.
 */
export const EQ_BANDS: readonly EqBandDefinition[] = [
  { id: 'low', kind: 'lowshelf', frequency: 200, q: 0.7 },
  { id: 'lowMid', kind: 'peaking', frequency: 500, q: 0.9 },
  { id: 'mid', kind: 'peaking', frequency: 1500, q: 0.9 },
  { id: 'presence', kind: 'peaking', frequency: 3500, q: 0.9 },
  { id: 'high', kind: 'highshelf', frequency: 6000, q: 0.7 },
];

export const EQ_GAIN_MIN = -12;
export const EQ_GAIN_MAX = 12;
/** Ramp constant for gain changes; short enough to feel instant, long enough to avoid clicks. */
export const EQ_RAMP_SECONDS = 0.02;

export type EqGains = Record<EqBandId, number>;

export interface ParticipantEq {
  preset: EqPresetId;
  /** Always present, so the sliders keep their position when a preset is applied. */
  gains: EqGains;
}

const FLAT_GAINS: Readonly<EqGains> = Object.freeze({
  low: 0,
  lowMid: 0,
  mid: 0,
  presence: 0,
  high: 0,
});

/**
 * Tuned by ear against speech, not music: the bass preset adds weight without
 * muddying consonants, the vocal preset clears rumble and pushes the 3.5 kHz
 * presence band where intelligibility lives.
 */
export const EQ_PRESET_GAINS: Readonly<Record<EqPresetName, Readonly<EqGains>>> = Object.freeze({
  flat: FLAT_GAINS,
  bass: Object.freeze({ low: 8, lowMid: 3, mid: 0, presence: -1, high: -3 }),
  vocal: Object.freeze({ low: -6, lowMid: -2, mid: 1, presence: 4, high: 2 }),
});

export const DEFAULT_PARTICIPANT_EQ: ParticipantEq = Object.freeze({
  preset: 'flat',
  gains: FLAT_GAINS,
});

export function isEqBandId(value: unknown): value is EqBandId {
  return typeof value === 'string' && EQ_BANDS.some((band) => band.id === value);
}

export function isEqPresetId(value: unknown): value is EqPresetId {
  return value === 'flat' || value === 'bass' || value === 'vocal' || value === 'custom';
}

/** Rounds to a tenth of a decibel and pins the value inside the slider range. */
export function clampEqGain(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const clamped = Math.min(EQ_GAIN_MAX, Math.max(EQ_GAIN_MIN, value));
  const rounded = Math.round(clamped * 10) / 10;
  // -0 would survive into persisted JSON as a different-looking value.
  return rounded === 0 ? 0 : rounded;
}

export function gainsForPreset(preset: EqPresetName): EqGains {
  return { ...EQ_PRESET_GAINS[preset] };
}

/** Copies the gains of another participant's EQ into a fresh object. */
export function cloneParticipantEq(eq: ParticipantEq): ParticipantEq {
  return { preset: eq.preset, gains: { ...eq.gains } };
}

/** True when the EQ would not change the sound, so it need not be persisted. */
export function isFlatParticipantEq(eq: ParticipantEq): boolean {
  return eq.preset === 'flat' || EQ_BANDS.every((band) => eq.gains[band.id] === 0);
}

/**
 * Coerces persisted or user-supplied data into a usable EQ.
 *
 * A named preset always wins over its stored gains: the preset table is the
 * source of truth, so a preset's shape cannot drift when tuning it later.
 * Anything unparseable collapses to flat instead of throwing, because this
 * runs while rehydrating storage and must never block voice from starting.
 */
export function sanitizeParticipantEq(raw: unknown): ParticipantEq {
  if (typeof raw !== 'object' || raw === null) return cloneParticipantEq(DEFAULT_PARTICIPANT_EQ);

  const candidate = raw as { preset?: unknown; gains?: unknown };
  const preset = isEqPresetId(candidate.preset) ? candidate.preset : 'flat';
  if (preset !== 'custom') return { preset, gains: gainsForPreset(preset) };

  const stored = typeof candidate.gains === 'object' && candidate.gains !== null
    ? candidate.gains as Record<string, unknown>
    : {};
  const gains = {} as EqGains;
  for (const band of EQ_BANDS) gains[band.id] = clampEqGain(stored[band.id]);
  return { preset: 'custom', gains };
}

// ── Web Audio graph ───────────────────────────────────────────────────────

export interface ParticipantEqChain {
  /** Connect the track source here. */
  input: BiquadFilterNode;
  /** Connect this to the volume gain. */
  output: BiquadFilterNode;
  filters: BiquadFilterNode[];
  /** Ramps every band to new gains without rebuilding the graph. */
  setGains: (gains: EqGains) => void;
  dispose: () => void;
}

/**
 * Builds the five-filter chain for one track.
 *
 * Gains start at their final value rather than ramping up from 0: the chain is
 * constructed together with the source, so there is no audio to click yet and
 * a ramp would mute the first 20 ms of the participant's voice.
 */
export function createParticipantEqChain(
  ctx: BaseAudioContext,
  gains: EqGains,
): ParticipantEqChain {
  const filters = EQ_BANDS.map((band) => {
    const filter = ctx.createBiquadFilter();
    filter.type = band.kind;
    filter.frequency.value = band.frequency;
    filter.Q.value = band.q;
    filter.gain.value = clampEqGain(gains[band.id]);
    return filter;
  });

  for (let index = 1; index < filters.length; index += 1) {
    filters[index - 1]!.connect(filters[index]!);
  }

  const input = filters[0]!;
  const output = filters[filters.length - 1]!;

  return {
    input,
    output,
    filters,
    setGains: (next) => {
      const now = ctx.currentTime;
      filters.forEach((filter, index) => {
        const band = EQ_BANDS[index]!;
        filter.gain.setTargetAtTime(clampEqGain(next[band.id]), now, EQ_RAMP_SECONDS);
      });
    },
    dispose: () => {
      for (const filter of filters) filter.disconnect();
    },
  };
}
