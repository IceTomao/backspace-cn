import { DEFAULT_STREAM_COLOR, cloneStreamColor, isStreamColor, type StreamColorSettings } from './streamColor';

export interface HdrColor {
  exposureEv: number;
  streamColor: StreamColorSettings;
}

export const DEFAULT_HDR_COLOR: HdrColor = {
  exposureEv: 0,
  streamColor: cloneStreamColor(DEFAULT_STREAM_COLOR),
};

export function isExposureEv(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= -3 &&
    value <= 3 &&
    Math.abs(value * 10 - Math.round(value * 10)) < 1e-6
  );
}

export function isHdrColor(value: unknown): value is HdrColor {
  const color = value as Partial<HdrColor> | undefined;
  return !!color && isExposureEv(color.exposureEv) && isStreamColor(color.streamColor);
}
