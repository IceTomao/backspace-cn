import { create } from 'zustand';
import { AudioPresets, Track, type LocalAudioTrack, type Room } from 'livekit-client';
import { api } from '../api/client';
import { useAuthStore } from './authStore';
import { useVoiceStore, type ScreenShareConfig } from './voiceStore';
import { getChannelOrigin } from './spaceStore';
import { getStreamingLimits } from './settingsStore';
import { broadcastVoiceStatus } from '../utils/voice';
import { getElectronAPI } from '../platform/platform';
import { isHdrColor, type HdrColor } from '../utils/hdrColor';
import {
  cloneStreamColor,
  COLOR_CHANNEL_KEYS,
  DEFAULT_STREAM_COLOR,
  type StreamColorSettings,
} from '../utils/streamColor';
import {
  BITRATE_MATRIX_KBPS,
  STANDARD_FRAMERATES,
  STANDARD_RESOLUTIONS,
  WIDTH_MAP,
  type StandardResolution,
} from '@backspace/shared/src/constants';

export type NativeSdrCodec = 'hevc' | 'h264';

export interface NativeSdrStats {
  codec: NativeSdrCodec;
  encodeFps: number;
  captureFps: number;
  encodeTimeMs: number;
  bitrateKbps: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

interface SdrDisplaySummary {
  gdiName: string;
  name: string;
  hmonitor: string;
  left: number;
  top: number;
  isPrimary: boolean;
  width: number;
  height: number;
}

interface NativeSdrCapabilitiesState {
  checked: boolean;
  available: boolean;
  hevcAvailable: boolean;
  h264Available: boolean;
  displays: SdrDisplaySummary[];
}

interface AudioDataInitLike {
  format: 'f32';
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: Float32Array;
}

interface AudioDataLike {
  close: () => void;
}

type AudioDataConstructor = new (init: AudioDataInitLike) => AudioDataLike;

type MediaStreamTrackGeneratorLike = MediaStreamTrack & {
  writable: WritableStream<AudioDataLike>;
};

type MediaStreamTrackGeneratorConstructor = new (init: {
  kind: 'audio';
}) => MediaStreamTrackGeneratorLike;

export interface NativeSdrState {
  active: boolean;
  reconfiguring: boolean;
  sourceId: string | null;
  publication: { identity: string; trackSid: string; width: number; height: number } | null;
  codec: NativeSdrCodec | null;
  requestedResolvedCodec: 'h265' | 'h264' | null;
  stats: NativeSdrStats | null;
  pendingColor: HdrColor | null;
  colorError: boolean;
  capabilities: NativeSdrCapabilitiesState;
  refreshCapabilities: (probeEncoder?: boolean) => Promise<NativeSdrCapabilitiesState>;
  publish: (
    room: Room,
    sourceId: string,
    config: ScreenShareConfig,
    fallbackDimensions?: { width?: number; height?: number },
  ) => Promise<boolean>;
  reconfigure: (room: Room, config: ScreenShareConfig) => Promise<boolean>;
  stop: (room?: Room | null) => Promise<void>;
  setColor: (color: HdrColor) => void;
  requestKeyFrame: () => void;
  onViewerWatch: (
    room: Room | null,
    viewerIdentity: string,
    watching: boolean,
    supportsHevc?: boolean,
  ) => void;
  evictViewer: (viewerIdentity: string) => void;
}

const H264_GAMING_BITRATE_MULTIPLIER = 1.15;

function sameStreamColor(a: StreamColorSettings, b: StreamColorSettings): boolean {
  if (a.digitalVibrance !== b.digitalVibrance || a.hue !== b.hue) return false;
  for (const key of COLOR_CHANNEL_KEYS) {
    const ca = a[key];
    const cb = b[key];
    if (
      ca.brightness !== cb.brightness ||
      ca.contrast !== cb.contrast ||
      Math.round(ca.gamma * 100) !== Math.round(cb.gamma * 100)
    ) {
      return false;
    }
  }
  return true;
}

function resolveMatrixKbps(
  height: number,
  fps: number,
  overrides: Record<string, number> | null | undefined,
): number {
  const key = `${height}_${fps}`;
  if (overrides?.[key] != null) return overrides[key]!;
  return BITRATE_MATRIX_KBPS[height]?.[fps] ?? BITRATE_MATRIX_KBPS[1080]![60]!;
}

function computeNativeBitrateKbps(
  width: number,
  height: number,
  fps: number,
  overrides: Record<string, number> | null | undefined,
): number {
  const capturedPixels = width * height;
  let nearestHeight: StandardResolution = 1080;
  let nearestDist = Infinity;
  for (const h of STANDARD_RESOLUTIONS) {
    const knownPixels = WIDTH_MAP[h] * h;
    const dist = Math.abs(capturedPixels - knownPixels);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestHeight = h;
    }
  }
  let nearestFps = 30;
  let nearestFpsDist = Infinity;
  for (const f of STANDARD_FRAMERATES) {
    const dist = Math.abs(fps - f);
    if (dist < nearestFpsDist) {
      nearestFpsDist = dist;
      nearestFps = f;
    }
  }
  const baseKbps = resolveMatrixKbps(nearestHeight, nearestFps, overrides);
  const nearestPixels = WIDTH_MAP[nearestHeight] * nearestHeight;
  return Math.round(baseKbps * (capturedPixels / nearestPixels) * (fps / nearestFps));
}

