import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPresets, BackupCodecPolicy, Track } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
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

function makeVideoTrack(id = 'screen-video') {
  return {
    ...makeTrack('video'),
    id,
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn(() => ({ width: 2560, height: 1440 })),
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
    },
  });
});

afterEach(() => {
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
  it('restores and publishes H.265 with a VP8 backup, then keeps the choice after stop', async () => {
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
        id: 'outbound-h265', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h265', bytesSent: 100,
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
        simulcast: false,
        backupCodec: {
          codec: 'vp8',
          encoding: {
            maxBitrate: opts.publish.videoEncoding.maxBitrate / 2,
            maxFramerate: 30,
          },
        },
        backupCodecPolicy: BackupCodecPolicy.SIMULCAST,
      }),
    );
    expect(getRequestedPublishedScreenShareCodec()).toBe('h265');
    expect(getPublishedScreenShareCodec()).toBe('h265');
    expect(sdp.activate).not.toHaveBeenCalled();
    expect(sdp.deactivate).not.toHaveBeenCalled();

    await stopScreenShare(room);
    expect(getRequestedPublishedScreenShareCodec()).toBeNull();
    expect(getPublishedScreenShareCodec()).toBeNull();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h265');
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.screenShareConfig.codec).toBe('h265');
  });

  it('falls back before publishing an unsupported saved H.265 choice and warns only once', async () => {
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
    expect(ensureSupportedScreenShareCodec().codec).toBe('vp9');
    expect(ensureSupportedScreenShareCodec().codec).toBe('vp9');
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(i18n.t('voice:streamSettings.h265Fallback'), 'warning', 8000);
    expect(getRequestedPublishedScreenShareCodec()).toBe('vp9');
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.screenShareConfig.codec).toBe('vp9');
    expect(sdp.activate).not.toHaveBeenCalled();
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
        id: 'outbound-vp8', type: 'outbound-rtp', kind: 'video', mimeType: 'video/VP8', bytesSent: 100,
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
    expect(sdp.activate).toHaveBeenCalledTimes(codec === 'h264' ? 2 : 0);
  });

  it('publishes VP9 directly without enabling the H.264 SDP hook', async () => {
    const room = fakeRoom();
    const video = makeVideoTrack();
    attachPublishedSender(room, video, [
      ['codec-vp9', { id: 'codec-vp9', type: 'codec', mimeType: 'video/VP9' }],
      ['outbound-vp9', {
        id: 'outbound-vp9', type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp9', bytesSent: 100,
      }],
    ]);

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);

    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: Track.Source.ScreenShare, videoCodec: 'vp9' }),
    );
    expect(getPublishedScreenShareCodec()).toBe('vp9');
    expect(sdp.activate).not.toHaveBeenCalled();
    expect(sdp.deactivate).not.toHaveBeenCalled();
  });

  it('uses the persisted codec on the first publication and keeps it after stop', async () => {
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
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ videoCodec: 'h264' }),
    );
    expect(getPublishedScreenShareCodec()).toBe('h264');
    expect(sdp.activate).toHaveBeenCalledOnce();
    expect(sdp.deactivate).toHaveBeenCalledOnce();

    await stopScreenShare(room);
    expect(getPublishedScreenShareCodec()).toBeNull();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h264');
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.screenShareConfig.codec).toBe('h264');
  });

  it('requests unprocessed stereo capture and publishes stereo music audio', async () => {
    const video = makeTrack('video');
    const audio = makeTrack('audio');
    const stream = makeStream(video, audio);
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia },
    });

    await stageScreenCapture();
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true,
      }),
    }));

    const room = fakeRoom();
    await publishScreenShare(room, stream);
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
  });

  it('keeps the measured Gaming/Text adaptation and dynacast-managed VP8 backup without the ignored minBitrate member', () => {
    const base = useVoiceStore.getState().screenShareConfig;
    const gaming = buildScreenShareOptions({ ...base, mode: 'gaming' });
    const text = buildScreenShareOptions({ ...base, mode: 'text' });

    expect(gaming.contentHint).toBe('motion');
    expect(gaming.overdrive.degradationPreference).toBe('balanced');
    expect(text.contentHint).toBe('detail');
    expect(text.overdrive.degradationPreference).toBe('maintain-resolution');
    expect(gaming.publish.backupCodecPolicy).toBe(BackupCodecPolicy.SIMULCAST);
    expect(gaming.overdrive).not.toHaveProperty('minBitrate');
  });

  it('retries until the screen-share sender is ready and reasserts the ceiling at five seconds', async () => {
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
    expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ maxBitrate: 18_000_000, maxFramerate: 60 })],
      degradationPreference: 'balanced',
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

  it('warns with localized copy when H264 falls back to OpenH264 software encoding', async () => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    const video = makeVideoTrack();
    const room = fakeRoom();
    attachPublishedSender(room, video, [
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
      ['codec-vp8', { id: 'codec-vp8', type: 'codec', mimeType: 'video/VP8' }],
      ['outbound-h264', {
        id: 'outbound-h264', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
        bytesSent: 100, encoderImplementation: 'OpenH264',
      }],
      ['outbound-vp8', {
        id: 'outbound-vp8', type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp8',
        bytesSent: 0, encoderImplementation: 'libvpx',
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
  });

  it('migrates older saved settings to VP9 once and persists subsequent choices', async () => {
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
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('vp9');

    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h264');
  });
});
