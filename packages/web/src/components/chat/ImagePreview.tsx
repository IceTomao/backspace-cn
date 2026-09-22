import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useContextMenu } from '../../hooks/useContextMenu';
import { layoutPixels } from '../../platform/interfaceScale';
import { isElectron } from '../../platform/platform';
import { useContextMenuStore, type ContextMenuItem } from '../../stores/contextMenuStore';
import { useUIStore } from '../../stores/uiStore';
import { copyImageToClipboard, saveImage } from '../../utils/imageActions';
import {
  MIN_IMAGE_SCALE,
  RESET_IMAGE_TRANSFORM,
  panImage,
  zoomImageAroundPoint,
  type ImageTransform,
  type Point,
  type Size,
} from './imageTransform';

interface PinchGesture {
  distance: number;
  midpoint: Point;
  transform: ImageTransform;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function ImagePreview() {
  const { t } = useTranslation(['chat', 'common']);
  const imageUrl = useUIStore((s) => s.imagePreviewUrl);
  const closeImagePreview = useUIStore((s) => s.closeImagePreview);
  const activeModal = useUIStore((s) => s.activeModal);
  const isMobile = useUIStore((s) => s.isMobile);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<PinchGesture | null>(null);
  const transformRef = useRef<ImageTransform>(RESET_IMAGE_TRANSFORM);
  const [transform, setTransform] = useState<ImageTransform>(RESET_IMAGE_TRANSFORM);

  const applyTransform = useCallback((next: ImageTransform) => {
    transformRef.current = next;
    setTransform(next);
  }, []);

  const resetTransform = useCallback(() => {
    pointersRef.current.clear();
    pinchRef.current = null;
    applyTransform(RESET_IMAGE_TRANSFORM);
  }, [applyTransform]);

  const closePreview = useCallback(() => {
    useContextMenuStore.getState().close();
    resetTransform();
    closeImagePreview();
  }, [closeImagePreview, resetTransform]);

  const geometry = useCallback((): { viewport: Size; image: Size } | null => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image || image.offsetWidth === 0 || image.offsetHeight === 0) return null;
    const rect = viewport.getBoundingClientRect();
    return {
      viewport: { width: layoutPixels(rect.width), height: layoutPixels(rect.height) },
      image: { width: image.offsetWidth, height: image.offsetHeight },
    };
  }, []);

  const pointInViewport = useCallback((clientX: number, clientY: number): Point | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    return {
      x: layoutPixels(clientX - rect.left),
      y: layoutPixels(clientY - rect.top),
    };
  }, []);

  const imageMenuItems = useMemo<ContextMenuItem[]>(() => [
    {
      key: 'copy-preview-image',
      type: 'action',
      label: t('chat:menu.copyImage'),
      icon: <Copy className="h-4 w-4" aria-hidden="true" />,
      onClick: () => {
        if (imageUrl) void copyImageToClipboard(imageUrl);
      },
    },
    {
      key: 'save-preview-image',
      type: 'action',
      label: t('chat:menu.saveImage'),
      icon: <Download className="h-4 w-4" aria-hidden="true" />,
      onClick: () => {
        if (imageUrl) void saveImage(imageUrl);
      },
    },
  ], [imageUrl, t]);
  const { onContextMenu } = useContextMenu(imageMenuItems);

  useEffect(() => {
    resetTransform();
  }, [activeModal, imageUrl, resetTransform]);

  useEffect(() => {
    if (activeModal !== 'imagePreview') return;
    const handleResize = () => resetTransform();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [activeModal, resetTransform]);

  useEffect(() => {
    if (activeModal !== 'imagePreview') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (useContextMenuStore.getState().menu) return;
      closePreview();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, closePreview]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || activeModal !== 'imagePreview' || isMobile) return;

    const handleWheel = (event: WheelEvent) => {
      const sizes = geometry();
      const point = pointInViewport(event.clientX, event.clientY);
      if (!sizes || !point) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0015);
      applyTransform(zoomImageAroundPoint(
        transformRef.current,
        transformRef.current.scale * factor,
        point,
        sizes.viewport,
        sizes.image,
      ));
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [activeModal, applyTransform, geometry, isMobile, pointInViewport]);

  const startPinch = useCallback(() => {
    const points = [...pointersRef.current.values()];
    if (points.length < 2) {
      pinchRef.current = null;
      return;
    }
    pinchRef.current = {
      distance: Math.max(1, distance(points[0]!, points[1]!)),
      midpoint: midpoint(points[0]!, points[1]!),
      transform: transformRef.current,
    };
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const point = pointInViewport(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, point);
    if (pointersRef.current.size >= 2) startPinch();
  }, [pointInViewport, startPinch]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    const previous = pointersRef.current.get(event.pointerId);
    if (!previous) return;
    const current = pointInViewport(event.clientX, event.clientY);
    const sizes = geometry();
    if (!current || !sizes) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, current);

    const points = [...pointersRef.current.values()];
    if (points.length >= 2) {
      if (!pinchRef.current) startPinch();
      const pinch = pinchRef.current;
      if (!pinch) return;
      const currentMidpoint = midpoint(points[0]!, points[1]!);
      const targetScale = pinch.transform.scale
        * (distance(points[0]!, points[1]!) / pinch.distance);
      const zoomed = zoomImageAroundPoint(
        pinch.transform,
        targetScale,
        pinch.midpoint,
        sizes.viewport,
        sizes.image,
      );
      applyTransform(panImage(zoomed, {
        x: currentMidpoint.x - pinch.midpoint.x,
        y: currentMidpoint.y - pinch.midpoint.y,
      }, sizes.viewport, sizes.image));
      return;
    }

    if (transformRef.current.scale > MIN_IMAGE_SCALE) {
      applyTransform(panImage(transformRef.current, {
        x: current.x - previous.x,
        y: current.y - previous.y,
      }, sizes.viewport, sizes.image));
    }
  }, [applyTransform, geometry, pointInViewport, startPinch]);

  const handlePointerEnd = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (pointersRef.current.size >= 2) startPinch();
    else pinchRef.current = null;
  }, [startPinch]);

  if (activeModal !== 'imagePreview' || !imageUrl) return null;

  // Fixed positioning escapes App's 32px title bar and 1px divider. Keep the
  // preview below that native-control area without changing browser layout.
  const topInsetClass = isElectron() ? 'top-[var(--titlebar-inset)]' : 'top-0';

  return (
    <div
      ref={viewportRef}
      className={`fixed inset-x-0 bottom-0 z-[190] flex items-center justify-center overflow-hidden bg-surface-overlay animate-fade-in ${topInsetClass}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) closePreview();
      }}
    >
      <div className="absolute top-4 right-4 z-10">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center text-white/70 hover:text-white transition-colors"
          onClick={(event) => {
            event.stopPropagation();
            closePreview();
          }}
          title={t('common:actions.close')}
          aria-label={t('common:actions.close')}
        >
          <X className="h-6 w-6" aria-hidden="true" />
        </button>
      </div>
      <img
        ref={imageRef}
        src={imageUrl}
        alt={t('chat:preview.alt')}
        draggable={false}
        data-context-menu
        className={`max-w-[calc(90*var(--app-vw))] max-h-[calc(90*var(--app-vh))] select-none object-contain rounded shadow-elevation-high ${transform.scale > MIN_IMAGE_SCALE ? 'cursor-grab active:cursor-grabbing' : isMobile ? 'cursor-default' : 'cursor-zoom-in'}`}
        style={{
          touchAction: 'none',
          transform: `translate3d(${transform.offsetX}px, ${transform.offsetY}px, 0) scale(${transform.scale})`,
          transformOrigin: 'center center',
        }}
        onLoad={resetTransform}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={onContextMenu}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      />
    </div>
  );
}