function computeTargetBitrateKbps(
  config: ScreenShareConfig,
  codec: NativeSdrCodec,
  fallbackDimensions?: { width?: number; height?: number },
): number {
  const limits = getStreamingLimits();
  const overrides = limits.bitrateMatrixOverrides;
  const usingCustom = config.customBitrateKbps != null && limits.allowCustomBitrate;
  let rawKbps: number;
  if (usingCustom) {
    rawKbps = config.customBitrateKbps!;
  } else if (config.height === 'native') {
    const fw = fallbackDimensions?.width ?? 0;
    const fh = fallbackDimensions?.height ?? 0;
    if (fw > 0 && fh > 0) {
      rawKbps = computeNativeBitrateKbps(fw, fh, config.fps, overrides);
    } else {
      const nearestFps = STANDARD_FRAMERATES.reduce((a, b) =>
        Math.abs(b - config.fps) < Math.abs(a - config.fps) ? b : a,
      );
      const fallbackHeight = STANDARD_RESOLUTIONS.includes(limits.maxResolution as StandardResolution)
        ? limits.maxResolution
        : 1440;
      rawKbps = resolveMatrixKbps(fallbackHeight, nearestFps, overrides);
    }
  } else {
    rawKbps = resolveMatrixKbps(config.height as number, config.fps, overrides);
  }

  if (!usingCustom && codec === 'h264' && config.mode === 'gaming') {
    rawKbps = Math.round(rawKbps * H264_GAMING_BITRATE_MULTIPLIER);
  }
  return Math.min(Math.max(rawKbps, limits.minBitrateKbps), limits.maxBitrateKbps);
}

function resolveNativeSdrCodec(
  userCodec: ScreenShareConfig['codec'],
  caps: Pick<NativeSdrCapabilitiesState, 'hevcAvailable' | 'h264Available'>,
  hasNonHevcWatcher: boolean,
): { nativeCodec: NativeSdrCodec; requestedResolvedCodec: 'h265' | 'h264' } | null {
  if (userCodec === 'vp9') return null;
  if (userCodec === 'h264') {
    if (!caps.h264Available) return null;
    return { nativeCodec: 'h264', requestedResolvedCodec: 'h264' };
  }
  if (userCodec === 'h265') {
    if (!caps.hevcAvailable) return null;
    return { nativeCodec: 'hevc', requestedResolvedCodec: 'h265' };
  }
  // userCodec === 'auto'
  if (caps.hevcAvailable) {
    if (hasNonHevcWatcher && caps.h264Available) {
      return { nativeCodec: 'h264', requestedResolvedCodec: 'h265' };
    }
    return { nativeCodec: 'hevc', requestedResolvedCodec: 'h265' };
  }
  if (caps.h264Available) {
    return { nativeCodec: 'h264', requestedResolvedCodec: 'h264' };
  }
  return null;
}

