import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false } }));

import { WindowsMediaProvider } from './windowsMediaProvider';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('WindowsMediaProvider artwork', () => {
  it('publishes an SMTC thumbnail and replaces the player icon', async () => {
    const publisher = { canPublish: () => true, publish: vi.fn(async () => 'https://chat.example/cover.webp'), subscribe: () => () => {} } as any;
    const provider = new WindowsMediaProvider(publisher) as any;
    provider.onChange = vi.fn();
    provider.apply({ source: 'Spotify.exe', title: '歌曲', artist: '歌手', album: '专辑', status: 'playing', thumbnailBase64: Buffer.from('cover').toString('base64') });
    await vi.waitFor(() => expect(provider.getActivities()[0]?.assets?.largeImage).toBe('https://chat.example/cover.webp'));
    expect(publisher.publish).toHaveBeenCalledOnce();
  });

  it('does not apply a late cover to a newer song', async () => {
    const old = deferred<string | null>();
    const publisher = {
      canPublish: () => true,
      publish: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce('https://chat.example/new.webp'),
      subscribe: () => () => {},
    } as any;
    const provider = new WindowsMediaProvider(publisher) as any;
    provider.onChange = vi.fn();
    provider.apply({ source: 'Spotify.exe', title: 'Old', status: 'playing', thumbnailBase64: Buffer.from('old').toString('base64') });
    provider.apply({ source: 'Spotify.exe', title: 'New', status: 'playing', thumbnailBase64: Buffer.from('new').toString('base64') });
    await vi.waitFor(() => expect(provider.getActivities()[0]?.assets?.largeImage).toBe('https://chat.example/new.webp'));
    old.resolve('https://chat.example/old.webp');
    await Promise.resolve();
    expect(provider.getActivities()[0]?.details).toBe('New');
    expect(provider.getActivities()[0]?.assets?.largeImage).toBe('https://chat.example/new.webp');
  });

  it('keeps the branded player icon when no thumbnail is available', () => {
    const provider = new WindowsMediaProvider() as any;
    provider.onChange = vi.fn();
    provider.apply({ source: 'cloudmusic.exe', title: '中文歌曲', artist: '歌手', status: 'playing' });
    expect(provider.getActivities()[0]).toMatchObject({
      name: '网易云音乐', details: '中文歌曲', state: '歌手', assets: { largeImage: expect.stringMatching(/^https:\/\//) },
    });
  });
});
