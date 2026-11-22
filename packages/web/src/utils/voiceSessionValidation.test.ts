import { describe, expect, it } from 'vitest';
import {
  findVoiceChannelForUser,
  isLocalVoiceSessionIdle,
  shouldLeaveVoiceOnUnload,
  shouldMirrorStaleLeave,
  shouldProbeVoiceSession,
} from './voiceSessionValidation';

const idleSession = {
  currentVoiceChannelId: null,
  activeDmCallChannelId: null,
  isLiveKitConnected: false,
};

describe('findVoiceChannelForUser', () => {
  it('returns the channel that lists the user', () => {
    expect(findVoiceChannelForUser({ 'ch-1': ['a'], 'ch-2': ['b', 'me'] }, 'me')).toBe('ch-2');
  });

  it('returns null when the user is not listed or the snapshot is missing', () => {
    expect(findVoiceChannelForUser({ 'ch-1': ['a'] }, 'me')).toBeNull();
    expect(findVoiceChannelForUser(undefined, 'me')).toBeNull();
  });

  it('ignores malformed entries instead of throwing', () => {
    const snapshot = { 'ch-1': null, 'ch-2': ['me'] } as unknown as Record<string, string[]>;
    expect(findVoiceChannelForUser(snapshot, 'me')).toBe('ch-2');
  });
});

describe('isLocalVoiceSessionIdle', () => {
  it('is true only without channel, DM call and LiveKit connection', () => {
    expect(isLocalVoiceSessionIdle(idleSession)).toBe(true);
    expect(isLocalVoiceSessionIdle({ ...idleSession, currentVoiceChannelId: 'ch-1' })).toBe(false);
    expect(isLocalVoiceSessionIdle({ ...idleSession, activeDmCallChannelId: 'dm-1' })).toBe(false);
    expect(isLocalVoiceSessionIdle({ ...idleSession, isLiveKitConnected: true })).toBe(false);
  });
});

describe('shouldProbeVoiceSession', () => {
  it('probes when an idle client is still listed in a channel', () => {
    expect(shouldProbeVoiceSession({ 'ch-1': ['me'] }, 'me', idleSession)).toBe(true);
  });

  it('does not probe for a client that owns a session', () => {
    const states = { 'ch-1': ['me'] };
    expect(shouldProbeVoiceSession(states, 'me', { ...idleSession, currentVoiceChannelId: 'ch-1' })).toBe(false);
    expect(shouldProbeVoiceSession(states, 'me', { ...idleSession, isLiveKitConnected: true })).toBe(false);
  });

  it('does not probe when the server does not list the user', () => {
    expect(shouldProbeVoiceSession({ 'ch-1': ['someone-else'] }, 'me', idleSession)).toBe(false);
  });
});

describe('shouldMirrorStaleLeave', () => {  it('mirrors a released membership', () => {
    expect(shouldMirrorStaleLeave({ inVoice: false, channelId: 'ch-1' }, 'me')).toBe(true);
  });

  it('never mirrors a live session', () => {
    expect(shouldMirrorStaleLeave({ inVoice: true, channelId: 'ch-1' }, 'me')).toBe(false);
  });

  it('ignores replies without a channel or without a user id', () => {
    expect(shouldMirrorStaleLeave({ inVoice: false, channelId: null }, 'me')).toBe(false);
    expect(shouldMirrorStaleLeave({ inVoice: false, channelId: 'ch-1' }, null)).toBe(false);
  });
});

describe('shouldLeaveVoiceOnUnload', () => {
  it('leaves when a channel, a DM call or a LiveKit room is still open', () => {
    expect(shouldLeaveVoiceOnUnload({ ...idleSession, currentVoiceChannelId: 'ch-1' })).toBe(true);
    expect(shouldLeaveVoiceOnUnload({ ...idleSession, activeDmCallChannelId: 'dm-1' })).toBe(true);
    expect(shouldLeaveVoiceOnUnload({ ...idleSession, isLiveKitConnected: true })).toBe(true);
  });

  it('stays quiet for an idle client', () => {
    expect(shouldLeaveVoiceOnUnload(idleSession)).toBe(false);
  });
});
