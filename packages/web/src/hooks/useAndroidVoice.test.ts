import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { EMPTY_VOICE, useAndroidVoice } from './useAndroidVoice';
import { useVoiceStore } from '../stores/voiceStore';
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));

const bridge = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Map<string, (value: any) => void>(),
  removed: vi.fn(),
}));
vi.mock('../platform/android', () => ({
  isAndroid: () => true,
  serverLocation: () => new URL('https://chat.kevz.me:2096'),
  serverUrl: (url: string) => `https://chat.kevz.me:2096${url}`,
  androidCall: (...args: unknown[]) => bridge.call(...args),
  onAndroid: (event: string, callback: (value: any) => void) => {
    bridge.listeners.set(event, callback);
    return () => { bridge.listeners.delete(event); bridge.removed(); };
  },
}));
beforeEach(() => {
  bridge.call.mockReset().mockImplementation((action: string) => Promise.resolve(action === 'voice' ? EMPTY_VOICE : {}));
  bridge.listeners.clear();
  bridge.removed.mockReset();
});
it('restores native call state and never hangs up on UI unmount', async () => {
  const view = renderHook(useAndroidVoice);
  await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('voice'));
  act(() => bridge.listeners.get('voice')?.({
    ...EMPTY_VOICE, channelId: 'channel-1', status: 'connected', muted: true,
    participants: [{ identity: 'u:Alice', name: 'Alice', local: true, muted: true, speaking: false }],
  }));
  expect(view.result.current.isConnected).toBe(true);
  expect(useVoiceStore.getState().currentVoiceChannelId).toBe('channel-1');
  expect(useVoiceStore.getState().participants[0]?.videoTrack).toBeNull();
  expect(useVoiceStore.getState().participants[0]?.isCameraOn).toBe(false);
  view.unmount();
  expect(bridge.removed).toHaveBeenCalledOnce();
  expect(bridge.call.mock.calls.some(([action]) => action === 'hangup')).toBe(false);
});
it('reports native permission denial and does not leave a connected call UI', async () => {
  const view = renderHook(useAndroidVoice);
  await act(async () => {});
  bridge.call.mockImplementation((action: string) => action === 'joinVoice'
    ? Promise.reject(new Error('麦克风权限被拒绝')) : Promise.resolve({}));
  await act(async () => { await expect(view.result.current.connect('channel-2')).rejects.toThrow('麦克风权限被拒绝'); });
  expect(useVoiceStore.getState().currentVoiceChannelId).toBeNull();
  expect(useVoiceStore.getState().connectionError).toBe('麦克风权限被拒绝');
  view.unmount();
});
