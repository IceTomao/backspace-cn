import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, RoomEvent, DisconnectReason, ConnectionState, Track, TrackEvent } from 'livekit-client';
import { useLiveKit } from './useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';
import { HttpError } from '../api/client';

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  connect: vi.fn(), disconnect: vi.fn(),
  audio: {
    releaseInputStream: vi.fn(), resumeContext: vi.fn(),
    setVoiceProcessing: vi.fn(), setRnnoiseEnabled: vi.fn(),
    setInputDevice: vi.fn(), setInputVolume: vi.fn(),
    onResumed: vi.fn(() => vi.fn()), onInputTrackEnded: vi.fn(() => vi.fn()),
    getStreamGeneration: () => 1, getFreshTrack: () => null,
  },
  scheduleScreenShareOverdrive: vi.fn(),
}));
vi.mock('livekit-client', async importOriginal => {
  const sdk = await importOriginal<typeof import('livekit-client')>();
  return { ...sdk, Room: class extends sdk.Room {
    connect = mocks.connect;
    disconnect = mocks.disconnect;
  } };
});
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => mocks.audio } }));
vi.mock('../audio/SpeakingDetector', () => ({
  SpeakingDetector: { getInstance: () => ({ clear: vi.fn(), syncTracks: vi.fn() }) },
}));
vi.mock('./useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../utils/voice', () => ({ broadcastVoiceStatus: vi.fn(), clearSpaceVoiceForDmCall: vi.fn() }));
vi.mock('../utils/hwOverdrive', () => ({ deactivate: vi.fn() }));
vi.mock('../utils/screenShare', async importOriginal => {
  const original = await importOriginal<typeof import('../utils/screenShare')>();
  return { ...original, scheduleScreenShareOverdrive: mocks.scheduleScreenShareOverdrive };
});
vi.mock('../stores/spaceStore', () => ({
  getApiForOrigin: () => ({ livekit: { token: mocks.token, dmToken: mocks.token } }),
  getChannelOrigin: () => '', getMyUserIdForOrigin: () => 'me',
  useSpaceStore: { getState: () => ({ channelToSpaceMap: new Map(), members: [], dmChannels: [] }) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.token.mockResolvedValue({ token: 'test', url: 'wss://example.invalid' });
  mocks.audio.resumeContext.mockResolvedValue(undefined);
  mocks.audio.setRnnoiseEnabled.mockResolvedValue(undefined);
  mocks.audio.setInputDevice.mockResolvedValue(null);
  useVoiceStore.setState({ ...useVoiceStore.getInitialState(), isMuted: false });
  mocks.connect.mockResolvedValue(undefined);
  mocks.disconnect.mockImplementation(async function (this: Room) {
    this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
  });
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('voice capture teardown', () => {
  it('preserves voice intent across Reconnecting → Connected', async () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const leaveSpy = vi.spyOn(useVoiceStore.getState(), 'leaveVoice');
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });

    act(() => { result.current.room!.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting); });
    expect(useVoiceStore.getState().voiceConnectionStatus).toBe('reconnecting');
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('channel');

    act(() => { result.current.room!.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected); });
    expect(useVoiceStore.getState().voiceConnectionStatus).toBe('connected');
    expect(leaveSpy).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('channel');
  });

  it('uses the bounded screen-share sender scheduler after reconnect and track restart', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    useVoiceStore.setState({ isScreenSharing: true });

    act(() => {
      result.current.room!.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);
      result.current.room!.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
    });
    expect(mocks.scheduleScreenShareOverdrive).toHaveBeenCalledOnce();

    let restart!: () => void;
    const track = {
      on: vi.fn((event: TrackEvent, handler: () => void) => {
        if (event === TrackEvent.Restarted) restart = handler;
      }),
    };
    act(() => {
      result.current.room!.emit(RoomEvent.LocalTrackPublished, {
        source: Track.Source.ScreenShare,
        track,
      } as never);
      restart();
    });

    expect(track.on).toHaveBeenCalledWith(TrackEvent.Restarted, expect.any(Function));
    expect(mocks.scheduleScreenShareOverdrive).toHaveBeenCalledTimes(2);
  });

  it('clears voice intent for a terminal semantic disconnect', async () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });

    act(() => { result.current.room!.emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED); });

    expect(useVoiceStore.getState().voiceConnectionStatus).toBe('disconnected');
    expect(useVoiceStore.getState().currentVoiceChannelId).toBeNull();
  });

  it('reports initial connect failure after the SDK emits Disconnected', async () => {
    mocks.connect.mockImplementationOnce(async function (this: Room) {
      this.emit(RoomEvent.Disconnected, DisconnectReason.JOIN_FAILURE);
      throw new Error('connection rejected');
    });
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    expect(result.current.connectionError).toBe('connect_failed');
    expect(useVoiceStore.getState().connectionError).toBe('connect_failed');
    expect(useVoiceStore.getState().currentVoiceChannelId).toBeNull();
    expect(result.current.isConnecting).toBe(false);
    expect(result.current.isConnected).toBe(false);
  });
  it('clears connecting state and ignores a late token after leave', async () => {
    let finish!: (token: { token: string; url: string }) => void;
    mocks.token.mockReturnValueOnce(new Promise(r => { finish = r; }));
    const { result } = renderHook(() => useLiveKit());
    let connecting!: Promise<void>;
    await act(async () => { connecting = result.current.connect('channel'); });
    expect(result.current.isConnecting).toBe(true);
    await act(async () => { await result.current.disconnect(); });
    expect(result.current.isConnecting).toBe(false);
    await act(async () => { finish({ token: 'late', url: 'wss://example.invalid' }); await connecting; });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
  });

  it('releases once on connected unmount despite the SDK disconnected event', async () => {
    const { result, unmount } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    unmount();
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not publish a late acquisition into the room that was left', async () => {
    let finish!: () => void;
    mocks.audio.setInputDevice.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    await act(async () => { await result.current.disconnect(); });
    await act(async () => { finish(); });
    expect(mocks.audio.setInputVolume).not.toHaveBeenCalled();
  });

  it('releases pre-armed capture even when no Room exists', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.disconnect(); });
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
  });

  it('releases before awaiting SDK teardown', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    let finish!: () => void;
    mocks.disconnect.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
    let leaving!: Promise<void>;
    act(() => { leaving = result.current.disconnect(); });
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await leaving; });
  });

  it.each([DisconnectReason.PARTICIPANT_REMOVED, undefined])('releases on a terminal room event (%s)', async reason => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    act(() => { result.current.room!.emit(RoomEvent.Disconnected, reason); });
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
  });

  it('retains voice intent and warm capture after an exhausted network reconnect', async () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });

    act(() => { result.current.room!.emit(RoomEvent.Disconnected, undefined); });

    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('channel');
    expect(result.current.connectionError).toBeNull();
    expect(useVoiceStore.getState().voiceConnectionStatus).toBe('reconnecting');
    expect(mocks.audio.releaseInputStream).not.toHaveBeenCalled();
  });

  it('automatically reconnects with a fresh token and preserves mute/deafen', async () => {
    vi.useFakeTimers();
    useVoiceStore.setState({ currentVoiceChannelId: 'channel', isMuted: true, isDeafened: true });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    const oldRoom = result.current.room!;
    act(() => { oldRoom.emit(RoomEvent.Disconnected, DisconnectReason.STATE_MISMATCH); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(mocks.token).toHaveBeenCalledTimes(2);
    expect(result.current.room).not.toBe(oldRoom);
    expect(result.current.isConnected).toBe(true);
    expect(useVoiceStore.getState()).toMatchObject({
      currentVoiceChannelId: 'channel', isMuted: true, isDeafened: true, voiceConnectionStatus: 'connected',
    });
    expect(mocks.audio.releaseInputStream).not.toHaveBeenCalled();
  });

  it('keeps retrying transient token failures without clearing voice intent', async () => {
    vi.useFakeTimers();
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    mocks.token.mockRejectedValueOnce(new HttpError(503, 'service unavailable'));
    act(() => { result.current.room!.emit(RoomEvent.Disconnected); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('channel');
    expect(useVoiceStore.getState().voiceConnectionStatus).toBe('reconnecting');
    expect(mocks.audio.releaseInputStream).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.isConnected).toBe(true);
    expect(mocks.token).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 404])('stops recovering when access is refused (%s)', async status => {
    vi.useFakeTimers();
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    mocks.token.mockRejectedValueOnce(new HttpError(status, 'access refused'));
    act(() => { result.current.room!.emit(RoomEvent.Disconnected); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.token).toHaveBeenCalledTimes(2);
    expect(useVoiceStore.getState().currentVoiceChannelId).toBeNull();
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledOnce();
  });

  it('stops after a semantic refusal during the recovery handshake', async () => {
    vi.useFakeTimers();
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    mocks.connect.mockImplementationOnce(async function (this: Room) {
      this.emit(RoomEvent.Disconnected, DisconnectReason.DUPLICATE_IDENTITY);
      throw new Error('identity displaced');
    });
    act(() => { result.current.room!.emit(RoomEvent.Disconnected); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(useVoiceStore.getState().currentVoiceChannelId).toBeNull();
  });

  it('ignores a recovery token received after the user leaves', async () => {
    vi.useFakeTimers();
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    let finish!: (token: { token: string; url: string }) => void;
    mocks.token.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    act(() => { result.current.room!.emit(RoomEvent.Disconnected); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    act(() => { useVoiceStore.getState().leaveVoice(); });
    await act(async () => {
      finish({ token: 'late', url: 'wss://example.invalid' });
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(useVoiceStore.getState().currentVoiceChannelId).toBeNull();
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledOnce();
  });

  it('ignores a pending recovery connect after switching channels', async () => {
    vi.useFakeTimers();
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    let finish!: () => void;
    mocks.connect.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    act(() => { result.current.room!.emit(RoomEvent.Disconnected); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    act(() => { useVoiceStore.setState({ currentVoiceChannelId: 'second' }); });
    await act(async () => { await result.current.connect('second'); finish(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current.connectedChannelId).toBe('second');
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('second');
    expect(mocks.audio.releaseInputStream).not.toHaveBeenCalled();
  });

  it('bounds a hung recovery attempt and resumes retrying', async () => {
    vi.useFakeTimers();
    useVoiceStore.setState({ currentVoiceChannelId: 'channel' });
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    mocks.connect.mockReturnValueOnce(new Promise<void>(() => {}));
    act(() => { result.current.room!.emit(RoomEvent.Disconnected); });
    await act(async () => { await vi.advanceTimersByTimeAsync(35_999); });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(4001); });
    expect(mocks.connect).toHaveBeenCalledTimes(3);
    expect(result.current.isConnected).toBe(true);
  });

  it('keeps capture warm while switching channels and ignores stale room events', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('first'); });
    const oldRoom = result.current.room!;
    await act(async () => { await result.current.connect('second'); });
    act(() => { oldRoom.emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED); });
    expect(mocks.audio.releaseInputStream).not.toHaveBeenCalled();
    expect(result.current.connectedChannelId).toBe('second');
  });

  it('releases pre-armed capture when the token request fails', async () => {
    mocks.token.mockRejectedValueOnce(new Error('token unavailable'));
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
  });

  it('releases on unmount before a Room exists and cancels pending connect', async () => {
    let finish!: () => void;
    mocks.audio.resumeContext.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
    const { result, unmount } = renderHook(() => useLiveKit());
    let connecting!: Promise<void>;
    act(() => { connecting = result.current.connect('channel'); });
    unmount();
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await connecting; });
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it('does not reacquire after leaving during noise-suppressor initialization', async () => {
    let finish!: () => void;
    mocks.audio.setRnnoiseEnabled.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('channel'); });
    await act(async () => { await result.current.disconnect(); });
    await act(async () => { finish(); });
    expect(mocks.audio.setInputDevice).not.toHaveBeenCalled();
  });

  it('does not let an old disconnect clear a new call after SDK teardown', async () => {
    const { result } = renderHook(() => useLiveKit());
    await act(async () => { await result.current.connect('first'); });
    let finish!: () => void;
    mocks.disconnect.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
    let leaving!: Promise<void>;
    act(() => { leaving = result.current.disconnect(); });
    await act(async () => { await result.current.connect('second'); });
    await act(async () => { finish(); await leaving; });
    expect(mocks.audio.releaseInputStream).toHaveBeenCalledTimes(1);
    expect(result.current.isConnected).toBe(true);
    expect(result.current.connectedChannelId).toBe('second');
  });
});
