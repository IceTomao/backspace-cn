import { describe, expect, it } from 'vitest';
import {
  applyStreamColorToRgb,
  cloneStreamColor,
  computeStreamColorUniforms,
  DEFAULT_CHANNEL_CURVE,
  DEFAULT_STREAM_COLOR,
  isChannelCurve,
  isChannelModified,
  isDefaultStreamColor,
  isStreamColor,
  sanitizeStreamColor,
} from './streamColor';

describe('streamColor math & validation', () => {
  it('treats default settings as an exact identity across darks, midtones, highlights and saturated colors', () => {
    expect(isDefaultStreamColor(DEFAULT_STREAM_COLOR)).toBe(true);
    const uniforms = computeStreamColorUniforms(DEFAULT_STREAM_COLOR);
    expect(uniforms.isDefault).toBe(true);
    expect(uniforms.contrast).toEqual([1, 1, 1]);
    expect(uniforms.brightnessOffset).toEqual([0, 0, 0]);
    expect(uniforms.invGamma).toEqual([1, 1, 1]);
    expect(uniforms.vibrance).toBe(0);

    const samples: Array<[number, number, number]> = [
      [0, 0, 0],
      [0.5, 0.5, 0.5],
      [1, 1, 1],
      [0.9, 0.2, 0.1],
      [0.1, 0.8, 0.6],
    ];
    for (const sample of samples) {
      expect(applyStreamColorToRgb(sample, uniforms)).toEqual(sample);
    }
  });

  it('composes All Channels with per-channel R/G/B curves without overwriting independent channels', () => {
    const color = cloneStreamColor(DEFAULT_STREAM_COLOR);
    color.all = { brightness: 60, contrast: 75, gamma: 1.2 };
    color.red = { brightness: 40, contrast: 50, gamma: 1.5 };
    color.blue = { brightness: 55, contrast: 100, gamma: 1.0 };

    expect(isChannelModified(color.all)).toBe(true);
    expect(isChannelModified(color.red)).toBe(true);
    expect(isChannelModified(color.green)).toBe(false);
    expect(isChannelModified(color.blue)).toBe(true);

    const uniforms = computeStreamColorUniforms(color);
    expect(uniforms.isDefault).toBe(false);
    // Contrast: all=1.5x; red=1.5*1.0=1.5, green=1.5*1.0=1.5, blue=1.5*2.0=3.0
    expect(uniforms.contrast[0]).toBeCloseTo(1.5, 6);
    expect(uniforms.contrast[1]).toBeCloseTo(1.5, 6);
    expect(uniforms.contrast[2]).toBeCloseTo(3.0, 6);
    // Brightness offset: all=+0.10; red=+0.10-0.10=0.0, green=+0.10, blue=+0.15
    expect(uniforms.brightnessOffset[0]).toBeCloseTo(0.0, 6);
    expect(uniforms.brightnessOffset[1]).toBeCloseTo(0.1, 6);
    expect(uniforms.brightnessOffset[2]).toBeCloseTo(0.15, 6);
    // Inverse gamma: red=1/(1.2*1.5)=1/1.8, green=1/1.2, blue=1/1.2
    expect(uniforms.invGamma[0]).toBeCloseTo(1 / 1.8, 6);
    expect(uniforms.invGamma[1]).toBeCloseTo(1 / 1.2, 6);
    expect(uniforms.invGamma[2]).toBeCloseTo(1 / 1.2, 6);
  });

  it('matches NVIDIA gamma direction: gamma > 1 lifts midtones, gamma < 1 darkens midtones while preserving 0 and 1', () => {
    const brighterMid = cloneStreamColor(DEFAULT_STREAM_COLOR);
    brighterMid.all.gamma = 2.0;
    const uHigh = computeStreamColorUniforms(brighterMid);
    expect(applyStreamColorToRgb([0, 0, 0], uHigh)).toEqual([0, 0, 0]);
    expect(applyStreamColorToRgb([1, 1, 1], uHigh)).toEqual([1, 1, 1]);
    expect(applyStreamColorToRgb([0.5, 0.5, 0.5], uHigh)[0]).toBeCloseTo(Math.SQRT1_2, 5);

    const darkerMid = cloneStreamColor(DEFAULT_STREAM_COLOR);
    darkerMid.all.gamma = 0.5;
    const uLow = computeStreamColorUniforms(darkerMid);
    expect(applyStreamColorToRgb([0.5, 0.5, 0.5], uLow)[0]).toBeCloseTo(0.25, 5);
  });

  it('applies Digital Vibrance: 0% produces grayscale, 50% is neutral, 100% boosts saturation without tinting neutrals', () => {
    const sample: [number, number, number] = [0.7, 0.4, 0.3];

    const gray = cloneStreamColor(DEFAULT_STREAM_COLOR);
    gray.digitalVibrance = 0;
    const [gr, gg, gb] = applyStreamColorToRgb(sample, computeStreamColorUniforms(gray));
    expect(gr).toBeCloseTo(gg, 6);
    expect(gg).toBeCloseTo(gb, 6);

    const boosted = cloneStreamColor(DEFAULT_STREAM_COLOR);
    boosted.digitalVibrance = 100;
    const boostUniforms = computeStreamColorUniforms(boosted);
    const [br, bg, bb] = applyStreamColorToRgb(sample, boostUniforms);
    expect(br - bb).toBeGreaterThan(sample[0] - sample[2]);

    // Neutral grey remains neutral grey even at 100% Digital Vibrance
    const [nr, ng, nb] = applyStreamColorToRgb([0.45, 0.45, 0.45], boostUniforms);
    expect(nr).toBeCloseTo(0.45, 6);
    expect(ng).toBeCloseTo(0.45, 6);
    expect(nb).toBeCloseTo(0.45, 6);
  });

  it('rotates hue across 0..359 degrees while preserving neutral greys and rotating primaries', () => {
    for (const deg of [0, 60, 120, 180, 240, 300, 359]) {
      const s = cloneStreamColor(DEFAULT_STREAM_COLOR);
      s.hue = deg;
      const [r, g, b] = applyStreamColorToRgb([0.5, 0.5, 0.5], computeStreamColorUniforms(s));
      expect(r).toBeCloseTo(0.5, 5);
      expect(g).toBeCloseTo(0.5, 5);
      expect(b).toBeCloseTo(0.5, 5);
    }

    const hue120 = cloneStreamColor(DEFAULT_STREAM_COLOR);
    hue120.hue = 120;
    const [r120, g120, b120] = applyStreamColorToRgb([1, 0, 0], computeStreamColorUniforms(hue120));
    expect(g120).toBeGreaterThan(r120);
    expect(g120).toBeGreaterThan(b120);

    const hue240 = cloneStreamColor(DEFAULT_STREAM_COLOR);
    hue240.hue = 240;
    const [r240, g240, b240] = applyStreamColorToRgb([1, 0, 0], computeStreamColorUniforms(hue240));
    expect(b240).toBeGreaterThan(r240);
    expect(b240).toBeGreaterThan(g240);
  });

  it('validates and sanitizes persisted color settings strictly within NVIDIA slider bounds', () => {
    expect(isChannelCurve(DEFAULT_CHANNEL_CURVE)).toBe(true);
    expect(isChannelCurve({ brightness: 50, contrast: 50, gamma: 0.29 })).toBe(false);
    expect(isChannelCurve({ brightness: 50, contrast: 50, gamma: 2.81 })).toBe(false);
    expect(isChannelCurve({ brightness: 50.5, contrast: 50, gamma: 1.0 })).toBe(false);

    expect(isStreamColor(DEFAULT_STREAM_COLOR)).toBe(true);
    expect(isStreamColor({ ...DEFAULT_STREAM_COLOR, hue: 360 })).toBe(false);
    expect(isStreamColor({ ...DEFAULT_STREAM_COLOR, digitalVibrance: -1 })).toBe(false);

    const sanitized = sanitizeStreamColor({
      all: { brightness: 80, contrast: 200, gamma: 1.45 },
      red: { brightness: -5, contrast: 60, gamma: 0.1 },
      green: null,
      blue: { brightness: 45, contrast: 55, gamma: 2.8 },
      digitalVibrance: 85,
      hue: 999,
    });
    expect(sanitized).toEqual({
      all: { brightness: 80, contrast: 50, gamma: 1.45 },
      red: { brightness: 50, contrast: 60, gamma: 1 },
      green: { brightness: 50, contrast: 50, gamma: 1 },
      blue: { brightness: 45, contrast: 55, gamma: 2.8 },
      digitalVibrance: 85,
      hue: 0,
    });
  });
});
