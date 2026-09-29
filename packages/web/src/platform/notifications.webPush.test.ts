import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enableWebPush,
  syncWebPushSubscription,
} from './notifications';

const mocks = vi.hoisted(() => ({
  webPush: vi.fn(),
  subscribeWebPush: vi.fn(),
  unsubscribeWebPush: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: {
    notifications: {
      webPush: mocks.webPush,
      subscribeWebPush: mocks.subscribeWebPush,
      unsubscribeWebPush: mocks.unsubscribeWebPush,
    },
  },
}));

vi.mock('./platform', () => ({ isElectron: () => false }));
vi.mock('./android', () => ({
  androidCall: vi.fn(),
  isAndroid: () => false,
  onAndroid: () => () => {},
}));

const subscription = {
  endpoint: 'https://push.example/subscription',
  toJSON: () => ({
    endpoint: 'https://push.example/subscription',
    keys: { p256dh: 'public-key', auth: 'auth-key' },
  }),
};

let getSubscription: ReturnType<typeof vi.fn>;
let subscribe: ReturnType<typeof vi.fn>;
let requestPermission: ReturnType<typeof vi.fn>;

function installServiceWorker() {
  getSubscription = vi.fn().mockResolvedValue(null);
  subscribe = vi.fn().mockResolvedValue(subscription);
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: { getSubscription, subscribe },
      }),
    },
  });
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PushManager', class PushManager {});
  requestPermission = vi.fn().mockResolvedValue('granted');
  vi.stubGlobal('Notification', class Notification {
    static permission = 'granted';
    static requestPermission = requestPermission;
  });
  installServiceWorker();
  mocks.webPush.mockResolvedValue({ enabled: true, publicKey: 'server-public-key' });
  mocks.subscribeWebPush.mockResolvedValue({ ok: true });
});

afterEach(() => {
  delete (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }).serviceWorker;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('enableWebPush', () => {
  it('rejects when the browser lacks PushManager support', async () => {
    Reflect.deleteProperty(window, 'PushManager');
    await expect(enableWebPush()).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(mocks.webPush).not.toHaveBeenCalled();
  });

  it('rejects when the server has no VAPID configuration', async () => {
    mocks.webPush.mockResolvedValue({ enabled: false, publicKey: null });
    await expect(enableWebPush()).rejects.toMatchObject({
      code: 'notConfigured',
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('rejects when browser notification permission is denied', async () => {
    requestPermission.mockResolvedValue('denied');
    Object.defineProperty(Notification, 'permission', { configurable: true, value: 'default' });
    await expect(enableWebPush()).rejects.toMatchObject({
      code: 'permissionDenied',
    });
    expect(mocks.webPush).not.toHaveBeenCalled();
  });

  it('reports a service worker subscription failure', async () => {
    const error = Object.assign(new Error('Push service rejected the request'), { name: 'NotAllowedError' });
    subscribe.mockRejectedValue(error);
    await expect(enableWebPush()).rejects.toMatchObject({
      code: 'subscriptionFailed',
      diagnostic: {
        stage: 'subscribe',
        errorName: 'NotAllowedError',
        errorMessage: 'Push service rejected the request',
      },
    });
    expect(mocks.subscribeWebPush).not.toHaveBeenCalled();
  });

  it('redacts URLs and long tokens from browser error details', async () => {
    subscribe.mockRejectedValue(new Error(
      'Failed at https://push.example/private with token abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
    ));
    await expect(enableWebPush()).rejects.toMatchObject({
      diagnostic: {
        stage: 'subscribe',
        errorMessage: 'Failed at [URL] with token [redacted]',
      },
    });
  });

  it('reports a server registration failure instead of treating permission as success', async () => {
    mocks.subscribeWebPush.mockRejectedValue(new Error('server rejected subscription'));
    await expect(enableWebPush()).rejects.toMatchObject({
      code: 'registrationFailed',
    });
  });

  it('returns success only after the server accepts the subscription', async () => {
    await expect(enableWebPush()).resolves.toBe(true);
    expect(mocks.subscribeWebPush).toHaveBeenCalledWith(subscription.toJSON());
  });
});

describe('syncWebPushSubscription', () => {
  it('does not treat granted permission without an actual subscription as enabled', async () => {
    await expect(syncWebPushSubscription()).resolves.toBe(false);
    expect(mocks.webPush).not.toHaveBeenCalled();
    expect(mocks.subscribeWebPush).not.toHaveBeenCalled();
  });

  it('re-registers an existing subscription for the signed-in account', async () => {
    getSubscription.mockResolvedValue(subscription);
    await expect(syncWebPushSubscription()).resolves.toBe(true);
    expect(mocks.subscribeWebPush).toHaveBeenCalledWith(subscription.toJSON());
  });

  it('keeps the subscription inactive when server registration fails', async () => {
    getSubscription.mockResolvedValue(subscription);
    mocks.subscribeWebPush.mockRejectedValue(new Error('server rejected subscription'));
    await expect(syncWebPushSubscription()).rejects.toMatchObject({
      code: 'registrationFailed',
    });
  });
});
