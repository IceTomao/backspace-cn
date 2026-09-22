import { describe, expect, it, vi } from 'vitest';
import { normalizeMessageAssets } from './assetUrls';

vi.mock('../stores/spaceStore', () => ({
  getApiForOrigin: (origin: string) => ({
    uploads: { url: (filename: string) => `${origin}/api/uploads/${filename}` },
  }),
}));

describe('normalizeMessageAssets', () => {
  it('normalizes attachments and embed thumbnails inside a remote reply', () => {
    const message = {
      user: { avatar: null },
      replyTo: {
        user: { avatar: 'reply-avatar.png' },
        attachments: [{ filename: 'image.png', thumbnailFilename: 'thumb.png' }],
        embeds: [{ image: 'embed-preview.png' }],
      },
    };

    normalizeMessageAssets(message, 'https://remote.example');

    expect(message.replyTo.user.avatar).toBe('https://remote.example/api/uploads/reply-avatar.png');
    expect(message.replyTo.attachments[0]?.filename).toBe('https://remote.example/api/uploads/image.png');
    expect(message.replyTo.attachments[0]?.thumbnailFilename).toBe('https://remote.example/api/uploads/thumb.png');
    expect(message.replyTo.embeds[0]?.image).toBe('https://remote.example/api/uploads/embed-preview.png');
  });
});
