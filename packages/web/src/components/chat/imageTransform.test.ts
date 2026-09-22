import { describe, expect, it } from 'vitest';
import {
  IMAGE_VISIBLE_MARGIN,
  MAX_IMAGE_SCALE,
  RESET_IMAGE_TRANSFORM,
  clampImageScale,
  panImage,
  zoomImageAroundPoint,
} from './imageTransform';

const viewport = { width: 1000, height: 800 };
const image = { width: 400, height: 300 };

describe('imageTransform', () => {
  it('clamps scale between 1x and 8x', () => {
    expect(clampImageScale(0.25)).toBe(1);
    expect(clampImageScale(3)).toBe(3);
    expect(clampImageScale(20)).toBe(MAX_IMAGE_SCALE);
  });

  it('keeps a centered zoom centered', () => {
    expect(zoomImageAroundPoint(
      RESET_IMAGE_TRANSFORM,
      2,
      { x: viewport.width / 2, y: viewport.height / 2 },
      viewport,
      image,
    )).toEqual({ scale: 2, offsetX: 0, offsetY: 0 });
  });

  it('zooms around the pointer rather than the viewport center', () => {
    const result = zoomImageAroundPoint(
      RESET_IMAGE_TRANSFORM,
      2,
      { x: 750, y: 500 },
      viewport,
      image,
    );

    expect(result).toEqual({ scale: 2, offsetX: -250, offsetY: -100 });
  });

  it('does not pan at 1x and returns to center when zoomed back to 1x', () => {
    expect(panImage(
      RESET_IMAGE_TRANSFORM,
      { x: 100, y: 100 },
      viewport,
      image,
    )).toEqual(RESET_IMAGE_TRANSFORM);

    expect(zoomImageAroundPoint(
      { scale: 2, offsetX: 100, offsetY: 100 },
      1,
      { x: 300, y: 300 },
      viewport,
      image,
    )).toEqual(RESET_IMAGE_TRANSFORM);
  });

  it('limits panning so at least 48px of the image remains visible', () => {
    const result = panImage(
      { scale: 2, offsetX: 0, offsetY: 0 },
      { x: 10_000, y: -10_000 },
      viewport,
      image,
    );

    expect(result.offsetX).toBe((viewport.width + image.width * 2) / 2 - IMAGE_VISIBLE_MARGIN);
    expect(result.offsetY).toBe(-((viewport.height + image.height * 2) / 2 - IMAGE_VISIBLE_MARGIN));
  });
});
