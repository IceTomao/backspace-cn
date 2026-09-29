import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const schema = {
    channelNotificationSettings: { userId: {}, channelId: {}, muted: {} },
    pushSubscriptions: { id: {}, userId: {}, endpoint: {}, p256dh: {}, auth: {} },
  };
  return {
    schema,
    subscriptions: [] as Array<{
      id: string;
      userId: string;
      endpoint: string;
      p256dh: string;
      auth: string;
    }>,
    mutedUsers: [] as Array<{ userId: string }>,
    sendNotification: vi.fn(),
    db: {
      select: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock('web-push', () => ({
  default: { sendNotification: mocks.sendNotification },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => mocks.db,
  schema: mocks.schema,
}));

vi.mock('../config.js', () => ({
  config: { webPush: { publicKey: 'public', privateKey: 'private', subject: 'mailto:test@example.test' } },
}));

import { sendWebPushToUsers } from './webPush.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscriptions = [{
    id: 'subscription-id',
    userId: 'recipient',
    endpoint: 'https://push.example/private-endpoint',
    p256dh: 'p256dh',
    auth: 'auth',
  }];
  mocks.mutedUsers = [];
  mocks.sendNotification.mockResolvedValue({});
  mocks.db.select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: () => ({
        all: () => table === mocks.schema.channelNotificationSettings
          ? mocks.mutedUsers
          : mocks.subscriptions,
      }),
    }),
  }));
  mocks.db.update.mockReturnValue({
    set: () => ({ where: () => ({ run: vi.fn() }) }),
  });
  mocks.db.delete.mockReturnValue({
    where: () => ({ run: vi.fn() }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendWebPushToUsers', () => {
  it('logs provider failures without exposing the endpoint or message payload', async () => {
    mocks.sendNotification.mockRejectedValue({ statusCode: 403, body: 'sensitive response' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    sendWebPushToUsers(['recipient'], {
      id: 'message-id',
      title: 'private title',
      body: 'private body',
      channelId: 'channel-id',
    });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());

    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('subscription-id');
    expect(logged).toContain('403');
    expect(logged).not.toContain('private-endpoint');
    expect(logged).not.toContain('private title');
    expect(logged).not.toContain('private body');
    expect(logged).not.toContain('sensitive response');
  });

  it.each([404, 410])('removes subscriptions rejected as expired (%s)', async (statusCode) => {
    mocks.sendNotification.mockRejectedValue({ statusCode });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    sendWebPushToUsers(['recipient'], {
      id: 'message-id',
      title: 'Message',
      body: 'Body',
      channelId: 'channel-id',
    });
    await vi.waitFor(() => expect(mocks.db.delete).toHaveBeenCalledOnce());
  });
});
