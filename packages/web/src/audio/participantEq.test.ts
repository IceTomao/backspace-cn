import { describe, expect, it, vi } from 'vitest';
import {
  clampEqGain,
  createParticipantEqChain,
  DEFAULT_PARTICIPANT_EQ,
  EQ_BANDS,
  EQ_GAIN_MAX,
  EQ_GAIN_MIN,
  EQ_PRESET_GAINS,
  gainsForPreset,
  isFlatParticipantEq,
  sanitizeParticipantEq,
  type EqGains,
  type ParticipantEq,
} from './participantEq';

interface FakeGainParam {
  value: number;
  setTargetAtTime: (value: number, startTime: number, timeConstant: number) => void;
}

interface FakeFilter {
  type: string;
  frequency: { value: number };
  Q: { value: number };
  gain: FakeGainParam;
  connectedTo: FakeFilter[];
  connect: (node: FakeFilter) => FakeFilter;
  disconnect: ReturnType<typeof vi.fn>;
}

function createFakeContext() {
  const filters: FakeFilter[] = [];
  const context = {
    currentTime: 4,
    createBiquadFilter: () => {
      const filter = {} as FakeFilter;
      filter.type = 'lowpass';
      filter.frequency = { value: 0 };
      filter.Q = { value: 0 };
      filter.gain = {
        value: 0,
        setTargetAtTime: vi.fn((value: number) => {
          filter.gain.value = value;
        }),
      };
      filter.connectedTo = [];
      filter.connect = (node: FakeFilter) => {
        filter.connectedTo.push(node);
        return node;
      };
      filter.disconnect = vi.fn();
      filters.push(filter);
      return filter;
    },
  };
  return { context: context as unknown as BaseAudioContext, filters };
}

const gains = (overrides: Partial<EqGains> = {}): EqGains => ({ ...gainsForPreset('flat'), ...overrides });

describe('participant EQ presets', () => {
  it('ships every preset inside the slider range', () => {
    for (const preset of Object.values(EQ_PRESET_GAINS)) {
      for (const band of EQ_BANDS) {
        expect(preset[band.id]).toBeGreaterThanOrEqual(EQ_GAIN_MIN);
        expect(preset[band.id]).toBeLessThanOrEqual(EQ_GAIN_MAX);
      }
    }
  });

  it('leaves the flat preset silent on every band', () => {
    const flat = gainsForPreset('flat');
    for (const band of EQ_BANDS) expect(flat[band.id]).toBe(0);
    expect(isFlatParticipantEq(DEFAULT_PARTICIPANT_EQ)).toBe(true);
  });

  it('lifts the low end and softens the top for the bass preset', () => {
    const bass = gainsForPreset('bass');
    expect(bass.low).toBeGreaterThan(0);
    expect(bass.lowMid).toBeGreaterThan(0);
    expect(bass.high).toBeLessThan(0);
  });

  it('cuts rumble and adds presence for the vocal preset', () => {
    const vocal = gainsForPreset('vocal');
    expect(vocal.low).toBeLessThan(0);
    expect(vocal.presence).toBeGreaterThan(0);
  });

  it('hands out copies so callers cannot mutate the preset table', () => {
    const bass = gainsForPreset('bass');
    bass.low = -12;
    expect(gainsForPreset('bass').low).toBe(EQ_PRESET_GAINS.bass.low);
  });
});

