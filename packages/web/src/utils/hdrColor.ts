export interface HdrColor { exposureEv: number; brightness: number }
export const DEFAULT_HDR_COLOR: HdrColor = { exposureEv: 0, brightness: 0 };
export function isHdrColor(value: unknown): value is HdrColor {
  const color = value as HdrColor | undefined;
  return !!color && Number.isFinite(color.exposureEv) && color.exposureEv >= -3 && color.exposureEv <= 3 &&
    Math.abs(color.exposureEv * 10 - Math.round(color.exposureEv * 10)) < 1e-6 &&
    Number.isInteger(color.brightness) && color.brightness >= -50 && color.brightness <= 50;
}
