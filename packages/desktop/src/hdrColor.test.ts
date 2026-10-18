import { describe, expect, it } from 'vitest';
import { hdrColorPacket, validateHdrColor } from './hdrColor';

describe('HDR color control protocol', () => {
  it('validates bounded finite values before writing to a native process', () => {
    for (const color of [null, {}, { exposureEv: NaN, brightness: 0 }, { exposureEv: 0.01, brightness: 0 },
      { exposureEv: Infinity, brightness: 0 }, { exposureEv: 3.1, brightness: 0 },
      { exposureEv: 0, brightness: 50.1 }, { exposureEv: '0', brightness: 0 }]) {
      expect(() => validateHdrColor(color)).toThrow();
    }
    expect(() => validateHdrColor({ exposureEv: -3, brightness: -50 })).not.toThrow();
    expect(() => validateHdrColor({ exposureEv: 3, brightness: 50 })).not.toThrow();
  });
  it('encodes a fixed sized private packet without shell/JSON interpretation', () => {
    const bytes = hdrColorPacket({ exposureEv: -1.3, brightness: 25 }, 42);
    expect(bytes.length).toBe(16);
    expect(bytes.subarray(0, 4).toString()).toBe('HDC1');
    expect(bytes.readUInt32LE(4)).toBe(42);
    expect(bytes.readInt32LE(8)).toBe(-13);
    expect(bytes.readInt32LE(12)).toBe(25);
    for (const revision of [0, -1, NaN, 0x100000000]) expect(() => hdrColorPacket({ exposureEv: 0, brightness: 0 }, revision)).toThrow();
  });
});
