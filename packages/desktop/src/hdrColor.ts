export interface ColorChannelCurve {
  brightness: number;
  contrast: number;
  gamma: number;
}

export interface StreamColorSettings {
  all: ColorChannelCurve;
  red: ColorChannelCurve;
  green: ColorChannelCurve;
  blue: ColorChannelCurve;
  digitalVibrance: number;
  hue: number;
}

export interface HdrColor {
  exposureEv: number;
  streamColor: StreamColorSettings;
}

export const DEFAULT_CHANNEL_CURVE: Readonly<ColorChannelCurve> = Object.freeze({
  brightness: 50,
  contrast: 50,
  gamma: 1,
});

export const DEFAULT_STREAM_COLOR: Readonly<StreamColorSettings> = Object.freeze({
  all: DEFAULT_CHANNEL_CURVE,
  red: DEFAULT_CHANNEL_CURVE,
  green: DEFAULT_CHANNEL_CURVE,
  blue: DEFAULT_CHANNEL_CURVE,
  digitalVibrance: 50,
  hue: 0,
});

export const DEFAULT_HDR_COLOR: Readonly<HdrColor> = Object.freeze({
  exposureEv: 0,
  streamColor: DEFAULT_STREAM_COLOR,
});

const CHANNEL_KEYS = ['all', 'red', 'green', 'blue'] as const;

function isValidChannelCurve(value: unknown): value is ColorChannelCurve {
  if (!value || typeof value !== 'object') return false;
  const curve = value as Partial<ColorChannelCurve>;
  return (
    typeof curve.brightness === 'number' &&
    Number.isInteger(curve.brightness) &&
    curve.brightness >= 0 &&
    curve.brightness <= 100 &&
    typeof curve.contrast === 'number' &&
    Number.isInteger(curve.contrast) &&
    curve.contrast >= 0 &&
    curve.contrast <= 100 &&
    typeof curve.gamma === 'number' &&
    Number.isFinite(curve.gamma) &&
    curve.gamma >= 0.3 &&
    curve.gamma <= 2.8 &&
    Math.abs(curve.gamma * 100 - Math.round(curve.gamma * 100)) <= 1e-6
  );
}

export function validateHdrColor(value: unknown): asserts value is HdrColor {
  if (!value || typeof value !== 'object') throw new Error('Invalid HDR color settings');
  const color = value as Partial<HdrColor>;
  if (
    typeof color.exposureEv !== 'number' ||
    !Number.isFinite(color.exposureEv) ||
    color.exposureEv < -3 ||
    color.exposureEv > 3 ||
    Math.abs(color.exposureEv * 10 - Math.round(color.exposureEv * 10)) > 1e-6 ||
    !color.streamColor ||
    typeof color.streamColor !== 'object'
  ) {
    throw new Error('Invalid HDR color settings');
  }
  const sc = color.streamColor as Partial<StreamColorSettings>;
  if (
    !isValidChannelCurve(sc.all) ||
    !isValidChannelCurve(sc.red) ||
    !isValidChannelCurve(sc.green) ||
    !isValidChannelCurve(sc.blue) ||
    typeof sc.digitalVibrance !== 'number' ||
    !Number.isInteger(sc.digitalVibrance) ||
    sc.digitalVibrance < 0 ||
    sc.digitalVibrance > 100 ||
    typeof sc.hue !== 'number' ||
    !Number.isInteger(sc.hue) ||
    sc.hue < 0 ||
    sc.hue > 359
  ) {
    throw new Error('Invalid HDR color settings');
  }
}

export function hdrColorCliArgs(color: HdrColor): string[] {
  validateHdrColor(color);
  const args: string[] = ['--exposure-tenths', String(Math.round(color.exposureEv * 10))];
  const sc = color.streamColor;
  for (const key of CHANNEL_KEYS) {
    const ch = sc[key];
    if (ch.brightness !== 50) args.push(`--${key}-brightness`, String(ch.brightness));
    if (ch.contrast !== 50) args.push(`--${key}-contrast`, String(ch.contrast));
    const gammaHundredths = Math.round(ch.gamma * 100);
    if (gammaHundredths !== 100) args.push(`--${key}-gamma`, String(gammaHundredths));
  }
  if (sc.digitalVibrance !== 50) args.push('--vibrance', String(sc.digitalVibrance));
  if (sc.hue !== 0) args.push('--hue', String(sc.hue));
  return args;
}

/**
 * Private stdin protocol: fixed 40-byte little-endian HDC2 packet.
 * Layout:
 *   0..3   magic ("HDC2")
 *   4..7   revision (uint32 LE, >= 1)
 *   8..9   exposureTenths (int16 LE, -30..30)
 *   10..15 all:   brightness, contrast, gammaHundredths (uint16 LE x 3)
 *   16..21 red:   brightness, contrast, gammaHundredths (uint16 LE x 3)
 *   22..27 green: brightness, contrast, gammaHundredths (uint16 LE x 3)
 *   28..33 blue:  brightness, contrast, gammaHundredths (uint16 LE x 3)
 *   34..35 digitalVibrance (uint16 LE, 0..100)
 *   36..37 hueDegrees (uint16 LE, 0..359)
 *   38..39 reserved (uint16 LE, 0)
 */
export function hdrColorPacket(color: HdrColor, revision: number): Buffer {
  validateHdrColor(color);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 0xffffffff) {
    throw new Error('Invalid HDR color revision');
  }
  const packet = Buffer.alloc(40);
  packet.write('HDC2', 0, 'ascii');
  packet.writeUInt32LE(revision, 4);
  packet.writeInt16LE(Math.round(color.exposureEv * 10), 8);
  let offset = 10;
  for (const key of CHANNEL_KEYS) {
    const ch = color.streamColor[key];
    packet.writeUInt16LE(ch.brightness, offset);
    packet.writeUInt16LE(ch.contrast, offset + 2);
    packet.writeUInt16LE(Math.round(ch.gamma * 100), offset + 4);
    offset += 6;
  }
  packet.writeUInt16LE(color.streamColor.digitalVibrance, 34);
  packet.writeUInt16LE(color.streamColor.hue, 36);
  packet.writeUInt16LE(0, 38);
  return packet;
}
