import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, Embed, MessageWithUser, User } from '@backspace/shared';
import { setLanguage } from '../../i18n';
import { getReplyPreviewData, ReplyPreview } from './ReplyPreview';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

const user: User = {
  id: 'u1', username: 'login-name', displayName: '中文名字', avatar: null, banner: null,
  accentColor: null, avatarColor: null, bio: null, status: 'online', customStatus: null,
  isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null, replicatedInstances: [],
};

function message(patch: Partial<MessageWithUser> = {}): MessageWithUser {
  return {
    id: 'm1', channelId: 'c1', userId: user.id, replyToId: null, content: null,
    editedAt: null, createdAt: 1, user, attachments: [], embeds: [], reactions: [],
    ...patch,
  };
}

function attachment(mimetype: string, originalName = '文件.dat', patch: Partial<Attachment> = {}): Attachment {
  return {
    id: `a-${mimetype}`, messageId: 'm1', filename: 'stored-file', originalName,
    mimetype, size: 42, createdAt: 1, ...patch,
  };
}

function embed(patch: Partial<Embed> = {}): Embed {
  return {
    id: 'e1', messageId: 'm1', dmMessageId: null, url: 'https://example.test/image',
    embedType: 'image', provider: null, title: '链接图片', description: null,
    image: 'https://example.test/preview.png', embedUrl: null, width: null,
    height: null, color: null, createdAt: 1, ...patch,
  };
}

afterEach(async () => {
  await setLanguage('en');
});

describe('reply preview data', () => {
  it('preserves Unicode text without re-encoding it', () => {
    expect(getReplyPreviewData(message({ content: '引用中文歌曲：孤勇者' }))).toMatchObject({
      kind: 'text',
      text: '引用中文歌曲：孤勇者',
    });
  });

  it.each([
    ['image/png', 'image'],
    ['video/mp4', 'video'],
    ['audio/mpeg', 'audio'],
    ['application/pdf', 'file'],
  ] as const)('describes %s attachments as %s', (mimetype, kind) => {
    expect(getReplyPreviewData(message({ attachments: [attachment(mimetype)] })).kind).toBe(kind);
  });

  it('uses thumbnails for images and direct GIF URLs', () => {
    const image = getReplyPreviewData(message({
      attachments: [attachment('image/png', '照片.png', { filename: 'image.png', thumbnailFilename: 'thumb.png' })],
    }));
    expect(image.thumbnailUrl).toContain('thumb.png');

    const gifUrl = 'https://static.klipy.com/example.gif';
    expect(getReplyPreviewData(message({ content: gifUrl }))).toMatchObject({ kind: 'gif', thumbnailUrl: gifUrl });
  });

  it('uses resolved image embeds as link thumbnails', () => {
    expect(getReplyPreviewData(message({ content: 'https://example.test/image', embeds: [embed()] }))).toMatchObject({
      kind: 'image',
      text: '链接图片',
      thumbnailUrl: 'https://example.test/preview.png',
    });
  });

  it('renders localized attachment summaries and the remaining count', async () => {
    await setLanguage('zh');
    render(<ReplyPreview message={message({
      attachments: [attachment('video/mp4'), attachment('audio/mpeg')],
    })} />);

    expect(screen.getByText('视频')).toBeInTheDocument();
    expect(screen.getByText('+1 个附件')).toBeInTheDocument();
  });
});
