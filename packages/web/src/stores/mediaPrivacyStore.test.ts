import { afterEach, expect, it, vi } from 'vitest';
import type { Channel } from '@backspace/shared';
import {
  refreshMediaPrivacy, setMediaPrivacyForeground, setMediaPrivacyVisit, useMediaPrivacyStore,
} from './mediaPrivacyStore';

const list = vi.hoisted(() => vi.fn<() => Promise<Channel[]>>());
vi.mock('./spaceStore', () => ({ getApiForOrigin: () => ({ channels: { list } }) }));

const visit = { origin: '', userId: 'user', spaceId: 'space', channelId: 'one' };
const channel = (mediaPrivacyMask: boolean): Channel => ({
  id: visit.channelId, spaceId: visit.spaceId, name: 'one', type: 'text',
  createdAt: 0, position: 0, categoryId: null, topic: null, mediaPrivacyMask,
});
const current = useMediaPrivacyStore.getState;

afterEach(() => {
  setMediaPrivacyVisit(null);
  setMediaPrivacyForeground(true);
  list.mockReset();
});

it('keeps reveals through a foreground refresh and clears them on leaving', async () => {
  list.mockResolvedValue([channel(true)]);
  setMediaPrivacyVisit(visit);
  await vi.waitFor(() => expect(current().enabled).toBe(true));
  current().reveal('image');
  setMediaPrivacyForeground(false);
  expect(current().enabled).toBeNull();
  setMediaPrivacyForeground(true);
  expect(current().enabled).toBeNull();
  await vi.waitFor(() => expect(current().enabled).toBe(true));
  expect(current().revealed.has('image')).toBe(true);

  setMediaPrivacyVisit(null);
  setMediaPrivacyVisit(visit);
  await vi.waitFor(() => expect(current().enabled).toBe(true));
  expect(current().revealed.size).toBe(0);
});

it('ignores an older response after a channel update starts a fresh read', async () => {
  let reply: (channels: Channel[]) => void = () => {};
  list.mockReturnValueOnce(new Promise((resolve) => { reply = resolve; }));
  list.mockResolvedValueOnce([channel(true)]);
  setMediaPrivacyVisit(visit);
  await refreshMediaPrivacy('', visit.channelId, true);
  reply([channel(false)]);
  await Promise.resolve();
  expect(current().enabled).toBe(true);
});

it('keeps media masked after a read fails and clears reveals when the server disables the setting', async () => {
  list.mockRejectedValueOnce(new Error('offline'));
  setMediaPrivacyVisit(visit);
  await Promise.resolve();
  expect(current().enabled).toBeNull();

  list.mockResolvedValueOnce([channel(true)]);
  await refreshMediaPrivacy('');
  current().toggleAll();
  expect(current().showAll).toBe(true);
  list.mockResolvedValueOnce([channel(false)]);
  await refreshMediaPrivacy('', visit.channelId, false);
  expect(current()).toMatchObject({ enabled: false, showAll: false });
});
