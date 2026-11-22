import { describe, expect, it } from 'vitest';

import {
  advancePeakHold,
  echoSuppressionStatus,
  ECHO_SUPPRESSION_FLOOR,
  ECHO_SUPPRESSION_GATE,
  peakHoldDecay,
  smoothGain,
  suppressionGain,
} from './echoSuppression';

describe('peakHoldDecay', () => {
  it('decays to roughly 1/e after one hold window', () => {
    const decay = peakHoldDecay(48_000);
    const hopsInHold = 240 / ((128 / 48_000) * 1000);
    expect(decay ** hopsInHold).toBeCloseTo(Math.exp(-1), 2);
  });

  it('stays a sane fraction for degenerate sample rates', () => {
    expect(peakHoldDecay(0)).toBeGreaterThan(0);
    expect(peakHoldDecay(0)).toBeLessThan(1);
    expect(peakHoldDecay(Number.NaN)).toBeLessThan(1);
  });
});

describe('advancePeakHold', () => {
  it('rises instantly and then decays', () => {
    expect(advancePeakHold(0, 0.5, 0.9)).toBe(0.5);
    expect(advancePeakHold(0.5, 0, 0.9)).toBeCloseTo(0.45, 5);
    expect(advancePeakHold(0.5, 0.1, 0.9)).toBeCloseTo(0.45, 5);
  });
});

describe('suppressionGain', () => {
  it('leaves the bin alone when the reference is silent', () => {
    expect(suppressionGain(0.5, 0)).toBe(1);
    expect(suppressionGain(0.5, ECHO_SUPPRESSION_GATE / 2)).toBe(1);
  });

  it('suppresses a bin that the reference fully explains', () => {
    expect(suppressionGain(0.5, 0.5)).toBeCloseTo(ECHO_SUPPRESSION_FLOOR, 6);
    expect(suppressionGain(0.5, 1)).toBeCloseTo(ECHO_SUPPRESSION_FLOOR, 6);
  });

  it('passes the bin through when the microphone is much louder than the reference', () => {
    // Speaking over the playback: 20 dB above the reference peak.
    expect(suppressionGain(5, 0.5)).toBe(1);
    // Just above the leak estimate: still suppressed, but only slightly.
    expect(suppressionGain(0.27, 0.1)).toBeCloseTo(1 - 0.14 / 0.27, 6);
  });

  it('never attenuates harder than the floor', () => {
    for (const microphone of [0.001, 0.01, 0.1, 1]) {
      expect(suppressionGain(microphone, 1)).toBeGreaterThanOrEqual(ECHO_SUPPRESSION_FLOOR);
      expect(suppressionGain(microphone, 1)).toBeLessThanOrEqual(1);
    }
  });

  it('clamps a silent microphone to the floor instead of dividing by zero', () => {
    expect(suppressionGain(0, 1)).toBe(ECHO_SUPPRESSION_FLOOR);
  });
});

describe('smoothGain', () => {
  it('attacks faster than it releases', () => {
    const attacked = 1 - smoothGain(1, ECHO_SUPPRESSION_FLOOR);
    const released = smoothGain(ECHO_SUPPRESSION_FLOOR, 1) - ECHO_SUPPRESSION_FLOOR;
    expect(attacked).toBeGreaterThan(released);
  });

  it('keeps the gain inside the legal range', () => {
    expect(smoothGain(1, 0)).toBeGreaterThanOrEqual(ECHO_SUPPRESSION_FLOOR);
    expect(smoothGain(ECHO_SUPPRESSION_FLOOR, 4)).toBeLessThanOrEqual(1);
  });
});

describe('echoSuppressionStatus', () => {
  it('maps the preference and reference source to the UI status', () => {
    expect(echoSuppressionStatus(false, 'system')).toBe('off');
    expect(echoSuppressionStatus(true, 'system')).toBe('system');
    expect(echoSuppressionStatus(true, 'app')).toBe('app');
    expect(echoSuppressionStatus(true, 'none')).toBe('unavailable');
  });
});
