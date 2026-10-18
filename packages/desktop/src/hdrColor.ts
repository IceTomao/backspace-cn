export interface HdrColor { exposureEv: number; brightness: number }

export function validateHdrColor(value: unknown): asserts value is HdrColor {
  const color = value as HdrColor | undefined;
  if (!color || !Number.isFinite(color.exposureEv) || color.exposureEv < -3 || color.exposureEv > 3 ||
      Math.abs(color.exposureEv * 10 - Math.round(color.exposureEv * 10)) > 1e-6 ||
      !Number.isInteger(color.brightness) || color.brightness < -50 || color.brightness > 50) throw new Error('Invalid HDR color settings');
}

/** Private stdin protocol: little endian HDC1, revision, EV tenths, brightness. */
export function hdrColorPacket(color: HdrColor, revision: number): Buffer {
  validateHdrColor(color);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 0xffffffff) throw new Error('Invalid HDR color revision');
  const packet = Buffer.alloc(16);
  packet.write('HDC1', 'ascii'); packet.writeUInt32LE(revision, 4);
  packet.writeInt32LE(Math.round(color.exposureEv * 10), 8); packet.writeInt32LE(color.brightness, 12);
  return packet;
}
