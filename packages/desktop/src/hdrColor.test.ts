import { describe, expect, it } from 'vitest';
import { DEFAULT_STREAM_COLOR, hdrColorPacket, validateHdrColor, type StreamColorSettings } from './hdrColor';

function cloneColor(): StreamColorSettings {
  return {
    all: { ...DEFAULT_STREAM_COLOR.all },
    red: { ...DEFAULT_STREAM_COLOR.red },
    green: { ...DEFAULT_STREAM_COLOR.green },
    blue: { ...DEFAULT_STREAM_COLOR.blue },
    digitalVibrance: DEFAULT_STREAM_COLOR.digitalVibrance,
    hue: DEFAULT_STREAM_COLOR.hue,
  };
}

describe('HDR color control protocol (HDC2)', () => {
  it('validates bounded finite values across exposure and all 4 color channels before writing to a native process', () => {
    const valid = cloneColor();
    for (const color of [
      null,
      {},
      { exposureEv: 0 },
      { exposureEv: NaN, streamColor: valid },
      { exposureEv: 0.01, streamColor: valid },
      { exposureEv: Infinity, streamColor: valid },
      { exposureEv: 3.1, streamColor: valid },
      { exposureEv: '0', streamColor: valid },
      { exposureEv: 0, streamColor: { ...valid, digitalVibrance: 101 } },
      { exposureEv: 0, streamColor: { ...valid, digitalVibrance: -1 } },
      { exposureEv: 0, streamColor: { ...valid, hue: 360 } },
      { exposureEv: 0, streamColor: { ...valid, hue: -1 } },
      { exposureEv: 0, streamColor: { ...valid, all: { brightness: 101, contrast: 50, gamma: 1 } } },
      { exposureEv: 0, streamColor: { ...valid, red: { brightness: 50, contrast: -1, gamma: 1 } } },
      { exposureEv: 0, streamColor: { ...valid, green: { brightness: 50, contrast: 50, gamma: 0.29 } } },
      { exposureEv: 0, streamColor: { ...valid, blue: { brightness: 50, contrast: 50, gamma: 2.81 } } },
      { exposureEv: 0, streamColor: { ...valid, blue: { brightness: 50, contrast: 50, gamma: 1.005 } } },
    ]) {
      expect(() => validateHdrColor(color)).toThrow();
    }
    expect(() => validateHdrColor({ exposureEv: -3, streamColor: valid })).not.toThrow();
    expect(() => validateHdrColor({ exposureEv: 3, streamColor: valid })).not.toThrow();
  });

  it('encodes a fixed 40-byte HDC2 little-endian packet without shell/JSON interpretation', () => {
    const sc = cloneColor();
    sc.all = { brightness: 60, contrast: 70, gamma: 1.25 };
    sc.red = { brightness: 45, contrast: 55, gamma: 0.9 };
    sc.green = { brightness: 52, contrast: 48, gamma: 1.1 };
    sc.blue = { brightness: 50, contrast: 80, gamma: 2.0 };
    sc.digitalVibrance = 85;
    sc.hue = 240;

    const bytes = hdrColorPacket({ exposureEv: -1.3, streamColor: sc }, 42);
    expect(bytes.length).toBe(40);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('HDC2');
    expect(bytes.readUInt32LE(4)).toBe(42);
    expect(bytes.readInt16LE(8)).toBe(-13);
    // all
    expect(bytes.readUInt16LE(10)).toBe(60);
    expect(bytes.readUInt16LE(12)).toBe(70);
    expect(bytes.readUInt16LE(14)).toBe(125);
    // red
    expect(bytes.readUInt16LE(16)).toBe(45);
    expect(bytes.readUInt16LE(18)).toBe(55);
    expect(bytes.readUInt16LE(20)).toBe(90);
    // green
    expect(bytes.readUInt16LE(22)).toBe(52);
    expect(bytes.readUInt16LE(24)).toBe(48);
    expect(bytes.readUInt16LE(26)).toBe(110);
    // blue
    expect(bytes.readUInt16LE(28)).toBe(50);
    expect(bytes.readUInt16LE(30)).toBe(80);
    expect(bytes.readUInt16LE(32)).toBe(200);
    // vibrance, hue, reserved
    expect(bytes.readUInt16LE(34)).toBe(85);
    expect(bytes.readUInt16LE(36)).toBe(240);
    expect(bytes.readUInt16LE(38)).toBe(0);

    for (const revision of [0, -1, NaN, 0x100000000]) {
      expect(() => hdrColorPacket({ exposureEv: 0, streamColor: sc }, revision)).toThrow();
    }
  });
});
