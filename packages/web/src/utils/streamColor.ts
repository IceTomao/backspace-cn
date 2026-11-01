export const COLOR_CHANNEL_KEYS = ['all', 'red', 'green', 'blue'] as const;
export type ColorChannelKey = (typeof COLOR_CHANNEL_KEYS)[number];

export interface ColorChannelCurve {
  /** 0..100 integer percentage; 50 is neutral. */
  brightness: number;
  /** 0..100 integer percentage; 50 is neutral. */
  contrast: number;
  /** 0.30..2.80 in 0.01 increments; 1.00 is neutral. */
  gamma: number;
}

export interface StreamColorSettings {
  all: ColorChannelCurve;
  red: ColorChannelCurve;
  green: ColorChannelCurve;
  blue: ColorChannelCurve;
  /** 0..100 integer percentage; 50 is neutral, 0 is grayscale, 100 is max vibrance. */
  digitalVibrance: number;
  /** 0..359 integer degrees; 0 is neutral. */
  hue: number;
}

export interface StreamColorUniforms {
  isDefault: boolean;
  contrast: [number, number, number];
  brightnessOffset: [number, number, number];
  invGamma: [number, number, number];
  vibrance: number;
  /** Column-major 3x3 matrix for WebGL `uniformMatrix3fv(..., false, hueMatrix)`. */
  hueMatrix: Float32Array;
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

export function cloneStreamColor(settings: StreamColorSettings = DEFAULT_STREAM_COLOR): StreamColorSettings {
  return {
    all: { ...settings.all },
    red: { ...settings.red },
    green: { ...settings.green },
    blue: { ...settings.blue },
    digitalVibrance: settings.digitalVibrance,
    hue: settings.hue,
  };
}

export function isChannelCurve(value: unknown): value is ColorChannelCurve {
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
    Math.abs(curve.gamma * 100 - Math.round(curve.gamma * 100)) < 1e-6
  );
}

export function isStreamColor(value: unknown): value is StreamColorSettings {
  if (!value || typeof value !== 'object') return false;
  const color = value as Partial<StreamColorSettings>;
  return (
    isChannelCurve(color.all) &&
    isChannelCurve(color.red) &&
    isChannelCurve(color.green) &&
    isChannelCurve(color.blue) &&
    typeof color.digitalVibrance === 'number' &&
    Number.isInteger(color.digitalVibrance) &&
    color.digitalVibrance >= 0 &&
    color.digitalVibrance <= 100 &&
    typeof color.hue === 'number' &&
    Number.isInteger(color.hue) &&
    color.hue >= 0 &&
    color.hue <= 359
  );
}

export function sanitizeChannelCurve(value: unknown): ColorChannelCurve {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CHANNEL_CURVE };
  const raw = value as Partial<ColorChannelCurve>;
  const brightness =
    typeof raw.brightness === 'number' && Number.isInteger(raw.brightness) && raw.brightness >= 0 && raw.brightness <= 100
      ? raw.brightness
      : DEFAULT_CHANNEL_CURVE.brightness;
  const contrast =
    typeof raw.contrast === 'number' && Number.isInteger(raw.contrast) && raw.contrast >= 0 && raw.contrast <= 100
      ? raw.contrast
      : DEFAULT_CHANNEL_CURVE.contrast;
  const gamma =
    typeof raw.gamma === 'number' &&
    Number.isFinite(raw.gamma) &&
    raw.gamma >= 0.3 &&
    raw.gamma <= 2.8 &&
    Math.abs(raw.gamma * 100 - Math.round(raw.gamma * 100)) < 1e-6
      ? Math.round(raw.gamma * 100) / 100
      : DEFAULT_CHANNEL_CURVE.gamma;
  return { brightness, contrast, gamma };
}

export function sanitizeStreamColor(value: unknown): StreamColorSettings {
  if (!value || typeof value !== 'object') return cloneStreamColor(DEFAULT_STREAM_COLOR);
  const raw = value as Partial<StreamColorSettings>;
  const digitalVibrance =
    typeof raw.digitalVibrance === 'number' &&
    Number.isInteger(raw.digitalVibrance) &&
    raw.digitalVibrance >= 0 &&
    raw.digitalVibrance <= 100
      ? raw.digitalVibrance
      : DEFAULT_STREAM_COLOR.digitalVibrance;
  const hue =
    typeof raw.hue === 'number' && Number.isInteger(raw.hue) && raw.hue >= 0 && raw.hue <= 359
      ? raw.hue
      : DEFAULT_STREAM_COLOR.hue;
  return {
    all: sanitizeChannelCurve(raw.all),
    red: sanitizeChannelCurve(raw.red),
    green: sanitizeChannelCurve(raw.green),
    blue: sanitizeChannelCurve(raw.blue),
    digitalVibrance,
    hue,
  };
}

