import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWebSocket } from './useWebSocket';
import { useAuthStore } from '../stores/authStore';

const native = vi.hoisted(() => ({ call: vi.fn(), listeners: new Map<string, (value: any) => void>() }));
vi.mock('../platform/android', async (original) => ({
  ...await original<typeof import('../platform/android')>(),
  isAndroid: () => true,
  androidCall: (...args: unknown[]) => native.call(...args),
  onAndroid: (name: string, callback: (value: unknown) => void) => {
    native.listeners.set(name, callback);
    return () => { native.listeners.delete(name); };
  },
}));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
beforeEach(() => {
  native.call.mockReset().mockResolvedValue({});
  native.listeners.clear();
  useAuthStore.setState({ token: 'native-test-session' });
});
afterEach(() => { act(() => useAuthStore.setState({ token: null })); vi.restoreAllMocks(); });
it('uses pushed connection status and acknowledges ordered events without a status polling interval', async () => {
  const interval = vi.spyOn(window, 'setInterval');
  const view = renderHook(useWebSocket);
  await waitFor(() => expect(native.listeners.has('socketStatus')).toBe(true));
  act(() => native.listeners.get('socketStatus')?.({ origin: '', connected: true }));
  expect(view.result.current.isConnected).toBe(true);
  expect(interval.mock.calls.some(([, delay]) => delay === 500)).toBe(false);
  act(() => native.listeners.get('socketEvent')?.({ origin: '', sequence: 1, event: { type: 'pong' } }));
  await waitFor(() => expect(native.call).toHaveBeenCalledWith('ackEvents', { cursors: { '': 1 } }));
  act(() => native.listeners.get('socketEvent')?.({ origin: '', sequence: 3, event: { type: 'pong' } }));
  expect(native.call).toHaveBeenCalledWith('sync', { cursors: { '': 1 } });
  act(() => native.listeners.get('socketEvent')?.({ origin: '', sequence: 4, event: { type: 'ready' } }));
  expect(native.call).toHaveBeenCalledWith('resync', { origin: '' });
  act(() => native.listeners.get('socketEvent')?.({ origin: '', sequence: 5, event: { type: 'ready' } }));
  expect(native.call.mock.calls.filter(([name]) => name === 'resync')).toHaveLength(1);
  act(() => native.listeners.get('webVisibility')?.({ visible: false }));
  expect(native.call).toHaveBeenCalledWith('webVisibility', { visible: false, cursors: { '': 1 } });
  act(() => native.listeners.get('socketStatus')?.({ origin: '', connected: false }));
  expect(view.result.current.isConnected).toBe(false);
  view.unmount();
  expect(native.listeners.size).toBe(0);
  expect(native.call.mock.calls.some(([name]) => name === 'hangup')).toBe(false);
});