function voiceSession() {
  const voice = useVoiceStore.getState();
  const channelId = voice.currentVoiceChannelId ?? voice.activeDmCall?.dmChannelId;
  const origin = voice.callOrigin ?? (channelId ? getChannelOrigin(channelId) : '');
  if (!channelId || (origin && origin !== window.location.origin)) {
    throw new Error('Native SDR requires a local voice session');
  }
  const authToken = useAuthStore.getState().token;
  if (!authToken) throw new Error('SDR authorization unavailable');
  return { channelId, authToken, isDm: !voice.currentVoiceChannelId };
}

let boundApi: BackspaceElectronAPI | undefined;
let eventUnbind: (() => void) | undefined;
let audioUnbind: (() => void) | undefined;
let sessionUnbind: (() => void) | undefined;
let authUnbind: (() => void) | undefined;

let publisherRevision = 0;
let activeRequestId: string | null = null;
let activeRoomRef: Room | null = null;
let activeSession: ReturnType<typeof voiceSession> | null = null;
let activeFallbackDims: { width?: number; height?: number } | undefined;
let lastPublishedSpec: string | null = null;

// WASAPI loopback audio -> WebCodecs MediaStreamTrackGenerator -> LiveKit ScreenShareAudio
let audioGeneratorTrack: MediaStreamTrackGeneratorLike | null = null;
let audioWriter: WritableStreamDefaultWriter<AudioDataLike> | null = null;
let audioTimestampUs = 0;
let audioPublishedForRequestId: string | null = null;

// Viewers whose browser reported supportsHevc === false
const nonHevcWatchers = new Set<string>();

// Live constant-buffer color queue
let colorTimer: ReturnType<typeof setTimeout> | undefined;
let colorBusy = false;
let colorGeneration = 0;

function cancelColor() {
  colorGeneration++;
  clearTimeout(colorTimer);
  colorTimer = undefined;
  colorBusy = false;
  useNativeSdrStore.setState({ pendingColor: null, colorError: false });
}

function queueColor() {
  if (colorTimer || colorBusy) return;
  colorTimer = setTimeout(() => {
    colorTimer = undefined;
    void flushColor();
  }, 80);
}

async function flushColor() {
  const state = useNativeSdrStore.getState();
  const color = state.pendingColor;
  const requestId = activeRequestId;
  const generation = colorGeneration;
  if (!color || !requestId || !state.publication || colorBusy) return;
  colorBusy = true;
  try {
    const result = (await window.backspace?.sdrNative?.({
      action: 'publisher-color',
      requestId,
      color,
    })) as { ok?: boolean } | undefined;
    if (generation !== colorGeneration || activeRequestId !== requestId) return;
    if (result?.ok !== true) throw new Error('SDR color not applied');
    if (useNativeSdrStore.getState().pendingColor === color) {
      useNativeSdrStore.setState({ pendingColor: null });
    }
  } catch {
    if (generation === colorGeneration) {
      useNativeSdrStore.setState({ pendingColor: null, colorError: true });
    }
  } finally {
    if (generation === colorGeneration) {
      colorBusy = false;
      if (useNativeSdrStore.getState().pendingColor) queueColor();
    }
  }
}

