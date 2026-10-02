import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { User } from '@backspace/shared';
import { useUIStore } from './uiStore';

vi.mock('./spaceStore', () => ({ resolveUserOrigin: () => 'https://remote.example:8443' }));
const user = { id: 'replica-id', username: 'alice@remote.example', homeUserId: 'home-id', homeInstance: 'remote.example' } as User;
const chat = { screen: 'channel-chat', params: { spaceId: 'space', channelId: 'channel' } };
beforeEach(() => {
  useUIStore.setState({ isMobile: true, mobileStack: [chat], activeModal: null, modalData: {} });
  history.replaceState({ idx: 4, usr: { preserved: true } }, '');
});
afterEach(() => { useUIStore.setState({ isMobile: false, mobileStack: [], activeModal: null }); vi.restoreAllMocks(); });
it('opens a federated avatar as a page and preserves router history state', () => {
  useUIStore.getState().openUserProfile(user, { top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1 });
  expect(useUIStore.getState().activeModal).toBeNull();
  expect(useUIStore.getState().mobileStack.at(-1)).toMatchObject({
    screen: 'user-profile', params: { userId: 'replica-id', origin: 'https://remote.example:8443' }, profileUser: user,
  });
  expect(history.state.usr).toEqual({ preserved: true });
  expect(history.state.idx).toBe(5);
});
it('routes direct profile-modal entry points through the same stack and returns one layer at a time', () => {
  useUIStore.getState().openModal('userProfile', { userId: user.id, user, origin: 'https://authoritative.example' });
  const first = history.state;
  useUIStore.getState().openModal('userProfile', { userId: 'friend-id' });
  const back = vi.spyOn(history, 'back').mockImplementation(() => {});
  useUIStore.getState().popMobileScreen();
  expect(back).toHaveBeenCalledOnce();
  expect(useUIStore.getState().mobileStack).toHaveLength(3);
  useUIStore.getState().restoreMobileHistory(first);
  expect(useUIStore.getState().mobileStack).toHaveLength(2);
  expect(useUIStore.getState().mobileStack.at(-1)?.params?.origin).toBe('https://authoritative.example');
  useUIStore.getState().restoreMobileHistory({ backspaceMobileStack: [chat] });
  expect(useUIStore.getState().mobileStack).toEqual([chat]);
});
it('keeps desktop profile dialogs available', () => {
  useUIStore.setState({ isMobile: false });
  useUIStore.getState().openModal('userProfile', { userId: user.id, user });
  expect(useUIStore.getState().activeModal).toBe('userProfile');
  expect(useUIStore.getState().mobileStack).toEqual([chat]);
});
