import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Attachment, Embed } from '@backspace/shared';
import { useUIStore } from '../../stores/uiStore';
import { AttachmentRenderer } from './AttachmentRenderer';
import { ImageEmbed } from './embeds/ImageEmbed';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: () => ({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

const attachment: Attachment = {
  id: 'attachment-1',
  messageId: 'message-1',
  filename: '/api/uploads/photo.png',
  originalName: 'photo.png',
  mimetype: 'image/png',
  size: 1024,
  width: 800,
  height: 600,
  createdAt: 1,
};

const embed: Embed = {
  id: 'embed-1',
  messageId: 'message-1',
  dmMessageId: null,
  url: 'https://example.com/page',
  embedType: 'image',
  provider: null,
  title: 'Embedded image',
  description: null,
  image: 'https://example.com/image.png',
  embedUrl: null,
  width: 800,
  height: 600,
  color: null,
  createdAt: 1,
};

beforeEach(() => {
  useUIStore.setState({
    activeModal: null,
    imagePreviewUrl: null,
    isMobile: false,
  });
});

describe.each([
  ['image attachment', () => <AttachmentRenderer attachment={attachment} />, 'photo.png', 'photo.png'],
  ['image embed', () => <ImageEmbed embed={embed} />, 'Embedded image', 'image.png'],
] as const)('%s preview entry', (_name, renderImage, accessibleName, expectedUrlPart) => {
  it('opens on desktop double-click but not single-click', () => {
    render(renderImage());
    const image = screen.getByRole('button', { name: accessibleName });

    fireEvent.click(image);
    expect(useUIStore.getState().imagePreviewUrl).toBeNull();

    fireEvent.doubleClick(image);
    expect(useUIStore.getState().activeModal).toBe('imagePreview');
    expect(useUIStore.getState().imagePreviewUrl).toContain(expectedUrlPart);
  });

  it('opens on a single tap in the mobile layout', () => {
    useUIStore.setState({ isMobile: true });
    render(renderImage());

    fireEvent.click(screen.getByRole('button', { name: accessibleName }));
    expect(useUIStore.getState().activeModal).toBe('imagePreview');
  });

  it('keeps keyboard activation on desktop', () => {
    render(renderImage());
    const image = screen.getByRole('button', { name: accessibleName });

    fireEvent.keyDown(image, { key: 'Enter' });
    expect(useUIStore.getState().activeModal).toBe('imagePreview');

    useUIStore.getState().closeImagePreview();
    fireEvent.keyDown(image, { key: ' ' });
    expect(useUIStore.getState().activeModal).toBe('imagePreview');
  });
});
