import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPresets, BackupCodecPolicy, Track } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import { cloneStreamColor, DEFAULT_STREAM_COLOR } from './streamColor';
import { resetCodecCapabilityCacheForTests } from './codecCapabilities';
import i18n from '../i18n';
import {
  buildScreenShareOptions,
  ensureSupportedScreenShareCodec,
  getPublishedScreenShareCodec,
  getRequestedPublishedScreenShareCodec,
  isH265ScreenShareSupported,
  publishScreenShare,
  republishScreenShare,
  stageScreenCapture,
  stopScreenShare,
} from './screenShare';

const sdp = vi.hoisted(() => ({ activate: vi.fn(), deactivate: vi.fn() }));
const internals = vi.hoisted(() => ({ getPublisherPC: vi.fn(), getMediaStreamTrack: vi.fn() }));
vi.mock('./hwOverdrive', () => sdp);
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ setInputVolume: vi.fn() }) },
}));
vi.mock('../stores/settingsStore', () => ({
  getStreamingLimits: () => ({
    minBitrateKbps: 500,
    maxBitrateKbps: 20_000,
    allowCustomBitrate: true,
    bitrateMatrixOverrides: null,
  }),
}));
vi.mock('./livekitInternals', () => internals);

type FakeTrack = {
  kind: 'video' | 'audio';
  readyState: 'live';
  contentHint: string;
  stop: ReturnType<typeof vi.fn>;
};

function makeTrack(kind: FakeTrack['kind']): FakeTrack {
  return { kind, readyState: 'live', contentHint: '', stop: vi.fn() };
}

function makeVideoTrack(id = 'screen-video', width = 2560, height = 1440) {
  return {
    ...makeTrack('video'),
    id,
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn(() => ({ width, height })),
  };
}

function makeStream(video = makeTrack('video'), audio?: FakeTrack) {
  const tracks = [video, ...(audio ? [audio] : [])];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => [video],
    getAudioTracks: () => audio ? [audio] : [],
  } as unknown as MediaStream;
}

function fakeRoom() {
  return {
    localParticipant: {
      publishTrack: vi.fn().mockResolvedValue({}),
      unpublishTrack: vi.fn().mockResolvedValue(undefined),
      getTrackPublication: vi.fn(),
      getTrackPublications: vi.fn(() => []),
    },
  } as any;
}

function attachPublishedSender(
  room: ReturnType<typeof fakeRoom>,
  video: ReturnType<typeof makeVideoTrack>,
  reports: Array<[string, Record<string, unknown>]>,
) {
  const publicationTrack = { mediaStreamTrack: video };
  const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
  room.localParticipant.getTrackPublications.mockReturnValue([publication]);
  const sender = {
    track: { id: video.id },
    getParameters: vi.fn(() => ({ encodings: [{ active: true }] })),
    setParameters: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue(new Map(reports)),
  };
  internals.getPublisherPC.mockReturnValue({ getSenders: vi.fn(() => [sender]) });
  internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);
  return sender;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetCodecCapabilityCacheForTests();
  vi.stubGlobal('RTCRtpSender', {
    getCapabilities: vi.fn(() => ({ codecs: [{ mimeType: 'video/H265' }] })),
  });
  internals.getPublisherPC.mockReturnValue(null);
  internals.getMediaStreamTrack.mockReturnValue(null);
  localStorage.clear();
  useVoiceStore.setState({
    ...useVoiceStore.getInitialState(),
    screenShareConfig: {
      height: 1440,
      fps: 60,
      mode: 'gaming',
      customBitrateKbps: 18_000,
      shareAudio: true,
      codec: 'vp9',
      degradationPreference: 'maintain-resolution',
      hdrEnabled: false,
      hdrExposureEv: 0,
      forceSdr: false,
      sdrExposureEv: 0,
      streamColor: cloneStreamColor(DEFAULT_STREAM_COLOR),
    },
  });
});

