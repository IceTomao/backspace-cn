import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  execute: vi.fn(),
  addListener: vi.fn(),
  platform: 'android',
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => native.platform },
  registerPlugin: () => native,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('MODE', 'android');
  native.platform = 'android';
  native.execute.mockReset().mockResolvedValue({});
  native.addListener.mockReset();
  localStorage.clear();
});

describe('Android platform boundary', () => {
  it('resolves API and media to selected server, preserving absolute attachments', async () => {
    const platform = await import('./android');
    expect(platform.serverUrl('/api/auth/login')).toBe('https://chat.kevz.me:2096/api/auth/login');
    platform.setAndroidServer('https://second.example:8443');
    expect(platform.serverUrl('/api/uploads/image.png')).toBe('https://second.example:8443/api/uploads/image.png');
    expect(platform.serverLocation().host).toBe('second.example:8443');
    expect(platform.serverUrl('blob:https://localhost/image')).toBe('blob:https://localhost/image');
    expect(platform.serverUrl('https://peer.example/image.png')).toBe('https://peer.example/image.png');
  });
  it('rejects insecure servers and URL credentials', async () => {
    const { normalizeAndroidServer } = await import('./android');
    for (const url of ['http://example.com', 'https://a:b@example.com', 'https://example.com/api', 'https://example.com?q=1']) {
      expect(() => normalizeAndroidServer(url)).toThrow();
    }
    expect(normalizeAndroidServer('chat.kevz.me:2096/')).toBe('https://chat.kevz.me:2096');
  });
  it('does not change web or Windows origin and storage behavior', async () => {
    native.platform = 'web';
    const { serverUrl } = await import('./android');
    const { appStorage } = await import('./appStorage');
    expect(serverUrl('/api/uploads/a')).toBe('/api/uploads/a');
    appStorage.setItem('test', 'value');
    expect(localStorage.getItem('test')).toBe('value');
    expect(native.execute).not.toHaveBeenCalled();
  });
  it('keeps credentials in runtime memory and delegates persistence to vault', async () => {
    const { hydrateAppStorage, appStorage, flushAppStorage, profileDatabaseName } = await import('./appStorage');
    hydrateAppStorage({ backspace_token: 'fake-runtime-token' });
    expect(appStorage.getItem('backspace_token')).toBe('fake-runtime-token');
    expect(localStorage.getItem('backspace_token')).toBeNull();
    appStorage.setItem('theme', 'dark');
    await flushAppStorage();
    expect(native.execute).toHaveBeenCalledWith({ action: 'storage', data: { key: 'theme', value: 'dark' } });
    expect(profileDatabaseName('cache')).toContain('https://chat.kevz.me:2096');
    hydrateAppStorage({ backspace_token: 'second-profile' });
    expect(appStorage.getItem('theme')).toBeNull();
  });
  it('reports save failure instead of treating a session as persisted', async () => {
    native.execute.mockRejectedValue(new Error('storage full'));
    const { appStorage, flushAppStorage } = await import('./appStorage');
    const listener = vi.fn();
    window.addEventListener('android-storage-error', listener);
    appStorage.setItem('backspace_token', 'test');
    await expect(flushAppStorage()).rejects.toThrow('storage full');
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('android-storage-error', listener);
  });
  it('cleans up a listener even if registration resolves after unmount', async () => {
    let resolve!: (value: { remove: () => Promise<void> }) => void;
    native.addListener.mockReturnValue(new Promise(done => { resolve = done; }));
    const remove = vi.fn().mockResolvedValue(undefined);
    const { onAndroid } = await import('./android');
    const dispose = onAndroid('voice', () => {});
    dispose();
    resolve({ remove });
    await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce();
  });
});
