import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AndroidLifecycle } from './AndroidLifecycle';
import { useUIStore } from '../../stores/uiStore';

const native = vi.hoisted(() => ({ back: undefined as (() => void) | undefined }));
vi.mock('../../platform/android', async (original) => ({
  ...await original<typeof import('../../platform/android')>(),
  onAndroid: (event: string, callback: () => void) => {
    if (event === 'back') native.back = callback;
    return () => { native.back = undefined; };
  },
}));
beforeEach(() => useUIStore.setState({ activeModal: null, imagePreviewUrl: null, mobileSearchOpen: false, mobileStack: [] }));
afterEach(() => {
  cleanup();
  useUIStore.setState({ activeModal: null, imagePreviewUrl: null, mobileStack: [], mobileSearchOpen: false });
  vi.restoreAllMocks();
});
it('closes image preview and search before navigating the chat stack', () => {
  const back = vi.spyOn(history, 'back').mockImplementation(() => {});
  render(<MemoryRouter><AndroidLifecycle /></MemoryRouter>);
  act(() => useUIStore.setState({ mobileStack: [{ screen: 'channel-chat', params: { channelId: 'one' } }] }));
  act(() => useUIStore.getState().openImagePreview('/image.png'));
  act(() => native.back?.());
  expect(useUIStore.getState().activeModal).toBeNull();
  expect(back).not.toHaveBeenCalled();
  act(() => useUIStore.getState().setMobileSearchOpen(true));
  act(() => native.back?.());
  expect(useUIStore.getState().mobileSearchOpen).toBe(false);
  expect(back).not.toHaveBeenCalled();
  act(() => native.back?.());
  expect(back).toHaveBeenCalledOnce();
});
it('exits only the top profile when the covered chat still has search open', () => {
  useUIStore.setState({ activeModal: null, mobileSearchOpen: true, mobileStack: [
    { screen: 'channel-chat', params: { channelId: 'channel' } },
    { screen: 'user-profile', params: { userId: 'alice' } },
  ] });
  const back = vi.spyOn(history, 'back').mockImplementation(() => {});
  render(<MemoryRouter><AndroidLifecycle /></MemoryRouter>);
  act(() => native.back?.());
  expect(back).toHaveBeenCalledOnce();
  expect(useUIStore.getState().mobileSearchOpen).toBe(true);
  expect(useUIStore.getState().mobileStack).toHaveLength(2);
});
