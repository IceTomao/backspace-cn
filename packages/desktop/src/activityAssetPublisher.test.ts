import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { ActivityAssetPublisher } from './activityAssetPublisher';

async function image(): Promise<Buffer> {
  return sharp({ create: { width: 320, height: 180, channels: 4, background: '#2266cc' } }).png().toBuffer();
}

describe('ActivityAssetPublisher', () => {
  it('normalizes and deduplicates uploads within an authenticated session', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      url: 'https://chat.example/api/activity-assets/a.webp',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const win = { isDestroyed: () => false, webContents: { session: { fetch } } } as any;
    const publisher = new ActivityAssetPublisher(() => win);
    publisher.setSession({ origin: 'https://chat.example', token: 'token' }, true);
    const source = await image();
    expect(await publisher.publish(source)).toBe('https://chat.example/api/activity-assets/a.webp');
    expect(await publisher.publish(source)).toBe('https://chat.example/api/activity-assets/a.webp');
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0]![1]!;
    expect(request.headers).toMatchObject({ Authorization: 'Bearer token', 'Content-Type': 'application/octet-stream' });
    expect((request.body as ArrayBuffer).byteLength).toBeLessThan(source.length);
  });

  it('refreshes a cached asset before the server retention window expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      url: 'https://chat.example/api/activity-assets/a.webp',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const win = { isDestroyed: () => false, webContents: { session: { fetch } } } as any;
    const publisher = new ActivityAssetPublisher(() => win);
    publisher.setSession({ origin: 'https://chat.example', token: 'token' }, true);
    const source = await image();

    await publisher.publish(source);
    now.mockReturnValue(1_000 + 25 * 60 * 60 * 1000);
    await publisher.publish(source);

    expect(fetch).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('stops attempting uploads when the server does not support the endpoint', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 404 }));
    const win = { isDestroyed: () => false, webContents: { session: { fetch } } } as any;
    const publisher = new ActivityAssetPublisher(() => win);
    publisher.setSession({ origin: 'https://old.example', token: 'token' }, true);
    const source = await image();
    expect(await publisher.publish(source)).toBeNull();
    expect(await publisher.publish(source)).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('honors the device artwork privacy setting', async () => {
    const publisher = new ActivityAssetPublisher(() => null);
    publisher.setSession({ origin: 'https://chat.example', token: 'token' }, true);
    publisher.setPreferenceEnabled(false);
    expect(publisher.canPublish()).toBe(false);
    expect(await publisher.publish(await image())).toBeNull();
  });
});
