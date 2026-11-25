import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Attachment } from '@backspace/shared';
import { AttachmentRenderer } from './AttachmentRenderer';
import { MediaPrivacyButton, MediaPrivacyChannel, MediaPrivacyMessage } from './MediaPrivacy';
import { useMediaPrivacyStore } from '../../stores/mediaPrivacyStore';

const native = vi.hoisted(() => ({ android: false, call: vi.fn(), download: vi.fn() }));
vi.mock('../../platform/android', () => ({
  isAndroid: () => native.android,
  androidCall: (...args: unknown[]) => native.call(...args),
  serverUrl: (url: string) => native.android && url.startsWith('/') ? `https://home.example:2096${url}` : url,
}));
vi.mock('../../stores/uiStore', () => ({ useUIStore: (selector: (s: unknown) => unknown) => selector({ isMobile: false, openImagePreview: vi.fn() }) }));
vi.mock('../../stores/transferStore', () => ({ useTransferStore: (selector: (s: unknown) => unknown) => selector({ startDownload: native.download }) }));
vi.mock('../../i18n/formatters', () => ({ useFormatters: () => ({ formatBytes: (value: number) => `${value} bytes` }) }));
vi.mock('../ui/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));

const attachment: Attachment = { id: 'clip', messageId: 'message', originalName: 'Camera.MP4', filename: 'clip.mp4', mimetype: 'application/octet-stream',
  size: 1000, playable: false, thumbnailFilename: '/api/uploads/poster.webp', createdAt: 1 };
beforeEach(() => {
  native.android = false; native.call.mockReset().mockResolvedValue({}); native.download.mockReset();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('offers playback for legacy generic MP4 and a false server hint without preloading video bytes', () => {
  const { container } = render(<AttachmentRenderer attachment={attachment} />);
  expect(container.querySelector('video')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Play video: Camera.MP4' }));
  const video = container.querySelector('video')!;
  expect(video.src).toContain('/api/uploads/clip.mp4');
  expect(video).toHaveAttribute('preload', 'none'); expect(video).toHaveAttribute('playsinline');
  expect(video).toHaveAttribute('controls'); expect(video).not.toHaveAttribute('autoplay');
});

it('mounts media only after reveal and clears every reveal when restoring the masks', () => {
  const visit = { origin: '', spaceId: 'space', userId: 'user', channelId: 'channel' };
  const renderChannel = (includeNew = false) => (
    <MediaPrivacyChannel.Provider value={visit.channelId}>
      <MediaPrivacyButton channelId={visit.channelId} />
      <MediaPrivacyMessage.Provider value="historical">
        <AttachmentRenderer attachment={attachment} />
        <AttachmentRenderer attachment={{ ...attachment, id: 'gif', filename: 'ordinary.gif', originalName: 'ordinary.gif', mimetype: 'image/gif', thumbnailFilename: undefined }} />
      </MediaPrivacyMessage.Provider>
      {includeNew && <MediaPrivacyMessage.Provider value="new"><AttachmentRenderer attachment={attachment} /></MediaPrivacyMessage.Provider>}
    </MediaPrivacyChannel.Provider>
  );

  useMediaPrivacyStore.setState({ visit, enabled: null });
  const { container, rerender } = render(renderChannel());
  expect(container.querySelector('img, video')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Reveal media' })[0]).toBeDisabled();

  act(() => useMediaPrivacyStore.setState({ enabled: true }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Reveal media' })[0]!);
  expect(container.querySelectorAll('img')).toHaveLength(1);
  expect(container.querySelector('video')).toBeNull();
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  rerender(renderChannel(true));
  expect(screen.getAllByRole('button', { name: 'Reveal media' })).toHaveLength(2);

  fireEvent.click(screen.getByRole('button', { name: 'Show all media' }));
  expect(container.querySelectorAll('img')).toHaveLength(3);
  fireEvent.click(screen.getAllByRole('button', { name: 'Play video: Camera.MP4' })[0]!);
  expect(container.querySelector('video')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Restore media masks' }));
  expect(container.querySelector('img, video')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Reveal media' })).toHaveLength(3);
  useMediaPrivacyStore.setState({ visit: null, enabled: null });
});
it('distinguishes network failures and lets the viewer retry or download the original', () => {
  const { container } = render(<AttachmentRenderer attachment={attachment} />);
  fireEvent.click(screen.getByRole('button', { name: 'Play video: Camera.MP4' }));
  Object.defineProperty(container.querySelector('video'), 'error', { value: { code: 2 } });
  fireEvent.error(container.querySelector('video')!);
  expect(screen.getByRole('alert')).toHaveTextContent('network');
  fireEvent.click(screen.getByRole('button', { name: 'Retry playback' }));
  expect(container.querySelector('video')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Download video' }));
  expect(native.download).toHaveBeenCalledWith('/api/uploads/clip.mp4', expect.objectContaining({ mimetype: 'video/mp4', filename: 'Camera.MP4' }));
});
it('releases the previous video when another starts and pauses with position preserved while hidden', () => {
  const { container, unmount } = render(<><AttachmentRenderer attachment={attachment} /><AttachmentRenderer attachment={{ ...attachment, id: 'second', filename: 'second.mp4', originalName: 'second.mp4' }} /></>);
  fireEvent.click(screen.getByRole('button', { name: 'Play video: Camera.MP4' }));
  const first = container.querySelector('video')!;
  first.currentTime = 12;
  fireEvent.click(screen.getByRole('button', { name: 'Play video: second.mp4' }));
  fireEvent.play(container.querySelectorAll('video')[1]!);
  expect(container.querySelectorAll('video')).toHaveLength(1);
  expect(first).not.toHaveAttribute('src');
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  expect(container.querySelector('video')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Play video: Camera.MP4' }));
  const resumed = container.querySelector('video')!;
  fireEvent.loadedMetadata(resumed); expect(resumed.currentTime).toBe(12);
  unmount(); expect(resumed).not.toHaveAttribute('src');
});
it('opens native playback with the correct home server or federated origin and qualified poster URL', async () => {
  native.android = true;
  const { container, rerender } = render(<AttachmentRenderer attachment={attachment} />);
  expect(container.querySelector('img')).toHaveAttribute('src', 'https://home.example:2096/api/uploads/poster.webp');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play video: Camera.MP4' })); });
  expect(native.call).toHaveBeenCalledWith('openVideo', { url: 'https://home.example:2096/api/uploads/clip.mp4', title: 'Camera.MP4', mimetype: 'video/mp4' });
  rerender(<AttachmentRenderer attachment={{ ...attachment, filename: 'https://peer.example:8443/api/uploads/clip.mp4', thumbnailFilename: 'https://peer.example:8443/api/uploads/poster.webp' }} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play video: Camera.MP4' })); });
  expect(native.call).toHaveBeenLastCalledWith('openVideo', expect.objectContaining({ url: 'https://peer.example:8443/api/uploads/clip.mp4' }));
  expect(container.querySelector('video')).toBeNull();
});
it('keeps explicitly typed non-video files as download cards and reports native opening failures', async () => {
  const { container, rerender } = render(<AttachmentRenderer attachment={{ ...attachment, mimetype: 'application/pdf' }} />);
  expect(container.querySelector('video')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Play video: Camera.MP4' })).toBeNull();
  native.android = true; native.call.mockRejectedValue(new Error('disconnected origin'));
  rerender(<AttachmentRenderer attachment={attachment} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play video: Camera.MP4' })); });
  expect(screen.getByRole('alert')).toHaveTextContent('Could not open');
  expect(screen.getByRole('button', { name: 'Download video' })).toBeInTheDocument();
});