afterEach(() => {
  resetCodecCapabilityCacheForTests();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('H.265 screen-share capability detection', () => {
  it('uses sender capabilities rather than playback or receiver support', () => {
    expect(isH265ScreenShareSupported()).toBe(true);
    expect(RTCRtpSender.getCapabilities).toHaveBeenCalledWith('video');
  });

  it.each([
    ['no sender API', undefined],
    ['no capability API', {}],
    ['no capabilities', { getCapabilities: () => null }],
    ['no H.265 codec', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }) }],
    ['failed detection', { getCapabilities: () => { throw new Error('unavailable'); } }],
  ])('returns false for %s', (_label, sender) => {
    vi.stubGlobal('RTCRtpSender', sender);
    expect(isH265ScreenShareSupported()).toBe(false);
  });
});

describe('screen-share media options', () => {
  it('migrates, saves and validates HDR exposure & streamColor independently of SDR preferences', async () => {
    localStorage.setItem('backspace-voice-settings', JSON.stringify({ version: 17, state: {
      screenShareConfig: { hdrEnabled: false, codec: 'h264', hdrExposureEv: '1', hdrBrightness: 25 },
    } }));
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig).toMatchObject({
      hdrExposureEv: 0,
      forceSdr: false,
      sdrExposureEv: 0,
      streamColor: DEFAULT_STREAM_COLOR,
      codec: 'h264',
      degradationPreference: 'maintain-framerate',
    });
    expect('hdrBrightness' in useVoiceStore.getState().screenShareConfig).toBe(false);

    const customColor = cloneStreamColor(DEFAULT_STREAM_COLOR);
    customColor.red = { brightness: 65, contrast: 55, gamma: 1.3 };
    customColor.digitalVibrance = 75;
    customColor.hue = 45;
    useVoiceStore.getState().setScreenShareConfig({
      hdrExposureEv: -1.5,
      forceSdr: true,
      sdrExposureEv: -0.8,
      streamColor: customColor,
    });
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig).toMatchObject({
      hdrExposureEv: -1.5,
      forceSdr: true,
      sdrExposureEv: -0.8,
      streamColor: customColor,
      hdrEnabled: false,
    });
    for (const invalid of [
      { hdrExposureEv: NaN },
      { hdrExposureEv: 0.05 },
      { sdrExposureEv: NaN },
      { sdrExposureEv: 4 },
      { forceSdr: 'yes' as unknown as boolean },
      { streamColor: { ...customColor, hue: 360 } },
      { streamColor: { ...customColor, digitalVibrance: -1 } },
    ]) {
      useVoiceStore.getState().setScreenShareConfig(invalid);
      expect(useVoiceStore.getState().screenShareConfig).toMatchObject({
        hdrExposureEv: -1.5,
        forceSdr: true,
        sdrExposureEv: -0.8,
        streamColor: customColor,
      });
    }
  });

  it('treats malformed persisted HDR values as disabled', async () => {
    localStorage.setItem('backspace-voice-settings', JSON.stringify({ version: 16, state: { screenShareConfig: { hdrEnabled: 'true' } } }));
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.hdrEnabled).toBe(false);
  });

  it('defaults/migrates old HDR settings off and retains the SDR codec preference', async () => {
    expect(useVoiceStore.getInitialState().screenShareConfig.hdrEnabled).toBe(false);
    localStorage.setItem('backspace-voice-settings', JSON.stringify({ version: 15, state: { screenShareConfig: { codec: 'h264' } } }));
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig).toMatchObject({ hdrEnabled: false, codec: 'h264', height: 1440 });
    useVoiceStore.getState().setScreenShareConfig({ hdrEnabled: true });
    expect(buildScreenShareOptions(useVoiceStore.getState().screenShareConfig).publish).toMatchObject({ videoCodec: 'h265', simulcast: false, backupCodec: undefined });
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.hdrEnabled).toBe(true);
    useVoiceStore.setState({ isScreenSharing: true });
    useVoiceStore.getState().setScreenShareConfig({ hdrEnabled: false, height: 1080 });
    expect(useVoiceStore.getState().screenShareConfig).toMatchObject({ hdrEnabled: true, height: 1080, codec: 'h264' });
    useVoiceStore.setState({ isScreenSharing: false });
    useVoiceStore.getState().setScreenShareConfig({ hdrEnabled: false });
    expect(buildScreenShareOptions(useVoiceStore.getState().screenShareConfig).publish.videoCodec).toBe('h264');
  });

  it('never silently publishes browser SDR or system audio for a restored HDR request', async () => {
    useVoiceStore.getState().setScreenShareConfig({ hdrEnabled: true, codec: 'h265' });
    vi.stubGlobal('RTCRtpSender', undefined);
    expect(ensureSupportedScreenShareCodec().codec).toBe('h265');
    const getDisplayMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
    await expect(stageScreenCapture()).rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(getDisplayMedia).not.toHaveBeenCalled();
    const room = fakeRoom(), video = makeTrack('video'), audio = makeTrack('audio');
    expect(await publishScreenShare(room, makeStream(video, audio))).toBe(false);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
  });

  it('restores and publishes H.265 with a REGRESSION VP8 backup, activates SDP bitrate floor, and keeps choice after stop', async () => {
    localStorage.setItem('backspace-voice-settings', JSON.stringify({
      version: 15,
      state: { screenShareConfig: { ...useVoiceStore.getState().screenShareConfig, codec: 'h265' } },
    }));
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h265');

    const room = fakeRoom();
    const video = makeVideoTrack();
    attachPublishedSender(room, video, [
      ['codec-h265', { id: 'codec-h265', type: 'codec', mimeType: 'video/H265' }],
      ['outbound-h265', {
        id: 'outbound-h265', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h265',
        bytesSent: 100, encoderImplementation: 'ExternalEncoder',
      }],
      ['outbound-vp8', {
        id: 'outbound-vp8', type: 'outbound-rtp', kind: 'video', mimeType: 'video/VP8', bytesSent: 500,
      }],
    ]);
    const opts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);

    expect(await publishScreenShare(room, makeStream(video))).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      video,
      expect.objectContaining({
        videoCodec: 'h265',
        videoEncoding: opts.publish.videoEncoding,
        screenShareEncoding: opts.publish.videoEncoding,
        degradationPreference: 'maintain-framerate',
        simulcast: false,
        backupCodec: {
          codec: 'vp8',
          encoding: {
            maxBitrate: opts.publish.videoEncoding.maxBitrate / 2,
            maxFramerate: 30,
          },
        },
        backupCodecPolicy: BackupCodecPolicy.REGRESSION,
      }),
    );
    expect(getRequestedPublishedScreenShareCodec()).toBe('h265');
    expect(getPublishedScreenShareCodec()).toBe('h265');
    expect(sdp.activate).toHaveBeenCalledWith({
      codec: 'h265',
      targetBitrateBps: opts.publish.videoEncoding.maxBitrate,
      trackId: video.id,
    });
    expect(sdp.deactivate).toHaveBeenCalledOnce();

    await stopScreenShare(room);
    expect(getRequestedPublishedScreenShareCodec()).toBeNull();
    expect(getPublishedScreenShareCodec()).toBeNull();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h265');
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.screenShareConfig.codec).toBe('h265');
  });

  it('falls back to auto before publishing an unsupported saved H.265 choice and warns only once', async () => {
    vi.stubGlobal('RTCRtpSender', undefined);
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h265' });
    await useVoiceStore.persist.rehydrate();
    const addToast = vi.spyOn(useUIStore.getState(), 'addToast');
    const room = fakeRoom();

    expect(await publishScreenShare(room, makeStream(makeVideoTrack()))).toBe(true);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ videoCodec: 'vp9' }),
    );
    expect(ensureSupportedScreenShareCodec().codec).toBe('auto');
    expect(ensureSupportedScreenShareCodec().codec).toBe('auto');
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(i18n.t('voice:streamSettings.h265Fallback'), 'warning', 8000);
    expect(getRequestedPublishedScreenShareCodec()).toBe('vp9');
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.screenShareConfig.codec).toBe('auto');
  });

  it('records a sending VP8 backup separately from the requested H.265 codec', async () => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h265' });
    const room = fakeRoom();
    const video = makeVideoTrack();
    attachPublishedSender(room, video, [
      ['outbound-h265', {
        id: 'outbound-h265', type: 'outbound-rtp', kind: 'video', mimeType: 'video/H265', bytesSent: 0,
      }],
      ['outbound-vp8', {
        id: 'outbound-vp8', type: 'outbound-rtp', kind: 'video', mimeType: 'video/VP8',
        bytesSent: 100, encoderImplementation: 'ExternalEncoder',
      }],
    ]);

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(getRequestedPublishedScreenShareCodec()).toBe('h265');
    expect(getPublishedScreenShareCodec()).toBe('vp8');
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h265');
  });

  it.each(['vp9', 'h264'] as const)('switches from %s to H.265 and back without recapturing or stopping tracks', async (codec) => {
    const video = makeVideoTrack();
    const audio = makeTrack('audio');
    vi.stubGlobal('MediaStream', class {
      constructor(private tracks: FakeTrack[]) {}
      getTracks() { return this.tracks; }
      getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
      getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
    });
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia },
    });
    const room = fakeRoom();
    room.localParticipant.getTrackPublication.mockImplementation((source: Track.Source) => ({
      track: { mediaStreamTrack: source === Track.Source.ScreenShare ? video : audio },
    }));
    useVoiceStore.getState().setScreenShareConfig({ codec });
    await publishScreenShare(room, makeStream(video, audio));

    useVoiceStore.getState().setScreenShareConfig({ codec: 'h265' });
    await republishScreenShare(room);
    expect(getRequestedPublishedScreenShareCodec()).toBe('h265');
    useVoiceStore.getState().setScreenShareConfig({ codec });
    await republishScreenShare(room);

    const videoCalls = room.localParticipant.publishTrack.mock.calls.filter(
      ([, options]: [unknown, { source: Track.Source }]) => options.source === Track.Source.ScreenShare,
    );
    expect(videoCalls.map(([, options]: [unknown, { videoCodec: string }]) => options.videoCodec))
      .toEqual([codec, 'h265', codec]);
    expect(videoCalls.every(([track]: [unknown]) => track === video)).toBe(true);
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(
      expect.objectContaining({ mediaStreamTrack: video }), false,
    );
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(
      expect.objectContaining({ mediaStreamTrack: audio }), false,
    );
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(video.stop).not.toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
    expect(getRequestedPublishedScreenShareCodec()).toBe(codec);
    expect(useVoiceStore.getState().isScreenSharing).toBe(true);
    expect(sdp.activate).toHaveBeenCalledTimes(3);
    expect(sdp.deactivate).toHaveBeenCalledTimes(3);
  });

  it('publishes VP9 with SDP bitrate floor scoped to the screen-share track', async () => {
    const room = fakeRoom();
    const video = makeVideoTrack();
    attachPublishedSender(room, video, [
      ['codec-vp9', { id: 'codec-vp9', type: 'codec', mimeType: 'video/VP9' }],
      ['outbound-vp9', {
        id: 'outbound-vp9', type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp9',
        bytesSent: 100, encoderImplementation: 'ExternalEncoder',
      }],
    ]);

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);

    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: Track.Source.ScreenShare, videoCodec: 'vp9' }),
    );
    expect(getPublishedScreenShareCodec()).toBe('vp9');
    expect(sdp.activate).toHaveBeenCalledWith({
      codec: 'vp9',
      targetBitrateBps: 18_000_000,
      trackId: video.id,
    });
    expect(sdp.deactivate).toHaveBeenCalledOnce();
  });

  it('uses the persisted H.264 codec without instantiating a backup encoder and keeps it after stop', async () => {
    const room = fakeRoom();
    const video = makeVideoTrack();
    attachPublishedSender(room, video, [
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
      ['outbound-h264', {
        id: 'outbound-h264', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
        bytesSent: 100, encoderImplementation: 'VideoToolbox',
      }],
    ]);
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    const publishArgs = room.localParticipant.publishTrack.mock.calls[0]![1];
    expect(publishArgs.videoCodec).toBe('h264');
    expect(publishArgs.backupCodec).toBeUndefined();
    expect(getPublishedScreenShareCodec()).toBe('h264');
    expect(sdp.activate).toHaveBeenCalledOnce();
    expect(sdp.deactivate).toHaveBeenCalledOnce();

    await stopScreenShare(room);
    expect(getPublishedScreenShareCodec()).toBeNull();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h264');
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.screenShareConfig.codec).toBe('h264');
  });

  it('passes raw zero-copy stream through stageScreenCapture when color is default, requests stereo audio, and toggles Electron power blocker', async () => {
    const setStreamingPowerMode = vi.fn();
    vi.stubGlobal('window', {
      ...globalThis.window,
      backspace: { setStreamingPowerMode },
    });
    const video = makeVideoTrack('raw-os-track');
    const audio = makeTrack('audio');
    const stream = makeStream(video, audio);
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia },
    });

    const staged = await stageScreenCapture();
    // Default streamColor must preserve the raw zero-copy OS stream without synthetic wrapping
    expect(staged).toBe(stream);
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({
      video: {
        width: { ideal: 2560, max: 2560 },
        height: { ideal: 1440, max: 1440 },
        frameRate: { ideal: 60, max: 60 },
      },
      audio: expect.objectContaining({
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true,
      }),
    }));

    const room = fakeRoom();
    await publishScreenShare(room, staged);
    expect(setStreamingPowerMode).toHaveBeenCalledWith(true);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      audio,
      expect.objectContaining({
        source: Track.Source.ScreenShareAudio,
        audioPreset: AudioPresets.musicHighQualityStereo,
        dtx: false,
        red: false,
        forceStereo: true,
      }),
    );

    await stopScreenShare(room);
    expect(setStreamingPowerMode).toHaveBeenLastCalledWith(false);
  });

  it('computes proportional Native bitrate BEFORE publishTrack so 1080p60 native does not negotiate 4K 20Mbps', async () => {
    useVoiceStore.getState().setScreenShareConfig({
      height: 'native',
      fps: 60,
      mode: 'gaming',
      customBitrateKbps: null,
      codec: 'vp9',
    });
    const video = makeVideoTrack('native-1080p', 1920, 1080);
    const room = fakeRoom();

    await publishScreenShare(room, makeStream(video));
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      video,
      expect.objectContaining({
        videoEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
        screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
      }),
    );
    expect(sdp.activate).toHaveBeenCalledWith({
      codec: 'vp9',
      targetBitrateBps: 8_000_000,
      trackId: 'native-1080p',
    });
  });

  it('uses full-framerate H.264 REGRESSION backup when sender supports H.264 so Firefox viewers do not drop 60/120fps to 30fps VP8', async () => {
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: vi.fn(() => ({
        codecs: [{ mimeType: 'video/H265' }, { mimeType: 'video/H264' }, { mimeType: 'video/VP9' }],
      })),
    });
    useVoiceStore.getState().setScreenShareConfig({
      height: 1440,
      fps: 120,
      mode: 'gaming',
      codec: 'h265',
      customBitrateKbps: null,
      degradationPreference: 'maintain-framerate',
    });

    const opts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
    expect(opts.publish.videoCodec).toBe('h265');
    expect(opts.publish.backupCodecPolicy).toBe(BackupCodecPolicy.REGRESSION);
    expect(opts.publish.backupCodec).toEqual({
      codec: 'h264',
      encoding: {
        maxBitrate: 20_000_000, // clamped to mocked maxBitrateKbps=20_000
        maxFramerate: 120,
      },
    });

    const room = fakeRoom();
    const video = makeVideoTrack('h265-to-h264', 2560, 1440);
    const sender = attachPublishedSender(room, video, [
      ['codec-h265', { id: 'codec-h265', type: 'codec', mimeType: 'video/H265' }],
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
      ['outbound-h265', { id: 'outbound-h265', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h265', bytesSent: 0 }],
      ['outbound-h264', {
        id: 'outbound-h264', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
        bytesSent: 4096, encoderImplementation: 'ExternalEncoder',
      }],
    ]);

    expect(await publishScreenShare(room, makeStream(video))).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(getRequestedPublishedScreenShareCodec()).toBe('h265');
    expect(getPublishedScreenShareCodec()).toBe('h264');
    expect(sender.setParameters).toHaveBeenCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ maxFramerate: 120 })],
      degradationPreference: 'maintain-framerate',
    }));
  });

  it('keeps Gaming/Text content hints, maintain-framerate gaming default, H.264 1.15x gaming boost, and REGRESSION backup', () => {
    expect(useVoiceStore.getInitialState().screenShareConfig.degradationPreference).toBe('maintain-framerate');
    const base = useVoiceStore.getState().screenShareConfig;
    const gamingDefault = buildScreenShareOptions({
      ...base,
      mode: 'gaming',
      degradationPreference: undefined as unknown as RTCDegradationPreference,
    });
    const textDefault = buildScreenShareOptions({
      ...base,
      mode: 'text',
      degradationPreference: undefined as unknown as RTCDegradationPreference,
    });
    const h264AutoGaming = buildScreenShareOptions({
      ...base,
      height: 1080,
      fps: 60,
      mode: 'gaming',
      codec: 'h264',
      customBitrateKbps: null,
    });

    expect(gamingDefault.contentHint).toBe('motion');
    expect(gamingDefault.overdrive.degradationPreference).toBe('maintain-framerate');
    expect(textDefault.contentHint).toBe('detail');
    expect(textDefault.overdrive.degradationPreference).toBe('maintain-resolution');
    expect(gamingDefault.publish.backupCodecPolicy).toBe(BackupCodecPolicy.REGRESSION);
    expect(h264AutoGaming.publish.backupCodec).toBeUndefined();
    expect(h264AutoGaming.publish.videoEncoding.maxBitrate).toBe(9_200_000);
    expect(gamingDefault.overdrive).not.toHaveProperty('minBitrate');
  });

  it('retries until the screen-share sender is ready and reasserts the ceiling at five seconds without min:15 constraint', async () => {
    const video = makeVideoTrack();
    const publicationTrack = { mediaStreamTrack: video };
    const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
    const room = fakeRoom();
    room.localParticipant.getTrackPublications.mockReturnValue([publication]);

    const sender = {
      track: { id: video.id },
      getParameters: vi.fn(() => ({ encodings: [{ active: true }] })),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };
    const peerConnection = { getSenders: vi.fn((): typeof sender[] => []) };
    internals.getPublisherPC.mockReturnValue(peerConnection);
    internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.setParameters).not.toHaveBeenCalled();

    peerConnection.getSenders.mockReturnValue([sender]);
    await vi.advanceTimersByTimeAsync(250);
    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(video.applyConstraints).toHaveBeenCalledOnce();
    expect(video.applyConstraints).toHaveBeenCalledWith({
      width: { ideal: 2560, max: 2560 },
      height: { ideal: 1440, max: 1440 },
      frameRate: { ideal: 60, max: 60 },
    });
    expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ maxBitrate: 18_000_000, maxFramerate: 60 })],
      degradationPreference: 'maintain-resolution',
    }));

    await vi.advanceTimersByTimeAsync(4750);
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
    expect(video.applyConstraints).toHaveBeenCalledOnce();
  });

  it('retries an empty placeholder encoding and continues when capture constraints fail', async () => {
    const video = makeVideoTrack();
    video.applyConstraints.mockRejectedValue(new DOMException('unsupported', 'OverconstrainedError'));
    const publicationTrack = { mediaStreamTrack: video };
    const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
    const room = fakeRoom();
    room.localParticipant.getTrackPublications.mockReturnValue([publication]);
    let encodings: RTCRtpEncodingParameters[] = [{}];
    const sender = {
      track: { id: video.id },
      getParameters: vi.fn(() => ({ encodings })),
      setParameters: vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn().mockResolvedValue(new Map()),
    };
    internals.getPublisherPC.mockReturnValue({ getSenders: vi.fn(() => [sender]) });
    internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.setParameters).not.toHaveBeenCalled();

    encodings = [{ active: true }];
    await vi.advanceTimersByTimeAsync(250);
    expect(sender.setParameters).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4750);
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
    expect(video.applyConstraints).toHaveBeenCalledOnce();
  });

  it('retries negotiated-codec inspection until the sender appears', async () => {
    const video = makeVideoTrack();
    const publicationTrack = { mediaStreamTrack: video };
    const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
    const room = fakeRoom();
    room.localParticipant.getTrackPublications.mockReturnValue([publication]);
    const sender = {
      track: { id: video.id },
      getParameters: vi.fn(() => ({ encodings: [{ active: true }] })),
      setParameters: vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn().mockResolvedValue(new Map([
        ['codec-vp9', { id: 'codec-vp9', type: 'codec', mimeType: 'video/VP9' }],
        ['outbound-vp9', {
          id: 'outbound-vp9', type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp9', bytesSent: 100,
        }],
      ])),
    };
    const peerConnection = { getSenders: vi.fn((): typeof sender[] => []) };
    internals.getPublisherPC.mockReturnValue(peerConnection);
    internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(getPublishedScreenShareCodec()).toBeNull();

    peerConnection.getSenders.mockReturnValue([sender]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getPublishedScreenShareCodec()).toBe('vp9');
  });

  it('warns with localized copy when H264 falls back to OpenH264 or VP9 falls back to libvpx software encoding', async () => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    const video = makeVideoTrack();
    const room = fakeRoom();
    attachPublishedSender(room, video, [
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
      ['outbound-h264', {
        id: 'outbound-h264', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
        bytesSent: 100, encoderImplementation: 'OpenH264',
      }],
    ]);
    const addToast = vi.spyOn(useUIStore.getState(), 'addToast');

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);

    expect(getPublishedScreenShareCodec()).toBe('h264');
    expect(addToast).toHaveBeenCalledWith(
      i18n.t('voice:streamSettings.softwareH264Fallback'),
      'warning',
      8000,
    );

    await stopScreenShare(room);
    addToast.mockClear();

    useVoiceStore.getState().setScreenShareConfig({ codec: 'vp9' });
    const vp9Video = makeVideoTrack('vp9-soft');
    attachPublishedSender(room, vp9Video, [
      ['codec-vp9', { id: 'codec-vp9', type: 'codec', mimeType: 'video/VP9' }],
      ['outbound-vp9', {
        id: 'outbound-vp9', type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp9',
        bytesSent: 200, encoderImplementation: 'libvpx',
      }],
    ]);
    await publishScreenShare(room, makeStream(vp9Video));
    await vi.advanceTimersByTimeAsync(0);
    expect(addToast).toHaveBeenCalledWith(
      i18n.t('voice:streamSettings.softwareEncoderFallback', { codec: 'VP9', encoder: 'libvpx' }),
      'warning',
      8000,
    );
  });

  it('migrates older saved settings to auto hardware-preferred codec once and persists subsequent choices', async () => {
    localStorage.setItem('backspace-voice-settings', JSON.stringify({
      version: 13,
      state: {
        screenShareConfig: {
          height: 1080,
          fps: 30,
          mode: 'text',
          customBitrateKbps: null,
          shareAudio: false,
        },
      },
    }));

    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('auto');
    expect(useVoiceStore.getState().screenShareConfig.degradationPreference).toBe('maintain-resolution');

    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264', degradationPreference: 'maintain-framerate' });
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h264');
    expect(useVoiceStore.getState().screenShareConfig.degradationPreference).toBe('maintain-framerate');
  });

  it('bypasses CPU libyuv resize on Windows Electron fallback via zero-scale capture + scaleResolutionDownBy', async () => {
    vi.stubGlobal('window', {
      ...globalThis.window,
      backspace: { platform: 'win32', setStreamingPowerMode: vi.fn() },
    });
    useVoiceStore.getState().setScreenShareConfig({ height: 1080, fps: 120, codec: 'h264' });
    const video = makeVideoTrack('win-wgc-track', 2560, 1440);
    const stream = makeStream(video);
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia },
    });

    await stageScreenCapture();
    // No width/height constraint passed to getDisplayMedia on win32 so WGC stays zero-scale D3D11
    expect(getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: { frameRate: { ideal: 120, max: 120 } },
      }),
    );

    const room = fakeRoom();
    const sender = attachPublishedSender(room, video, [
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
      [
        'outbound-h264',
        {
          id: 'outbound-h264',
          type: 'outbound-rtp',
          kind: 'video',
          codecId: 'codec-h264',
          bytesSent: 1000,
          encoderImplementation: 'MediaFoundationVideoEncodeAccelerator',
        },
      ],
    ]);

    await publishScreenShare(room, stream);
    await vi.advanceTimersByTimeAsync(0);
    // 1440 / 1080 = 1.333 scaled on GPU encoder path via scaleResolutionDownBy
    expect(sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        encodings: [expect.objectContaining({ maxFramerate: 120, scaleResolutionDownBy: 1.333 })],
      }),
    );
  });
});