async function teardownAudioPublication(room: Room | null): Promise<void> {
  audioPublishedForRequestId = null;
  const writer = audioWriter;
  const track = audioGeneratorTrack;
  audioWriter = null;
  audioGeneratorTrack = null;
  audioTimestampUs = 0;

  if (writer) {
    try {
      await writer.close();
    } catch {
      /* ignore */
    }
  }
  if (room) {
    try {
      const pub = room.localParticipant.getTrackPublication?.(Track.Source.ScreenShareAudio);
      if (pub?.track) {
        await room.localParticipant.unpublishTrack(pub.track as LocalAudioTrack, true);
      } else if (track) {
        await room.localParticipant.unpublishTrack(track, true);
      }
    } catch {
      /* ignore */
    }
  }
  if (track) {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  }
}

async function ensureAudioPublication(room: Room, requestId: string, shareAudio: boolean): Promise<void> {
  if (!shareAudio) {
    await teardownAudioPublication(room);
    return;
  }
  const g = globalThis as Record<string, unknown>;
  const Generator = g.MediaStreamTrackGenerator as MediaStreamTrackGeneratorConstructor | undefined;
  const AudioDataCtor = g.AudioData as AudioDataConstructor | undefined;
  if (typeof Generator !== 'function' || typeof AudioDataCtor !== 'function') {
    return;
  }
  await teardownAudioPublication(room);
  if (activeRequestId !== requestId) return;

  try {
    const generator = new Generator({ kind: 'audio' });
    const writer = generator.writable.getWriter();
    audioGeneratorTrack = generator;
    audioWriter = writer;
    audioTimestampUs = 0;
    audioPublishedForRequestId = requestId;

    await room.localParticipant.publishTrack(generator, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: AudioPresets.musicHighQualityStereo,
      dtx: false,
      red: false,
      forceStereo: true,
    });
  } catch (err) {
    console.warn('[NativeSDR] System audio publication failed, continuing video:', err);
    await teardownAudioPublication(room);
  }
}

function unwatchSelfIfNeeded(room: Room | null) {
  const identity = room?.localParticipant?.identity;
  if (!identity) return;
  const userId = identity.split(':')[0] ?? identity;
  useVoiceStore.getState().unwatchStream(userId);
}

function syncSession() {
  if (!activeSession) return;
  try {
    const current = voiceSession();
    if (
      current.channelId === activeSession.channelId &&
      current.isDm === activeSession.isDm &&
      current.authToken === activeSession.authToken
    ) {
      return;
    }
  } catch {
    /* disconnected or signed out */
  }
  void useNativeSdrStore.getState().stop(activeRoomRef);
}

