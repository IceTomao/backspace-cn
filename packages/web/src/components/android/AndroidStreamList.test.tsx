import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AndroidStreamList } from './AndroidStreamList';

const native = vi.hoisted(() => ({ call: vi.fn(), emit: undefined as undefined | ((value: unknown) => void) }));
vi.mock('../../platform/android', () => ({
  androidCall: (...args: unknown[]) => native.call(...args),
  onAndroid: (_event: string, callback: (value: unknown) => void) => { native.emit = callback; return () => { native.emit = undefined; }; },
}));
vi.mock('../../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast: vi.fn() }) } }));
it('offers published streams without subscribing until clicked and removes ended streams', async () => {
  native.call.mockImplementation(() => Promise.resolve({ streams: [] }));
  const view = render(<AndroidStreamList />);
  await waitFor(() => expect(native.call).toHaveBeenCalledWith('voice'));
  act(() => native.emit?.({ streams: [{ identity: 'user:Alice', name: 'Alice', videoSid: 'track', muted: false }] }));
  expect(native.call).not.toHaveBeenCalledWith('watchStream', expect.anything());
  await userEvent.click(screen.getByRole('button', { name: /Alice/ }));
  expect(native.call).toHaveBeenCalledWith('watchStream', { identity: 'user:Alice' });
  act(() => native.emit?.({ streams: [] }));
  expect(screen.queryByRole('button')).toBeNull();
  view.unmount();
  expect(native.emit).toBeUndefined();
});