export function isChannelModified(curve: ColorChannelCurve): boolean {
  return (
    curve.brightness !== DEFAULT_CHANNEL_CURVE.brightness ||
    curve.contrast !== DEFAULT_CHANNEL_CURVE.contrast ||
    Math.round(curve.gamma * 100) !== 100
  );
}

export function isDefaultStreamColor(settings: StreamColorSettings): boolean {
  return (
    !isChannelModified(settings.all) &&
    !isChannelModified(settings.red) &&
    !isChannelModified(settings.green) &&
    !isChannelModified(settings.blue) &&
    settings.digitalVibrance === DEFAULT_STREAM_COLOR.digitalVibrance &&
    settings.hue === DEFAULT_STREAM_COLOR.hue
  );
}

export function buildHueMatrix(hueDegrees: number): Float32Array {
  if (hueDegrees === 0) {
    return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  }
  const rad = (hueDegrees * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);

  const m00 = 0.213 + 0.787 * c - 0.213 * s;
  const m01 = 0.715 - 0.715 * c - 0.715 * s;
  const m02 = 0.072 - 0.072 * c + 0.928 * s;

  const m10 = 0.213 - 0.213 * c + 0.143 * s;
  const m11 = 0.715 + 0.285 * c + 0.140 * s;
  const m12 = 0.072 - 0.072 * c - 0.283 * s;

  const m20 = 0.213 - 0.213 * c - 0.787 * s;
  const m21 = 0.715 - 0.715 * c + 0.715 * s;
  const m22 = 0.072 + 0.928 * c + 0.072 * s;

  // Column-major layout for WebGL mat3: [col0, col1, col2]
  return new Float32Array([m00, m10, m20, m01, m11, m21, m02, m12, m22]);
}

export function computeStreamColorUniforms(settings: StreamColorSettings): StreamColorUniforms {
  const { all, red, green, blue } = settings;
  const channels = [red, green, blue] as const;

  const contrast: [number, number, number] = [1, 1, 1];
  const brightnessOffset: [number, number, number] = [0, 0, 0];
  const invGamma: [number, number, number] = [1, 1, 1];

  const allContrast = all.contrast / 50;
  const allBrightness = (all.brightness - 50) / 100;

  for (let i = 0; i < 3; i++) {
    const ch = channels[i]!;
    contrast[i] = allContrast * (ch.contrast / 50);
    brightnessOffset[i] = allBrightness + (ch.brightness - 50) / 100;
    const effectiveGamma = Math.min(7.84, Math.max(0.09, all.gamma * ch.gamma));
    invGamma[i] = 1 / effectiveGamma;
  }

  return {
    isDefault: isDefaultStreamColor(settings),
    contrast,
    brightnessOffset,
    invGamma,
    vibrance: (settings.digitalVibrance - 50) / 50,
    hueMatrix: buildHueMatrix(settings.hue),
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Reference evaluation matching the WebGL2 / D3D11 shader math on normalized [0, 1] RGB. */
export function applyStreamColorToRgb(
  rgb: readonly [number, number, number],
  uniforms: StreamColorUniforms,
): [number, number, number] {
  if (uniforms.isDefault) return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];

  let r = Math.pow(clamp01((rgb[0] - 0.5) * uniforms.contrast[0] + 0.5 + uniforms.brightnessOffset[0]), uniforms.invGamma[0]);
  let g = Math.pow(clamp01((rgb[1] - 0.5) * uniforms.contrast[1] + 0.5 + uniforms.brightnessOffset[1]), uniforms.invGamma[1]);
  let b = Math.pow(clamp01((rgb[2] - 0.5) * uniforms.contrast[2] + 0.5 + uniforms.brightnessOffset[2]), uniforms.invGamma[2]);

  if (uniforms.vibrance !== 0) {
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    const scale = uniforms.vibrance < 0 ? 1 + uniforms.vibrance : 1 + uniforms.vibrance * (2 - sat);
    r = clamp01(luma + (r - luma) * scale);
    g = clamp01(luma + (g - luma) * scale);
    b = clamp01(luma + (b - luma) * scale);
  }

  const m = uniforms.hueMatrix;
  const hr = clamp01(m[0]! * r + m[3]! * g + m[6]! * b);
  const hg = clamp01(m[1]! * r + m[4]! * g + m[7]! * b);
  const hb = clamp01(m[2]! * r + m[5]! * g + m[8]! * b);
  return [hr, hg, hb];
}