function bindEvents() {
  const desktop = window.backspace;
  if (boundApi === desktop) return;
  eventUnbind?.();
  audioUnbind?.();
  sessionUnbind?.();
  authUnbind?.();
  boundApi = desktop;

  sessionUnbind = useVoiceStore.subscribe(syncSession);
  authUnbind = useAuthStore.subscribe?.(syncSession);

  eventUnbind = desktop?.onSdrNativeEvent?.((value) => {
    const event = value as {
      kind?: string;
      state?: string;
      requestId?: string;
      codec?: NativeSdrCodec;
      encodeFps?: number;
      captureFps?: number;
      encodeTimeMs?: number;
      bitrateKbps?: number;
      width?: number;
      height?: number;
      sourceWidth?: number;
      sourceHeight?: number;
    };
    if (!event || !activeRequestId || event.requestId !== activeRequestId) return;

    if (event.kind === 'stats' && (event.codec === 'hevc' || event.codec === 'h264')) {
      useNativeSdrStore.setState({
        stats: {
          codec: event.codec,
          encodeFps: typeof event.encodeFps === 'number' ? event.encodeFps : 0,
          captureFps: typeof event.captureFps === 'number' ? event.captureFps : 0,
          encodeTimeMs: typeof event.encodeTimeMs === 'number' ? event.encodeTimeMs : 0,
          bitrateKbps: typeof event.bitrateKbps === 'number' ? event.bitrateKbps : 0,
          width: typeof event.width === 'number' ? event.width : 0,
          height: typeof event.height === 'number' ? event.height : 0,
          sourceWidth: typeof event.sourceWidth === 'number' ? event.sourceWidth : 0,
          sourceHeight: typeof event.sourceHeight === 'number' ? event.sourceHeight : 0,
        },
      });
      return;
    }

    if (event.kind === 'audio-stopped') {
      void teardownAudioPublication(activeRoomRef);
      return;
    }

    if (event.kind === 'publisher' && event.state === 'stopped') {
      const room = activeRoomRef;
      activeRequestId = null;
      activeRoomRef = null;
      activeSession = null;
      lastPublishedSpec = null;
      nonHevcWatchers.clear();
      cancelColor();
      publisherRevision++;
      void teardownAudioPublication(room);
      getElectronAPI()?.setStreamingPowerMode?.(false);
      unwatchSelfIfNeeded(room);
      const wasActive = useNativeSdrStore.getState().active;
      useNativeSdrStore.setState({
        active: false,
        reconfiguring: false,
        sourceId: null,
        publication: null,
        codec: null,
        requestedResolvedCodec: null,
        stats: null,
      });
      if (wasActive) {
        useVoiceStore.setState({ isScreenSharing: false, screenShareDynamicRange: 'sdr' });
        broadcastVoiceStatus();
      }
    }
  });

  audioUnbind = desktop?.onSdrNativeAudio?.((value) => {
    const frame = value as {
      requestId?: string;
      sampleRate?: number;
      channels?: number;
      frames?: number;
      pcm?: Float32Array;
    };
    if (
      !activeRequestId ||
      !frame ||
      frame.requestId !== activeRequestId ||
      audioPublishedForRequestId !== activeRequestId ||
      !audioWriter ||
      typeof frame.sampleRate !== 'number' ||
      typeof frame.channels !== 'number' ||
      typeof frame.frames !== 'number' ||
      !(frame.pcm instanceof Float32Array)
    ) {
      return;
    }
    const AudioDataCtor = (globalThis as Record<string, unknown>).AudioData as AudioDataConstructor | undefined;
    if (typeof AudioDataCtor !== 'function') return;
    try {
      const audioData = new AudioDataCtor({
        format: 'f32',
        sampleRate: frame.sampleRate,
        numberOfFrames: frame.frames,
        numberOfChannels: frame.channels,
        timestamp: audioTimestampUs,
        data: frame.pcm,
      });
      audioTimestampUs += Math.round((frame.frames * 1_000_000) / frame.sampleRate);
      audioWriter.write(audioData).catch(() => {});
      audioData.close();
    } catch {
      /* ignore transient frame drop */
    }
  });
}

function buildPublishSpecSignature(
  sourceId: string,
  maxHeight: number | 'native',
  fps: number,
  bitrateKbps: number,
  codec: NativeSdrCodec,
  shareAudio: boolean,
): string {
  return `${sourceId}|${maxHeight}|${fps}|${bitrateKbps}|${codec}|${shareAudio ? 1 : 0}`;
}

export function isNativeSdrEligibleSourceId(sourceId: string | null | undefined): sourceId is string {
  return typeof sourceId === 'string' && (sourceId.startsWith('screen:') || sourceId.startsWith('window:'));
}

