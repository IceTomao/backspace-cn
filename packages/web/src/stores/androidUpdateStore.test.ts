import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { coerceAndroidUpdate, useAndroidUpdateStore } from './androidUpdateStore';

const native = vi.hoisted(() => ({ call: vi.fn(), listeners: new Map<string, (value: unknown) => void>(), listen: vi.fn() }));
vi.mock('../platform/android', () => ({
  isAndroid: () => true,
  androidCall: (...args: unknown[]) => native.call(...args),
  onAndroid: (event: string, callback: (value: unknown) => void) => {
    native.listen(event); native.listeners.set(event, callback);
    return () => { native.listeners.delete(event); };
  },
}));
const idle = { currentVersion: '1.3.22', phase: 'idle', version: null, dismissedVersion: null };
let cleanups: (() => void)[] = [];
beforeEach(() => {
  useAndroidUpdateStore.setState({ snapshot: null });
  native.call.mockReset().mockImplementation((action: string) => Promise.resolve({ ...idle, phase: action === 'checkAppUpdate' ? 'up-to-date' : 'idle' }));
  native.listen.mockClear(); native.listeners.clear();
});
afterEach(() => { cleanups.forEach(cleanup => cleanup()); cleanups = []; vi.restoreAllMocks(); });
it('shares native listeners and startup check, and stops checking while hidden', async () => {
  cleanups.push(useAndroidUpdateStore.getState().initialize(), useAndroidUpdateStore.getState().initialize());
  await vi.waitFor(() => expect(native.call).toHaveBeenCalledWith('checkAppUpdate', { manual: false }));
  expect(native.call.mock.calls.filter(([action]) => action === 'appUpdateState')).toHaveLength(1);
  expect(native.listen).toHaveBeenCalledTimes(2);
  const calls = native.call.mock.calls.length;
  native.listeners.get('webVisibility')?.({ visible: false });
  expect(native.call).toHaveBeenCalledTimes(calls);
  native.listeners.get('webVisibility')?.({ visible: true });
  await vi.waitFor(() => expect(native.call.mock.calls.length).toBeGreaterThan(calls));
  cleanups.shift()?.();
  expect(native.listeners.size).toBe(2);
  cleanups.shift()?.();
  expect(native.listeners.size).toBe(0);
});
it('shows check failures and delegates download and persisted dismissal to native', async () => {
  useAndroidUpdateStore.setState({ snapshot: { ...idle, phase: 'available', version: '1.3.23' } });
  native.call.mockRejectedValueOnce(new Error('bridge offline'));
  await useAndroidUpdateStore.getState().check();
  expect(useAndroidUpdateStore.getState().snapshot?.phase).toBe('failed');
  native.call.mockResolvedValue({ ...idle, phase: 'available', version: '1.3.23', dismissedVersion: '1.3.23' });
  await useAndroidUpdateStore.getState().dismiss();
  expect(useAndroidUpdateStore.getState().snapshot?.dismissedVersion).toBe('1.3.23');
  await useAndroidUpdateStore.getState().download();
  expect(native.call).toHaveBeenCalledWith('downloadAppUpdate');
});
it('rejects malformed snapshots and does not let a disposed initialization trigger a check', async () => {
  expect(coerceAndroidUpdate({ ...idle, phase: 'available', version: null })).toBeNull();
  expect(coerceAndroidUpdate({ ...idle, phase: 'future-phase' })).toBeNull();
  expect(coerceAndroidUpdate({ ...idle, currentVersion: 22 })).toBeNull();
  let resolve: (value: unknown) => void = () => {};
  native.call.mockReturnValue(new Promise(done => { resolve = done; }));
  const dispose = useAndroidUpdateStore.getState().initialize();
  dispose();
  resolve(idle);
  await Promise.resolve();
  expect(native.call.mock.calls.some(([action]) => action === 'checkAppUpdate')).toBe(false);
});
