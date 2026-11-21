import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@backspace/shared';
import type { ParticipantInfo } from '../../hooks/useLiveKit';
import { useAuthStore } from '../../stores/authStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { SoundController } from './SoundController';

const { audioMock } = vi.hoisted(() => ({
  audioMock: {
    playJoinSound: vi.fn(),
    playSound: vi.fn(),
  },
}));

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => audioMock },
}));

const joinOptions = expect.objectContaining({ volume: expect.any(Number) });

function participant(userId: string, overrides: Partial<ParticipantInfo> = {}): ParticipantInfo {
  return {
    identity: userId,
    userId,
    username: userId,
    homeUserId: null,
    isMuted: false,
    isDeafened: false,
    isCameraOn: false,
    isScreenSharing: false,
    isLocal: false,
    audioTrack: null,
    videoTrack: null,
    screenTrack: null,
    screenAudioTrack: null,
    lkVideoTrack: null,
    lkScreenTrack: null,
    cachedUser: null,
    ...overrides,
  };
}

const SELF = participant('me', { isLocal: true });
const ALICE = participant('alice');
const BOB = participant('bob');
const CAROL = participant('carol');

/** Renders the controller and lets the 1 s mount guard elapse. */
function mountController(): void {
  render(<SoundController />);
  act(() => {
    vi.advanceTimersByTime(1100);
  });
}

function setParticipants(participants: ParticipantInfo[]): void {
  act(() => {
    useVoiceStore.setState({ participants });
  });
}

function connect(): void {
  act(() => {
    useVoiceStore.setState({ isLiveKitConnected: true });
  });
}

function joinCues(): unknown[][] {
  return audioMock.playJoinSound.mock.calls.filter(([direction]) => direction === 'join');
}

function leaveCues(): unknown[][] {
  return audioMock.playJoinSound.mock.calls.filter(([direction]) => direction === 'leave');
}

beforeEach(() => {
  vi.useFakeTimers();
  audioMock.playJoinSound.mockReset();
  audioMock.playSound.mockReset();
  audioMock.playJoinSound.mockResolvedValue(undefined);
  audioMock.playSound.mockResolvedValue(null);

  useAuthStore.setState({ user: { id: 'me', homeUserId: null } as unknown as User });
  useVoiceStore.setState({
    participants: [],
    isLiveKitConnected: false,
    currentVoiceChannelId: null,
    isMuted: false,
    isDeafened: false,
    isCameraOn: false,
    spaceMutedUserIds: new Set<string>(),
    spaceDeafenedUserIds: new Set<string>(),
    permissionMutedUserIds: new Set<string>(),
    incomingCall: null,
    outgoingCall: null,
    streamWatchers: new Map<string, Set<string>>(),
    joinSoundPreset: 'classic',
    joinSoundVolume: 45,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAuthStore.setState({ user: null });
  useVoiceStore.setState({ participants: [], isLiveKitConnected: false });
});

describe('SoundController participant cues', () => {
  it('plays exactly one join cue when connecting, then treats the arriving roster as baseline', () => {
    mountController();
    connect();

    expect(audioMock.playJoinSound).toHaveBeenCalledTimes(1);
    expect(audioMock.playJoinSound).toHaveBeenLastCalledWith('join', 'classic', joinOptions);

    // LiveKit publishes the whole room roster immediately after the connected
    // flag, which is the tick that used to re-cue every pre-existing member.
    setParticipants([SELF, ALICE, BOB]);
    expect(audioMock.playJoinSound).toHaveBeenCalledTimes(1);

    // Pre-existing members leaving inside the settle window stay silent too:
    // their arrival was never announced, so their departure must not be.
    setParticipants([SELF, ALICE]);
    expect(audioMock.playJoinSound).toHaveBeenCalledTimes(1);
    expect(audioMock.playSound).not.toHaveBeenCalled();
  });

  it('cues a real arrival and a real departure once the baseline is stable', () => {
    mountController();
    connect();
    setParticipants([SELF, ALICE]);
    act(() => {
      vi.advanceTimersByTime(1600);
    });

    setParticipants([SELF, ALICE, CAROL]);
    expect(joinCues()).toHaveLength(2);
    expect(audioMock.playJoinSound).toHaveBeenLastCalledWith('join', 'classic', joinOptions);

    setParticipants([SELF, CAROL]);
    expect(leaveCues()).toHaveLength(1);
    expect(audioMock.playJoinSound).toHaveBeenLastCalledWith('leave', 'classic', joinOptions);
    // Departures go through the preset's leave direction, never the raw sample.
    expect(audioMock.playSound).not.toHaveBeenCalledWith('user_leave', expect.anything());
  });

  it('ignores a participant LiveKit flagged as local even when its id is unfamiliar', () => {
    mountController();
    connect();
    setParticipants([SELF]);
    act(() => {
      vi.advanceTimersByTime(1600);
    });

    // A federated DM call can remap the local user's participant to a member id
    // that the auth store has never seen; `isLocal` is the authoritative signal.
    const federatedSelf = participant('local-dm-alias', { isLocal: true });
    setParticipants([SELF, federatedSelf]);
    expect(joinCues()).toHaveLength(1);

    setParticipants([SELF]);
    expect(leaveCues()).toHaveLength(0);
  });

  it('collapses repeat cues for the same participant and direction inside 1500 ms', () => {
    mountController();
    connect();
    setParticipants([SELF]);
    act(() => {
      vi.advanceTimersByTime(1600);
    });

    setParticipants([SELF, CAROL]);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    setParticipants([SELF]);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // Rejoining inside the window is suppressed for the join direction, while
    // the leave above still played because it is a different direction.
    setParticipants([SELF, CAROL]);
    expect(joinCues()).toHaveLength(2);
    expect(leaveCues()).toHaveLength(1);

    // Outside the window both directions sound again.
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    setParticipants([SELF]);
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    setParticipants([SELF, CAROL]);
    expect(joinCues()).toHaveLength(3);
    expect(leaveCues()).toHaveLength(2);
  });

  it('plays the disconnect cue at the join-sound volume, not the SFX volume', () => {
    // 100 % on the join-sound slider is 0.7 gain, while the untouched SFX
    // slider sits at 0.8 — so the two envelopes are distinguishable here.
    useVoiceStore.setState({ joinSoundVolume: 100, soundEffectVolume: 100 });
    mountController();
    act(() => {
      useVoiceStore.setState({ isLiveKitConnected: true, participants: [SELF] });
    });
    expect(joinCues()).toHaveLength(1);

    act(() => {
      useVoiceStore.setState({ isLiveKitConnected: false, participants: [] });
    });
    expect(leaveCues()).toHaveLength(0);

    const disconnectCall = audioMock.playSound.mock.calls.find(([name]) => name === 'disconnect');
    expect(disconnectCall).toBeDefined();
    const options = disconnectCall?.[1] as { volume: number } | undefined;
    expect(options?.volume).toBeCloseTo(0.7, 5);
    expect(options?.volume).not.toBeCloseTo(0.8, 5);
  });
});
