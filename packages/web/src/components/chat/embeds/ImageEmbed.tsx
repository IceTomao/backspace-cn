import React, { useContext } from 'react';
import type { Embed } from '@backspace/shared';
import { useUIStore } from '../../../stores/uiStore';
import { MediaPrivacyChannel } from '../MediaPrivacy';

interface ImageEmbedProps {
  embed: Embed;
}

export function ImageEmbed({ embed }: ImageEmbedProps) {
  const openImagePreview = useUIStore((s) => s.openImagePreview);
  const channelId = useContext(MediaPrivacyChannel);
  const isMobile = useUIStore((s) => s.isMobile);
  const imageUrl = embed.image ?? embed.url;
  const previewImage = () => channelId ? openImagePreview(imageUrl, channelId) : openImagePreview(imageUrl);
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
            if (isMobile) previewImage();
          }}
          onDoubleClick={() => {
            if (!isMobile) previewImage();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            previewImage();
          }}
        />
      </div>
    </div>
  );
}
