import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';

// Stub AudioManager — voiceStore imports it and AudioWorkletNode is absent in jsdom.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setInputVolume: vi.fn(),
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { useVoiceStore } from '../stores/voiceStore';
import { applySpaceVoiceState } from './voiceStateSync';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
  useVoiceStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('applySpaceVoiceState', () => {
  it('restores HDR per broadcaster on late join/reconnect and resets legacy/stopped streams to SDR', () => {
    const status = { isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true };
    const snapshot = { spaceId: 'sp1', voiceStates: { ch1: ['hdr', 'sdr'] }, voiceChannelElapsedSeconds: {},
      voiceUserStates: { hdr: { ...status, dynamicRange: 'hdr' as const }, sdr: status }, spaceVoiceStates: {} };
    applySpaceVoiceState(snapshot);
    expect(useVoiceStore.getState().voiceUserStates.get('hdr')?.dynamicRange).toBe('hdr');
    expect(useVoiceStore.getState().voiceUserStates.get('sdr')?.dynamicRange).toBeUndefined();
    applySpaceVoiceState({ ...snapshot, voiceUserStates: { hdr: status } });
    expect(useVoiceStore.getState().voiceUserStates.get('hdr')?.dynamicRange).toBeUndefined();
    useVoiceStore.getState().setVoiceUserStatus('hdr', false, false, false, false, 'hdr');
    expect(useVoiceStore.getState().voiceUserStates.get('hdr')?.dynamicRange).toBeUndefined();
  });
  it('populates voiceUsers, voiceUserStates and scoped restriction sets', () => {
    applySpaceVoiceState({
      spaceId: 'sp1',
      voiceStates: { ch1: ['uA', 'uB'] },
      voiceChannelElapsedSeconds: { ch1: 123_456 },
      voiceUserStates: { uA: { isMuted: true, isDeafened: false, isCameraOn: false, isScreenSharing: false } },
      spaceVoiceStates: {
        'sp1:uA': { spaceMuted: true, spaceDeafened: false, permissionMuted: false },
        'sp1:uB': { spaceMuted: false, spaceDeafened: false, permissionMuted: true },
      },
    });

    const s = useVoiceStore.getState();
    expect(s.getVoiceUsers('ch1')).toEqual(['uA', 'uB']);
    expect(s.voiceChannelElapsedSeconds.get('ch1')).toEqual({
      elapsedSeconds: 123_456,
      observedAt: Date.now(),
    });
    expect(s.voiceUserStates.get('uA')).toEqual({ isMuted: true, isDeafened: false, isCameraOn: false, isScreenSharing: false });
    expect(s.spaceMutedUserIds.has('sp1:uA')).toBe(true);
    expect(s.permissionMutedUserIds.has('sp1:uB')).toBe(true);
  });

  it('refreshes only its own space, leaving other spaces untouched', () => {
    useVoiceStore.setState({
      spaceMutedUserIds: new Set(['sp-other:uX', 'sp1:uStale']),
    });

    applySpaceVoiceState({
      spaceId: 'sp1',
      voiceStates: {},
      voiceChannelElapsedSeconds: {},
      voiceUserStates: {},
      spaceVoiceStates: { 'sp1:uNew': { spaceMuted: true, spaceDeafened: false, permissionMuted: false } },
    });

    const s = useVoiceStore.getState();
    expect(s.spaceMutedUserIds.has('sp-other:uX')).toBe(true);  // untouched
    expect(s.spaceMutedUserIds.has('sp1:uStale')).toBe(false);  // cleared (authoritative re-sync)
    expect(s.spaceMutedUserIds.has('sp1:uNew')).toBe(true);
  });
});
