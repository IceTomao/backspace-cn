import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Track, type Room } from 'livekit-client';
import { isNativeSdrEligibleSourceId, useNativeSdrStore } from './nativeSdrStore';
import { useVoiceStore } from './voiceStore';
import { useAuthStore } from './authStore';
import { cloneStreamColor, DEFAULT_STREAM_COLOR } from '../utils/streamColor';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  broadcastVoiceStatus: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: {
    livekit: {
      status: mocks.status,
    },
  },
}));

vi.mock('../utils/voice', () => ({
  broadcastVoiceStatus: mocks.broadcastVoiceStatus,
}));

vi.mock('./settingsStore', () => ({
  getStreamingLimits: () => ({
    minBitrateKbps: 500,
    maxBitrateKbps: 20_000,
    maxResolution: 1440,
    maxFps: 120,
    allowCustomBitrate: true,
    bitrateMatrixOverrides: null,
  }),
}));

vi.mock('./spaceStore', () => ({
  getChannelOrigin: () => '',
}));

function makeFakeRoom(localIdentity = 'u1:streamer') {
  const audioPubs = new Map<string, { track: unknown }>();
  return {
    localParticipant: {
      identity: localIdentity,
      publishTrack: vi.fn(async (track: unknown, opts: { source: string }) => {
        audioPubs.set(opts.source, { track });
        return { track };
      }),
      unpublishTrack: vi.fn(async () => {
        audioPubs.clear();
      }),
      getTrackPublication: vi.fn((source: string) => audioPubs.get(source)),
    },
  } as unknown as Room;
}

