import React from 'react';
import type { Embed } from '@backspace/shared';
import { useUIStore } from '../../../stores/uiStore';

interface ImageEmbedProps {
  embed: Embed;
}

export function ImageEmbed({ embed }: ImageEmbedProps) {
  const openImagePreview = useUIStore((s) => s.openImagePreview);
  const isMobile = useUIStore((s) => s.isMobile);
  const imageUrl = embed.image ?? embed.url;
  const { width, height } = embed;

  return (
    <div className="mt-2 max-w-fit">
      <div
        className="relative rounded-lg overflow-hidden"
        style={width && height ? { aspectRatio: `${width}/${height}`, maxWidth: Math.min(width, 400), maxHeight: 300 } : undefined}
      >
        <img
          src={imageUrl}
          alt={embed.title ?? ''}
          role="button"
          tabIndex={0}
          draggable={false}
          className={`w-full h-full max-w-[400px] max-h-[300px] object-contain rounded-lg hover:opacity-90 transition-opacity ${isMobile ? 'cursor-pointer' : 'cursor-zoom-in'}`}
          loading="lazy"
          referrerPolicy="no-referrer"
          onClick={() => {
            if (isMobile) openImagePreview(imageUrl);
          }}
          onDoubleClick={() => {
            if (!isMobile) openImagePreview(imageUrl);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            openImagePreview(imageUrl);
          }}
        />
      </div>
    </div>
  );
}