export const useNativeSdrStore = create<NativeSdrState>((set, get) => ({
  active: false,
  reconfiguring: false,
  sourceId: null,
  publication: null,
  codec: null,
  requestedResolvedCodec: null,
  stats: null,
  pendingColor: null,
  colorError: false,
  capabilities: {
    checked: false,
    available: false,
    hevcAvailable: false,
    h264Available: false,
    displays: [],
  },

  refreshCapabilities: async (probeEncoder = true) => {
    bindEvents();
    const sdrNative = window.backspace?.sdrNative;
    if (!sdrNative || window.backspace?.platform !== 'win32') {
      const unavailable: NativeSdrCapabilitiesState = {
        checked: true,
        available: false,
        hevcAvailable: false,
        h264Available: false,
        displays: [],
      };
      set({ capabilities: unavailable });
      return unavailable;
    }
    try {
      const [server, local] = (await Promise.all([
        api.livekit.status(),
        sdrNative({ action: 'capabilities', ...(probeEncoder ? { probeEncoder: true } : {}) }),
      ])) as [
        { nativeSdrProtocol?: number },
        {
          protocol?: number;
          available?: boolean;
          hevcAvailable?: boolean;
          h264Available?: boolean;
          displays?: SdrDisplaySummary[];
        },
      ];
      if (server.nativeSdrProtocol !== 1 || local.protocol !== 1 || !Array.isArray(local.displays)) {
        const unsupported: NativeSdrCapabilitiesState = {
          checked: true,
          available: false,
          hevcAvailable: false,
          h264Available: false,
          displays: [],
        };
        set({ capabilities: unsupported });
        return unsupported;
      }
      const next: NativeSdrCapabilitiesState = {
        checked: true,
        available: local.available === true && (local.hevcAvailable === true || local.h264Available === true),
        hevcAvailable: local.hevcAvailable === true,
        h264Available: local.h264Available === true,
        displays: local.displays,
      };
      set({ capabilities: next });
      return next;
    } catch {
      const failed: NativeSdrCapabilitiesState = {
        checked: true,
        available: false,
        hevcAvailable: false,
        h264Available: false,
        displays: [],
      };
      set({ capabilities: failed });
      return failed;
    }
  },

  publish: async (room, sourceId, config, fallbackDimensions) => {
    bindEvents();
    if (
      config.hdrEnabled ||
      config.codec === 'vp9' ||
      !isNativeSdrEligibleSourceId(sourceId) ||
      !window.backspace?.sdrNative ||
      window.backspace.platform !== 'win32'
    ) {
      return false;
    }

    const caps = await get().refreshCapabilities(true);
    if (!caps.available) return false;

    nonHevcWatchers.clear();
    const resolved = resolveNativeSdrCodec(config.codec, caps, false);
    if (!resolved) return false;

    cancelColor();
    const revision = ++publisherRevision;
    const requestId = crypto.randomUUID();
    activeRequestId = requestId;
    activeRoomRef = room;
    activeFallbackDims = fallbackDimensions;

    try {
      const session = voiceSession();
      activeSession = session;
      const maxHeight = config.height;
      const bitrateKbps = computeTargetBitrateKbps(config, resolved.nativeCodec, fallbackDimensions);
      const startedStreamColor = cloneStreamColor(config.streamColor ?? DEFAULT_STREAM_COLOR);

      const result = (await window.backspace.sdrNative({
        action: 'publish',
        requestId,
        sourceId,
        config: {
          maxHeight,
          fps: config.fps,
          bitrateKbps,
          codec: resolved.nativeCodec,
          shareAudio: config.shareAudio,
          color: { exposureEv: 0, streamColor: startedStreamColor },
        },
        ...session,
      })) as {
        identity?: string;
        trackSid?: string;
        width?: number;
        height?: number;
        codec?: NativeSdrCodec;
      };

      if (revision !== publisherRevision) return false;
      if (!result?.identity?.startsWith('__backspace_hdr_v1__') || !result.trackSid) {
        throw new Error('Native SDR publication not confirmed');
      }

      const currentSession = voiceSession();
      if (
        currentSession.channelId !== session.channelId ||
        currentSession.isDm !== session.isDm ||
        currentSession.authToken !== session.authToken
      ) {
        await get().stop(room);
        return false;
      }

      const width = typeof result.width === 'number' && result.width > 0 ? result.width : 1920;
      const height = typeof result.height === 'number' && result.height > 0 ? result.height : 1080;
      const confirmedCodec: NativeSdrCodec = result.codec === 'h264' ? 'h264' : resolved.nativeCodec;

      lastPublishedSpec = buildPublishSpecSignature(
        sourceId,
        maxHeight,
        config.fps,
        bitrateKbps,
        confirmedCodec,
        config.shareAudio,
      );

      await ensureAudioPublication(room, requestId, config.shareAudio);
      if (revision !== publisherRevision) return false;

      getElectronAPI()?.setStreamingPowerMode?.(true);
      // Local self-preview starts paused by default to save dual-monitor DWM/VRAM composition
      unwatchSelfIfNeeded(room);

      set({
        active: true,
        reconfiguring: false,
        sourceId,
        publication: { identity: result.identity, trackSid: result.trackSid, width, height },
        codec: confirmedCodec,
        requestedResolvedCodec: resolved.requestedResolvedCodec,
        stats: {
          codec: confirmedCodec,
          encodeFps: config.fps,
          captureFps: config.fps,
          encodeTimeMs: 0,
          bitrateKbps,
          width,
          height,
          sourceWidth: fallbackDimensions?.width ?? width,
          sourceHeight: fallbackDimensions?.height ?? height,
        },
      });

      useVoiceStore.setState({ isScreenSharing: true, screenShareDynamicRange: 'sdr' });

      const latestColor = useVoiceStore.getState().screenShareConfig.streamColor ?? DEFAULT_STREAM_COLOR;
      if (!sameStreamColor(latestColor, startedStreamColor)) {
        get().setColor({ exposureEv: 0, streamColor: latestColor });
      }
      broadcastVoiceStatus();
      return true;
    } catch (err) {
      console.warn('[NativeSDR] Falling back to WebRTC screen capture:', err);
      if (revision === publisherRevision) {
        activeRequestId = null;
        activeRoomRef = null;
        activeSession = null;
        lastPublishedSpec = null;
        await teardownAudioPublication(room);
        try {
          await window.backspace?.sdrNative?.({ action: 'stop' });
        } catch {
          /* ignore */
        }
        set({
          active: false,
          reconfiguring: false,
          sourceId: null,
          publication: null,
          codec: null,
          requestedResolvedCodec: null,
          stats: null,
        });
      }
      return false;
    }
  },

  reconfigure: async (room, config) => {
    const state = get();
    if (!state.active || !state.sourceId || !window.backspace?.sdrNative) return false;
    if (config.hdrEnabled || config.codec === 'vp9') return false;

    const caps = state.capabilities.checked ? state.capabilities : await get().refreshCapabilities(true);
    const resolved = resolveNativeSdrCodec(config.codec, caps, nonHevcWatchers.size > 0);
    if (!resolved) return false;

    const maxHeight = config.height;
    const bitrateKbps = computeTargetBitrateKbps(config, resolved.nativeCodec, activeFallbackDims);
    const nextSpec = buildPublishSpecSignature(
      state.sourceId,
      maxHeight,
      config.fps,
      bitrateKbps,
      resolved.nativeCodec,
      config.shareAudio,
    );

    const streamColor = config.streamColor ?? DEFAULT_STREAM_COLOR;
    if (nextSpec === lastPublishedSpec) {
      get().setColor({ exposureEv: 0, streamColor });
      return true;
    }

    cancelColor();
    const revision = ++publisherRevision;
    const requestId = crypto.randomUUID();
    activeRequestId = requestId;
    activeRoomRef = room;
    set({ reconfiguring: true });

    try {
      const session = voiceSession();
      activeSession = session;
      const startedStreamColor = cloneStreamColor(streamColor);

      const result = (await window.backspace.sdrNative({
        action: 'publish',
        requestId,
        sourceId: state.sourceId,
        config: {
          maxHeight,
          fps: config.fps,
          bitrateKbps,
          codec: resolved.nativeCodec,
          shareAudio: config.shareAudio,
          color: { exposureEv: 0, streamColor: startedStreamColor },
        },
        ...session,
      })) as {
        identity?: string;
        trackSid?: string;
        width?: number;
        height?: number;
        codec?: NativeSdrCodec;
      };

      if (revision !== publisherRevision) return false;
      if (!result?.identity?.startsWith('__backspace_hdr_v1__') || !result.trackSid) {
        throw new Error('Native SDR reconfiguration not confirmed');
      }

      const width = typeof result.width === 'number' && result.width > 0 ? result.width : 1920;
      const height = typeof result.height === 'number' && result.height > 0 ? result.height : 1080;
      const confirmedCodec: NativeSdrCodec = result.codec === 'h264' ? 'h264' : resolved.nativeCodec;
      lastPublishedSpec = nextSpec;

      await ensureAudioPublication(room, requestId, config.shareAudio);
      if (revision !== publisherRevision) return false;

      set({
        active: true,
        reconfiguring: false,
        publication: { identity: result.identity, trackSid: result.trackSid, width, height },
        codec: confirmedCodec,
        requestedResolvedCodec: resolved.requestedResolvedCodec,
        stats: {
          codec: confirmedCodec,
          encodeFps: config.fps,
          captureFps: config.fps,
          encodeTimeMs: state.stats?.encodeTimeMs ?? 0,
          bitrateKbps,
          width,
          height,
          sourceWidth: state.stats?.sourceWidth ?? width,
          sourceHeight: state.stats?.sourceHeight ?? height,
        },
      });
      return true;
    } catch (err) {
      console.error('[NativeSDR] Reconfigure failed:', err);
      if (revision === publisherRevision) {
        await get().stop(room);
      }
      return false;
    }
  },

  stop: async (room) => {
    publisherRevision++;
    activeRequestId = null;
    const targetRoom = room ?? activeRoomRef;
    activeRoomRef = null;
    activeSession = null;
    activeFallbackDims = undefined;
    lastPublishedSpec = null;
    nonHevcWatchers.clear();
    cancelColor();

    const wasActive = get().active;
    set({
      active: false,
      reconfiguring: false,
      sourceId: null,
      publication: null,
      codec: null,
      requestedResolvedCodec: null,
      stats: null,
    });

    getElectronAPI()?.setStreamingPowerMode?.(false);
    unwatchSelfIfNeeded(targetRoom ?? null);
    await teardownAudioPublication(targetRoom ?? null);

    try {
      await window.backspace?.sdrNative?.({ action: 'stop' });
    } catch {
      /* native owner also stops on navigation/disconnection */
    }

    if (wasActive) {
      useVoiceStore.setState({ isScreenSharing: false, screenShareDynamicRange: 'sdr' });
      broadcastVoiceStatus();
    }
  },

  setColor: (color) => {
    if (!isHdrColor(color)) return;
    const voice = useVoiceStore.getState();
    if (voice.screenShareConfig.hdrEnabled) return;
    if (!get().active || !get().publication) {
      set({ colorError: false });
      return;
    }
    set({
      pendingColor: { exposureEv: 0, streamColor: cloneStreamColor(color.streamColor) },
      colorError: false,
    });
    queueColor();
  },

  requestKeyFrame: () => {
    const requestId = activeRequestId;
    if (!get().active || !requestId) return;
    void window.backspace?.sdrNative?.({ action: 'keyframe', requestId }).catch(() => {});
  },

  onViewerWatch: (room, viewerIdentity, watching, supportsHevc) => {
    if (!watching) {
      nonHevcWatchers.delete(viewerIdentity);
      return;
    }
    const state = get();
    if (!state.active) return;

    if (supportsHevc === false) {
      nonHevcWatchers.add(viewerIdentity);
      const currentConfig = useVoiceStore.getState().screenShareConfig;
      if (
        currentConfig.codec === 'auto' &&
        state.codec === 'hevc' &&
        state.capabilities.h264Available &&
        room
      ) {
        void get().reconfigure(room, currentConfig);
        return;
      }
    } else if (supportsHevc === true) {
      nonHevcWatchers.delete(viewerIdentity);
    }

    // Immediate IDR frame so newly subscribed viewers start decoding without waiting 2s GOP
    get().requestKeyFrame();
  },

  evictViewer: (viewerIdentity) => {
    nonHevcWatchers.delete(viewerIdentity);
  },
}));