describe('nativeSdrStore', () => {
  let eventListener: ((event: unknown) => void) | null = null;
  let audioListener: ((frame: {
    requestId: string;
    sampleRate: number;
    channels: number;
    frames: number;
    pcm: Float32Array;
  }) => void) | null = null;
  let sdrNativeMock: ReturnType<typeof vi.fn>;
  let setStreamingPowerModeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    eventListener = null;
    audioListener = null;

    mocks.status.mockResolvedValue({
      enabled: true,
      nativeHdrProtocol: 1,
      nativeSdrProtocol: 1,
    });

    sdrNativeMock = vi.fn(async (req: Record<string, unknown>) => {
      if (req.action === 'capabilities') {
        return {
          protocol: 1,
          available: true,
          hevcAvailable: true,
          h264Available: true,
          colorControl: 2,
          displays: [
            {
              gdiName: '\\\\.\\DISPLAY1',
              name: 'Primary Gaming 1440p',
              hmonitor: '65537',
              left: 0,
              top: 0,
              isPrimary: true,
              width: 2560,
              height: 1440,
            },
          ],
        };
      }
      if (req.action === 'publish') {
        const cfg = req.config as { codec: 'hevc' | 'h264' };
        return {
          identity: '__backspace_hdr_v1__u1:publish:00000000-0000-0000-0000-000000000001',
          trackSid: 'TR_SDR_1',
          width: 2560,
          height: 1440,
          codec: cfg.codec,
        };
      }
      return { ok: true };
    });

    setStreamingPowerModeMock = vi.fn();

    vi.stubGlobal('window', {
      ...globalThis.window,
      location: { origin: 'https://voice.example:18443' },
      backspace: {
        platform: 'win32',
        sdrNative: sdrNativeMock,
        setStreamingPowerMode: setStreamingPowerModeMock,
        onSdrNativeEvent: (cb: (event: unknown) => void) => {
          eventListener = cb;
          return () => {
            eventListener = null;
          };
        },
        onSdrNativeAudio: (cb: typeof audioListener) => {
          audioListener = cb;
          return () => {
            audioListener = null;
          };
        },
      },
    });

    useAuthStore.setState({ token: 'jwt-token' } as never);
    useVoiceStore.setState({
      ...useVoiceStore.getInitialState(),
      currentVoiceChannelId: 'vc-1',
      callOrigin: 'https://voice.example:18443',
      watchingStreams: new Set(['u1']),
      screenShareConfig: {
        height: 1440,
        fps: 120,
        mode: 'gaming',
        customBitrateKbps: null,
        shareAudio: true,
        codec: 'auto',
        degradationPreference: 'maintain-framerate',
        hdrEnabled: false,
        hdrExposureEv: 0,
        forceSdr: false,
        sdrExposureEv: 0,
        streamColor: cloneStreamColor(DEFAULT_STREAM_COLOR),
      },
    });
  });

  afterEach(async () => {
    await useNativeSdrStore.getState().stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('publishes zero-readback HEVC for whole-screen AUTO, pauses local self-preview, streams WASAPI audio, and auto-switches to H.264 for Firefox viewers', async () => {
    const writtenAudio: unknown[] = [];
    vi.stubGlobal(
      'AudioData',
      class {
        init: unknown;
        constructor(init: unknown) {
          this.init = init;
        }
        close = vi.fn();
      },
    );
    vi.stubGlobal(
      'MediaStreamTrackGenerator',
      class {
        kind = 'audio';
        stop = vi.fn();
        writable = {
          getWriter: () => ({
            write: vi.fn(async (chunk: unknown) => {
              writtenAudio.push(chunk);
            }),
            close: vi.fn(async () => {}),
          }),
        };
      },
    );

    const room = makeFakeRoom('u1:streamer');
    const config = useVoiceStore.getState().screenShareConfig;

    const ok = await useNativeSdrStore.getState().publish(room, 'screen:0:0', config, {
      width: 2560,
      height: 1440,
    });
    expect(ok).toBe(true);
    expect(useNativeSdrStore.getState().active).toBe(true);
    expect(useNativeSdrStore.getState().codec).toBe('hevc');
    expect(useNativeSdrStore.getState().requestedResolvedCodec).toBe('h265');
    expect(useVoiceStore.getState().isScreenSharing).toBe(true);
    // Local self-preview was automatically paused on publish!
    expect(useVoiceStore.getState().watchingStreams.has('u1')).toBe(false);
    expect(setStreamingPowerModeMock).toHaveBeenCalledWith(true);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: Track.Source.ScreenShareAudio, forceStereo: true }),
    );

    // Feed a WASAPI PCM chunk and verify AudioData forwarding
    const publishCall = sdrNativeMock.mock.calls.find(([arg]) => arg.action === 'publish')?.[0] as {
      requestId: string;
    };
    expect(publishCall?.requestId).toBeTruthy();
    audioListener?.({
      requestId: publishCall.requestId,
      sampleRate: 48000,
      channels: 2,
      frames: 960,
      pcm: new Float32Array(1920),
    });
    expect(writtenAudio).toHaveLength(1);

    // Feed live GPU stats
    eventListener?.({
      kind: 'stats',
      requestId: publishCall.requestId,
      codec: 'hevc',
      encodeFps: 120,
      captureFps: 60,
      encodeTimeMs: 1.4,
      bitrateKbps: 15800,
      width: 2560,
      height: 1440,
      sourceWidth: 2560,
      sourceHeight: 1440,
    });
    expect(useNativeSdrStore.getState().stats?.encodeFps).toBe(120);
    expect(useNativeSdrStore.getState().stats?.encodeTimeMs).toBe(1.4);

    // Firefox viewer joins with supportsHevc: false -> auto hot-switches publisher to H.264 High!
    useNativeSdrStore.getState().onViewerWatch(room, 'u2:firefoxViewer', true, false);
    await vi.advanceTimersByTimeAsync(0);

    expect(useNativeSdrStore.getState().codec).toBe('h264');
    // requestedResolvedCodec stays 'h265' so ConnectionInfoPopover reports AUTO (H265) -> H264 compat switch
    expect(useNativeSdrStore.getState().requestedResolvedCodec).toBe('h265');

    // Live color + SDR exposure adjustment sends publisher-color without restarting encoder
    const customColor = cloneStreamColor(DEFAULT_STREAM_COLOR);
    customColor.digitalVibrance = 75;
    const publishCallsBeforeColor = sdrNativeMock.mock.calls.filter(([arg]) => arg.action === 'publish').length;
    await useNativeSdrStore.getState().reconfigure(room, {
      ...useVoiceStore.getState().screenShareConfig,
      sdrExposureEv: -0.7,
      streamColor: customColor,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(sdrNativeMock.mock.calls.filter(([arg]) => arg.action === 'publish')).toHaveLength(publishCallsBeforeColor);
    expect(sdrNativeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'publisher-color',
        color: expect.objectContaining({ exposureEv: -0.7 }),
      }),
    );

    // Toggling Force SDR mid-stream reconfigures the native publisher with forceSdr: true
    const reconfiguredOk = await useNativeSdrStore.getState().reconfigure(room, {
      ...useVoiceStore.getState().screenShareConfig,
      forceSdr: true,
      sdrExposureEv: -0.7,
      streamColor: customColor,
    });
    expect(reconfiguredOk).toBe(true);
    expect(sdrNativeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'publish',
        config: expect.objectContaining({
          forceSdr: true,
          color: expect.objectContaining({ exposureEv: -0.7 }),
        }),
      }),
    );

    // Clean stop tears down native pipeline, audio track, and power mode
    await useNativeSdrStore.getState().stop(room);
    expect(useNativeSdrStore.getState().active).toBe(false);
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    expect(setStreamingPowerModeMock).toHaveBeenLastCalledWith(false);
  });

  it('publishes window:* sources via zero-copy SDR, updates resized window stats, and falls back only for VP9 or non-SDR sources', async () => {
    expect(isNativeSdrEligibleSourceId('screen:0:0')).toBe(true);
    expect(isNativeSdrEligibleSourceId('window:263960:0')).toBe(true);
    expect(isNativeSdrEligibleSourceId('hdr:DISPLAY1')).toBe(false);
    expect(isNativeSdrEligibleSourceId(null)).toBe(false);

    const room = makeFakeRoom('u1:streamer');
    const config = { ...useVoiceStore.getState().screenShareConfig, shareAudio: false };

    const winOk = await useNativeSdrStore.getState().publish(room, 'window:263960:0', config, {
      width: 1600,
      height: 900,
    });
    expect(winOk).toBe(true);
    expect(useNativeSdrStore.getState().active).toBe(true);
    expect(useNativeSdrStore.getState().sourceId).toBe('window:263960:0');

    const publishCall = sdrNativeMock.mock.calls.find(
      ([arg]) => arg.action === 'publish' && arg.sourceId === 'window:263960:0',
    )?.[0] as { requestId: string };
    expect(publishCall?.requestId).toBeTruthy();

    // Window dynamically resized from 1600x900 to 2560x1440 while keeping output canvas fixed
    eventListener?.({
      kind: 'stats',
      requestId: publishCall.requestId,
      codec: 'hevc',
      encodeFps: 120,
      captureFps: 120,
      encodeTimeMs: 1.2,
      bitrateKbps: 18000,
      width: 1600,
      height: 900,
      sourceWidth: 2560,
      sourceHeight: 1440,
    });
    expect(useNativeSdrStore.getState().stats?.sourceWidth).toBe(2560);
    expect(useNativeSdrStore.getState().stats?.sourceHeight).toBe(1440);

    // HEVC-capable viewer joining triggers instant keyframe request
    useNativeSdrStore.getState().onViewerWatch(room, 'u3:desktopViewer', true, true);
    expect(sdrNativeMock).toHaveBeenCalledWith({
      action: 'keyframe',
      requestId: publishCall.requestId,
    });

    // Window closed by user -> native process emits stopped(capture_window_closed) -> cleanly ends share
    eventListener?.({
      kind: 'publisher',
      requestId: publishCall.requestId,
      state: 'stopped',
      reason: 'capture_window_closed',
    });
    expect(useNativeSdrStore.getState().active).toBe(false);
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);

    expect(await useNativeSdrStore.getState().publish(room, 'hdr:DISPLAY1', config)).toBe(false);
    expect(
      await useNativeSdrStore.getState().publish(room, 'window:263960:0', { ...config, codec: 'vp9' }),
    ).toBe(false);
  });
});
