import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useUIStore } from '../../stores/uiStore';
import { AndroidLifecycle } from './AndroidLifecycle';

let backHandler: (() => void) | undefined;

vi.mock('../../platform/android', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../platform/android')>(),
  onAndroid: vi.fn((_event: string, callback: () => void) => {
    backHandler = callback;
    return () => { backHandler = undefined; };
  }),
}));

beforeEach(() => {
  useUIStore.setState({ activeModal: null, imagePreviewUrl: null, mobileSearchOpen: false, mobileStack: [] });
});

afterEach(() => {
  useUIStore.setState({ activeModal: null, imagePreviewUrl: null, mobileSearchOpen: false, mobileStack: [] });
});

it('closes image preview and search before navigating the mobile stack', () => {
  const historyBack = vi.spyOn(history, 'back').mockImplementation(() => {});
  render(<MemoryRouter><AndroidLifecycle /></MemoryRouter>);
  useUIStore.setState({ mobileStack: [{ screen: 'channel-chat', params: { channelId: 'one' } }] });

  act(() => useUIStore.getState().openImagePreview('/image.png'));
  act(() => backHandler?.());
  expect(useUIStore.getState().activeModal).toBeNull();
  expect(historyBack).not.toHaveBeenCalled();

  act(() => useUIStore.getState().setMobileSearchOpen(true));
  act(() => backHandler?.());
  expect(useUIStore.getState().mobileSearchOpen).toBe(false);
  expect(historyBack).not.toHaveBeenCalled();

  act(() => backHandler?.());
  expect(historyBack).toHaveBeenCalledOnce();
  historyBack.mockRestore();
});
