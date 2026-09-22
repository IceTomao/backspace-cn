export const MIN_IMAGE_SCALE = 1;
export const MAX_IMAGE_SCALE = 8;
export const IMAGE_VISIBLE_MARGIN = 48;

export interface ImageTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const RESET_IMAGE_TRANSFORM: ImageTransform = {
  scale: MIN_IMAGE_SCALE,
  offsetX: 0,
  offsetY: 0,
};

export function clampImageScale(scale: number): number {
  return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, scale));
}

function clampAxis(offset: number, viewportSize: number, scaledImageSize: number): number {
  const visibleSize = Math.min(IMAGE_VISIBLE_MARGIN, scaledImageSize);
  const limit = Math.max(0, (viewportSize + scaledImageSize) / 2 - visibleSize);
  return Math.min(limit, Math.max(-limit, offset));
}

export function clampImageTransform(
  transform: ImageTransform,
  viewport: Size,
  image: Size,
): ImageTransform {
  const scale = clampImageScale(transform.scale);
  if (scale <= MIN_IMAGE_SCALE) return RESET_IMAGE_TRANSFORM;

  return {
    scale,
    offsetX: clampAxis(transform.offsetX, viewport.width, image.width * scale),
    offsetY: clampAxis(transform.offsetY, viewport.height, image.height * scale),
  };
}

export function zoomImageAroundPoint(
  transform: ImageTransform,
  targetScale: number,
  point: Point,
  viewport: Size,
  image: Size,
): ImageTransform {
  const scale = clampImageScale(targetScale);
  if (scale <= MIN_IMAGE_SCALE) return RESET_IMAGE_TRANSFORM;

  const ratio = scale / transform.scale;
  const pointFromCenterX = point.x - viewport.width / 2;
  const pointFromCenterY = point.y - viewport.height / 2;

  return clampImageTransform({
    scale,
    offsetX: pointFromCenterX - (pointFromCenterX - transform.offsetX) * ratio,
    offsetY: pointFromCenterY - (pointFromCenterY - transform.offsetY) * ratio,
  }, viewport, image);
}

export function panImage(
  transform: ImageTransform,
  delta: Point,
  viewport: Size,
  image: Size,
): ImageTransform {
  if (transform.scale <= MIN_IMAGE_SCALE) return RESET_IMAGE_TRANSFORM;
  return clampImageTransform({
    ...transform,
    offsetX: transform.offsetX + delta.x,
    offsetY: transform.offsetY + delta.y,
  }, viewport, image);
}