describe('clampEqGain', () => {
  it('pins values to the slider range', () => {
    expect(clampEqGain(40)).toBe(EQ_GAIN_MAX);
    expect(clampEqGain(-40)).toBe(EQ_GAIN_MIN);
  });

  it('rounds to a tenth of a decibel', () => {
    expect(clampEqGain(3.14159)).toBe(3.1);
    expect(clampEqGain(-0.04)).toBe(0);
  });

  it('falls back to zero for non-numeric input', () => {
    expect(clampEqGain(Number.NaN)).toBe(0);
    expect(clampEqGain(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampEqGain('6')).toBe(0);
    expect(clampEqGain(undefined)).toBe(0);
  });
});

describe('sanitizeParticipantEq', () => {
  it('collapses missing or malformed data to flat', () => {
    for (const raw of [null, undefined, 42, 'bass', [], { preset: 'loud' }]) {
      expect(sanitizeParticipantEq(raw)).toEqual(DEFAULT_PARTICIPANT_EQ);
    }
  });

  it('restores a named preset from the preset table, not from stored gains', () => {
    const eq = sanitizeParticipantEq({
      preset: 'vocal',
      gains: { low: 12, lowMid: 12, mid: 12, presence: 12, high: 12 },
    });
    expect(eq).toEqual({ preset: 'vocal', gains: gainsForPreset('vocal') });
  });

  it('clamps custom gains and fills missing bands with zero', () => {
    const eq = sanitizeParticipantEq({ preset: 'custom', gains: { low: 99, high: -99 } });
    expect(eq.preset).toBe('custom');
    expect(eq.gains.low).toBe(EQ_GAIN_MAX);
    expect(eq.gains.high).toBe(EQ_GAIN_MIN);
    expect(eq.gains.mid).toBe(0);
    expect(eq.gains.lowMid).toBe(0);
    expect(eq.gains.presence).toBe(0);
  });

  it('survives a custom preset without a gains object', () => {
    expect(sanitizeParticipantEq({ preset: 'custom' })).toEqual({
      preset: 'custom',
      gains: gainsForPreset('flat'),
    });
  });

  it('treats a custom curve of all zeroes as flat', () => {
    const zero: ParticipantEq = { preset: 'custom', gains: gains() };
    expect(isFlatParticipantEq(zero)).toBe(true);
    expect(isFlatParticipantEq({ preset: 'custom', gains: gains({ high: 0.1 }) })).toBe(false);
  });
});

describe('createParticipantEqChain', () => {
  it('builds one filter per band in series', () => {
    const { context, filters } = createFakeContext();
    const chain = createParticipantEqChain(context, gains({ mid: 4 }));

    expect(filters).toHaveLength(EQ_BANDS.length);
    filters.forEach((filter, index) => {
      const band = EQ_BANDS[index]!;
      expect(filter.type).toBe(band.kind);
      expect(filter.frequency.value).toBe(band.frequency);
      expect(filter.Q.value).toBe(band.q);
    });
    expect(chain.input).toBe(filters[0]);
    expect(chain.output).toBe(filters[filters.length - 1]);
    expect(filters[0]!.connectedTo).toEqual([filters[1]]);
    expect(filters[1]!.connectedTo).toEqual([filters[2]]);
    expect(filters[filters.length - 1]!.connectedTo).toEqual([]);
  });

  it('starts at the requested gains so the first samples are already shaped', () => {
    const { context, filters } = createFakeContext();
    createParticipantEqChain(context, gains({ low: 8, high: -3 }));

    expect(filters[0]!.gain.value).toBe(8);
    expect(filters[4]!.gain.value).toBe(-3);
    expect(filters[0]!.gain.setTargetAtTime).not.toHaveBeenCalled();
  });

  it('ramps every band when gains change', () => {
    const { context, filters } = createFakeContext();
    const chain = createParticipantEqChain(context, gains());

    chain.setGains(gains({ low: -6, mid: 3 }));

    expect(filters[0]!.gain.setTargetAtTime).toHaveBeenCalledWith(-6, 4, expect.any(Number));
    expect(filters[2]!.gain.setTargetAtTime).toHaveBeenCalledWith(3, 4, expect.any(Number));
    expect(filters[4]!.gain.value).toBe(0);
  });

  it('clamps out-of-range gains on the way to the graph', () => {
    const { context, filters } = createFakeContext();
    const chain = createParticipantEqChain(context, gains());
    chain.setGains(gains({ presence: 50 }));

    expect(filters[3]!.gain.value).toBe(EQ_GAIN_MAX);
  });

  it('disconnects every filter on dispose', () => {
    const { context, filters } = createFakeContext();
    createParticipantEqChain(context, gains()).dispose();

    for (const filter of filters) expect(filter.disconnect).toHaveBeenCalledTimes(1);
  });
});
