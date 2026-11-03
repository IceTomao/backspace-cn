import { Room, Track, BackupCodecPolicy, AudioPresets, type LocalVideoTrack } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import type { ScreenShareConfig } from '../stores/voiceStore';
import { getStreamingLimits } from '../stores/settingsStore';
import { getPublisherPC, getMediaStreamTrack } from './livekitInternals';
import { broadcastVoiceStatus } from './voice';
import { activate as activateHwOverdrive, deactivate as deactivateHwOverdrive } from './hwOverdrive';
import { useUIStore } from '../stores/uiStore';
import { openScreenShareSetup } from '../stores/screenShareSetupStore';
import i18n from '../i18n';
import { useNativeHdrStore } from '../stores/nativeHdrStore';
import { useNativeSdrStore } from '../stores/nativeSdrStore';
import { getElectronAPI } from '../platform/platform';
import { DEFAULT_STREAM_COLOR, isDefaultStreamColor, type StreamColorSettings } from './streamColor';
import {
  attachStreamColorProcessor,
  detachStreamColorProcessor,
  createScreenShareColorTrackProcessor,
  getUnderlyingCaptureTrack,
} from './streamColorProcessor';
import {
  isH264WebRtcSupported,
  isH265WebRtcSupported,
  probeHardwareScreenShareCodecs,
  resolveEffectiveScreenShareCodec,
  type CodecProbeTarget,
  type ResolvedScreenShareCodec,
} from './codecCapabilities';
import {
  STANDARD_RESOLUTIONS, STANDARD_FRAMERATES, WIDTH_MAP,
  BITRATE_MATRIX_KBPS,
  type StandardResolution,
} from '@backspace/shared/src/constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverdriveOptions {
  maxBitrate: number;
  maxFramerate: number;
  degradationPreference: RTCDegradationPreference;
  scaleResolutionDownBy?: number;
}

export function isWindowsElectronCapture(): boolean {
  return getElectronAPI()?.platform === 'win32';
}

export function computeEncoderScaleDown(
  sourceHeight: number | undefined,
  targetHeight: number,
): number {
  if (!sourceHeight || sourceHeight <= 0 || targetHeight <= 0 || sourceHeight <= targetHeight) {
    return 1;
  }
  return Math.max(1, Math.round((sourceHeight / targetHeight) * 1000) / 1000);
}

export interface ScreenShareBuildResult {
  capture: { width: number; height: number; frameRate: number };
  publish: {
    videoCodec: ResolvedScreenShareCodec;
    videoEncoding: { maxBitrate: number; maxFramerate: number };
    simulcast: false;
    backupCodec?: { codec: 'vp8' | 'h264'; encoding: { maxBitrate: number; maxFramerate: number } };
    backupCodecPolicy?: BackupCodecPolicy;
    audioPreset: typeof AudioPresets.musicHighQualityStereo;
    dtx: false;
    red: false;
    forceStereo: true;
  };
  overdrive: OverdriveOptions;
  contentHint: 'motion' | 'detail';
}

export function isH265ScreenShareSupported(): boolean {
  return isH265WebRtcSupported();
}

/** Reset unsupported saved choices once, shared by the settings UI and publication. */
export function ensureSupportedScreenShareCodec(): ScreenShareConfig {
  const { screenShareConfig, setScreenShareConfig } = useVoiceStore.getState();
  if (!screenShareConfig.hdrEnabled && screenShareConfig.codec === 'h265' && !isH265ScreenShareSupported()) {
    setScreenShareConfig({ codec: 'auto' });
    useUIStore.getState().addToast(
      i18n.t('voice:streamSettings.h265Fallback'),
      'warning',
      8000,
    );
    return useVoiceStore.getState().screenShareConfig;
  }
  return screenShareConfig;
}

// ---------------------------------------------------------------------------
// Camera preset (fixed 720p30 H264, decoupled from screen share)
// ---------------------------------------------------------------------------

export const CAMERA_PRESET = {
  resolution: { width: 1280, height: 720 },
  encoding: { maxBitrate: 2_000_000, maxFramerate: 30 },
  codec: 'h264' as const,
} as const;

export const CAMERA_OVERDRIVE: OverdriveOptions = {
  maxBitrate: 2_000_000,
  maxFramerate: 30,
  degradationPreference: 'maintain-framerate',
};

// ---------------------------------------------------------------------------
// Screen share builder — three independent axes → computed result
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Resolve a matrix cell: admin override first, then default (all in kbps)
// ---------------------------------------------------------------------------

function resolveMatrixKbps(height: number, fps: number, overrides: Record<string, number> | null | undefined): number {
  const key = `${height}_${fps}`;
  if (overrides?.[key] != null) return overrides[key]!;
  return BITRATE_MATRIX_KBPS[height]?.[fps] ?? BITRATE_MATRIX_KBPS[1080]![60]!;
}

// ---------------------------------------------------------------------------
// Native mode — pixel-count-proportional bitrate computation
// ---------------------------------------------------------------------------

function computeNativeBitrate(
  capturedWidth: number,
  capturedHeight: number,
  fps: number,
  overrides: Record<string, number> | null | undefined,
): number {
  const capturedPixels = capturedWidth * capturedHeight;

  // Find nearest known resolution tier by pixel count (handles ultrawides correctly)
  let nearestHeight: StandardResolution = 1080;
  let nearestDist = Infinity;
  for (const h of STANDARD_RESOLUTIONS) {
    const knownPixels = WIDTH_MAP[h] * h;
    const dist = Math.abs(capturedPixels - knownPixels);
    if (dist < nearestDist) { nearestDist = dist; nearestHeight = h; }
  }

  // Snap to nearest known framerate
  let nearestFps = 30;
  let nearestFpsDist = Infinity;
  for (const f of STANDARD_FRAMERATES) {
    const dist = Math.abs(fps - f);
    if (dist < nearestFpsDist) { nearestFpsDist = dist; nearestFps = f; }
  }

  const baseKbps = resolveMatrixKbps(nearestHeight, nearestFps, overrides);
  const nearestPixels = WIDTH_MAP[nearestHeight] * nearestHeight;

  // Scale proportionally by pixel count and framerate — result in kbps
  return Math.round(baseKbps * (capturedPixels / nearestPixels) * (fps / nearestFps));
}

const H264_GAMING_BITRATE_MULTIPLIER = 1.15;

export function buildScreenShareOptions(config: ScreenShareConfig): ScreenShareBuildResult {
  const { height, fps, mode, customBitrateKbps } = config;
  const isNative = height === 'native';
  const limits = getStreamingLimits();
  const overrides = limits.bitrateMatrixOverrides;
  const resolvedCodec = resolveEffectiveScreenShareCodec(config.codec, config.hdrEnabled);

  // Capture dimensions: sentinel 0 for native (caller skips resolution constraint)
  const captureWidth = isNative ? 0 : WIDTH_MAP[height as StandardResolution] ?? 1920;
  const captureHeight = isNative ? 0 : (height as number);

  // Resolve bitrate in kbps: custom (if allowed) > override > default > native estimate
  const usingCustomBitrate = customBitrateKbps != null && limits.allowCustomBitrate;
  let rawKbps: number;
  if (usingCustomBitrate) {
    rawKbps = customBitrateKbps!;
  } else if (isNative) {
    const nearestFps = STANDARD_FRAMERATES.reduce((a, b) =>
      Math.abs(b - fps) < Math.abs(a - fps) ? b : a
    );
    const fallbackNativeHeight = STANDARD_RESOLUTIONS.includes(limits.maxResolution as StandardResolution)
      ? limits.maxResolution
      : 1440;
    rawKbps = resolveMatrixKbps(fallbackNativeHeight, nearestFps, overrides);
  } else {
    rawKbps = resolveMatrixKbps(height as number, fps, overrides);
  }

  // H.264 requires ~15% higher bitrate than HEVC/VP9 for comparable high-motion gaming clarity
  if (!usingCustomBitrate && !config.hdrEnabled && resolvedCodec === 'h264' && mode === 'gaming') {
    rawKbps = Math.round(rawKbps * H264_GAMING_BITRATE_MULTIPLIER);
  }

  // Clamp to instance limits (all in kbps)
  const clampedKbps = Math.min(Math.max(rawKbps, limits.minBitrateKbps), limits.maxBitrateKbps);

  // Convert to bps ONLY at the WebRTC boundary
  const bps = clampedKbps * 1000;

  // Backup encoding: H.264 is universally supported, so omit backupCodec there.
  // For H.265 / VP9 use BackupCodecPolicy.REGRESSION so the backup encoder is
  // never instantiated simultaneously alongside the primary stream. When the
  // sender supports H.264, use hardware-accelerated H.264 at full target FPS
  // instead of VP8 capped at 30fps so Firefox / non-HEVC viewers never force a
  // 60/120fps → 30fps CPU software regression.
  const needsBackupCodec = !config.hdrEnabled && resolvedCodec !== 'h264';
  let backupCodec: { codec: 'vp8' | 'h264'; encoding: { maxBitrate: number; maxFramerate: number } } | undefined;
  if (needsBackupCodec) {
    if (isH264WebRtcSupported()) {
      let h264BackupKbps = rawKbps;
      if (!usingCustomBitrate && mode === 'gaming') {
        h264BackupKbps = Math.round(h264BackupKbps * H264_GAMING_BITRATE_MULTIPLIER);
      }
      const clampedBackupKbps = Math.min(Math.max(h264BackupKbps, limits.minBitrateKbps), limits.maxBitrateKbps);
      backupCodec = {
        codec: 'h264',
        encoding: { maxBitrate: clampedBackupKbps * 1000, maxFramerate: fps },
      };
    } else {
      const backupFps = Math.min(fps, 30);
      const backupBps = Math.round(bps * (backupFps / fps));
      backupCodec = {
        codec: 'vp8',
        encoding: { maxBitrate: backupBps, maxFramerate: backupFps },
      };
    }
  }

  return {
    capture: { width: captureWidth, height: captureHeight, frameRate: fps },
    publish: {
      videoCodec: resolvedCodec,
      videoEncoding: { maxBitrate: bps, maxFramerate: fps },
      simulcast: false,
      backupCodec,
      backupCodecPolicy: needsBackupCodec ? BackupCodecPolicy.REGRESSION : undefined,
      audioPreset: AudioPresets.musicHighQualityStereo,
      dtx: false,
      red: false,
      forceStereo: true,
    },
    overdrive: {
      maxBitrate: bps,
      maxFramerate: fps,
      degradationPreference: config.degradationPreference ?? (mode === 'gaming' ? 'maintain-framerate' : 'maintain-resolution'),
    },
    contentHint: mode === 'text' ? 'detail' : 'motion',
  };
}

function buildProbeTargetForConfig(config: ScreenShareConfig): CodecProbeTarget {
  const height = config.height === 'native' ? 1440 : (config.height as number);
  const width = WIDTH_MAP[height as StandardResolution] ?? Math.round((height * 16) / 9);
  const nearestFps = STANDARD_FRAMERATES.reduce((a, b) =>
    Math.abs(b - config.fps) < Math.abs(a - config.fps) ? b : a,
  );
  const bitrateKbps = config.customBitrateKbps ?? resolveMatrixKbps(height, nearestFps, getStreamingLimits().bitrateMatrixOverrides);
  return {
    width,
    height,
    framerate: config.fps,
    bitrate: bitrateKbps * 1000,
  };
}

async function applyCaptureConstraintsToTrack(
  track: MediaStreamTrack,
  opts: ScreenShareBuildResult,
): Promise<void> {
  const rawTrack = getUnderlyingCaptureTrack(track) ?? track;
  if (typeof rawTrack.applyConstraints !== 'function') return;
  try {
    if (!isWindowsElectronCapture() && opts.capture.width > 0 && opts.capture.height > 0) {
      await rawTrack.applyConstraints({
        width: { ideal: opts.capture.width, max: opts.capture.width },
        height: { ideal: opts.capture.height, max: opts.capture.height },
        frameRate: { ideal: opts.capture.frameRate, max: opts.capture.frameRate },
      });
    } else {
      await rawTrack.applyConstraints({
        frameRate: { ideal: opts.capture.frameRate, max: opts.capture.frameRate },
      });
    }
  } catch (err) {
    console.warn('[ScreenShare] Failed to apply capture constraints:', err);
  }
}

// ---------------------------------------------------------------------------
// Shared helper: resolve native-mode overdrive from actual track dimensions
// Used by publishScreenShare, scheduleScreenShareOverdrive, and updateActiveTracks
// ---------------------------------------------------------------------------

export function resolveNativeOverdrive(
  mediaTrack: MediaStreamTrack | null | undefined,
  config: ScreenShareConfig,
  opts: ScreenShareBuildResult,
): void {
  const limits = getStreamingLimits();
  const effectiveCustom = limits.allowCustomBitrate ? config.customBitrateKbps : null;
  const sourceTrack = getUnderlyingCaptureTrack(mediaTrack);
  if (config.height !== 'native' || effectiveCustom != null || !sourceTrack) return;
  const settings = sourceTrack.getSettings();
  if (!settings.width || !settings.height) return;

  let nativeKbps = computeNativeBitrate(settings.width, settings.height, config.fps, limits.bitrateMatrixOverrides);
  if (!config.hdrEnabled && opts.publish.videoCodec === 'h264' && config.mode === 'gaming') {
    nativeKbps = Math.round(nativeKbps * H264_GAMING_BITRATE_MULTIPLIER);
  }
  const clampedKbps = Math.min(Math.max(nativeKbps, limits.minBitrateKbps), limits.maxBitrateKbps);

  // Convert to bps at the mutation point
  const bps = clampedKbps * 1000;
  opts.overdrive.maxBitrate = bps;
  opts.publish.videoEncoding.maxBitrate = bps;
  if (opts.publish.backupCodec) {
    if (opts.publish.backupCodec.codec === 'h264') {
      let h264NativeKbps = nativeKbps;
      if (!config.hdrEnabled && config.mode === 'gaming') {
        h264NativeKbps = Math.round(h264NativeKbps * H264_GAMING_BITRATE_MULTIPLIER);
      }
      const clampedBackupKbps = Math.min(Math.max(h264NativeKbps, limits.minBitrateKbps), limits.maxBitrateKbps);
      opts.publish.backupCodec.encoding.maxBitrate = clampedBackupKbps * 1000;
      opts.publish.backupCodec.encoding.maxFramerate = config.fps;
    } else {
      const backupFps = opts.publish.backupCodec.encoding.maxFramerate;
      opts.publish.backupCodec.encoding.maxBitrate = Math.round(bps * (backupFps / config.fps));
    }
  }
}

// ---------------------------------------------------------------------------
// Overdrive — forces bitrate/resolution/framerate on RTCRtpSender
// ---------------------------------------------------------------------------

export async function applyOverdrive(
  room: Room,
  source: Track.Source,
  options: OverdriveOptions,
): Promise<boolean> {
  try {
    const pub = room.localParticipant.getTrackPublications().find(p => p.source === source);
    if (!pub?.track) return false;

    const pc = getPublisherPC(room);
    if (!pc) return false;

    const pubMediaTrack = getMediaStreamTrack(pub.track);
    const senders = pc.getSenders();
    const sender = senders.find(s => s.track?.id === pubMediaTrack?.id)
      ?? (pub.track as { sender?: RTCRtpSender }).sender;
    if (!sender) return false;

    const params = sender.getParameters();
    if (!params.encodings?.length) return false;
    // Before LiveKit finishes configuring the sender, Chromium can expose one
    // empty placeholder encoding. Any values written there are replaced by
    // LiveKit's sendEncodings, so report "not ready" and let the bounded
    // scheduler retry after negotiation advances.
    if (params.encodings.length === 1 && Object.keys(params.encodings[0]!).length === 0) {
      return false;
    }

    // Target the highest-quality layer. With simulcast, encodings[0] is the
    // lowest layer; our overdrive must hit the top layer so the custom bitrate
    // slider controls the full-resolution stream, not the quarter-res one.
    // For non-simulcast tracks (single encoding), length - 1 === 0.
    const idx = params.encodings.length - 1;
    params.encodings[idx]!.maxBitrate = options.maxBitrate;
    params.encodings[idx]!.maxFramerate = options.maxFramerate;
    params.encodings[idx]!.priority = 'high';
    params.encodings[idx]!.networkPriority = 'high';
    if (options.scaleResolutionDownBy !== undefined) {
      params.encodings[idx]!.scaleResolutionDownBy = options.scaleResolutionDownBy;
    }
    (params as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference =
      options.degradationPreference;

    await sender.setParameters(params);

    // Also configure any LiveKit REGRESSION / SIMULCAST backup codec senders (e.g. H.265 → H.264)
    const simulcastCodecs = (pub.track as {
      simulcastCodecs?: Map<string, { sender?: RTCRtpSender; mediaStreamTrack?: MediaStreamTrack }>;
    }).simulcastCodecs;
    if (simulcastCodecs) {
      for (const entry of simulcastCodecs.values()) {
        const backupSender = entry.sender
          ?? (entry.mediaStreamTrack ? senders.find(s => s.track?.id === entry.mediaStreamTrack?.id) : undefined);
        if (!backupSender || backupSender === sender) continue;
        const bp = backupSender.getParameters();
        if (!bp.encodings?.length) continue;
        if (bp.encodings.length === 1 && Object.keys(bp.encodings[0]!).length === 0) continue;
        const bIdx = bp.encodings.length - 1;
        bp.encodings[bIdx]!.maxBitrate = options.maxBitrate;
        bp.encodings[bIdx]!.maxFramerate = options.maxFramerate;
        bp.encodings[bIdx]!.priority = 'high';
        bp.encodings[bIdx]!.networkPriority = 'high';
        if (options.scaleResolutionDownBy !== undefined) {
          bp.encodings[bIdx]!.scaleResolutionDownBy = options.scaleResolutionDownBy;
        }
        (bp as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference =
          options.degradationPreference;
        await backupSender.setParameters(bp).catch(() => {});
      }
    }
    return true;
  } catch (err) {
    console.warn('[ScreenShare] Failed to apply overdrive:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Capture constraints — the one place that turns config into getDisplayMedia input
// ---------------------------------------------------------------------------

function buildCaptureConstraints(config: ScreenShareConfig, opts: ScreenShareBuildResult): DisplayMediaStreamOptions {
  const video: MediaTrackConstraints = {
    frameRate: { ideal: opts.capture.frameRate, max: opts.capture.frameRate },
  };
  // Native mode (or Windows Electron zero-scale GPU path): no resolution constraint on capturer
  if (!isWindowsElectronCapture() && opts.capture.width > 0 && opts.capture.height > 0) {
    video.width = { ideal: opts.capture.width, max: opts.capture.width };
    video.height = { ideal: opts.capture.height, max: opts.capture.height };
  }
  return {
    video,
    audio: config.shareAudio ? {
      // Request own-playback exclusion where supported; custom Electron picker needs 43.4+
      // @ts-ignore — restrictOwnAudio is not yet in all TS type definitions
      restrictOwnAudio: true,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    } : false,
  };
}

// ---------------------------------------------------------------------------
// Color processor wiring — zero-copy passthrough when color sliders are at 100%
// ---------------------------------------------------------------------------

export function createVoiceStoreColorSource(): {
  getColor: () => StreamColorSettings;
  subscribe: (listener: (color: StreamColorSettings) => void) => () => void;
} {
  return {
    getColor: () => useVoiceStore.getState().screenShareConfig.streamColor ?? DEFAULT_STREAM_COLOR,
    subscribe: (listener) =>
      useVoiceStore.subscribe((next, prev) => {
        if (next.screenShareConfig.streamColor !== prev.screenShareConfig.streamColor) {
          listener(next.screenShareConfig.streamColor ?? DEFAULT_STREAM_COLOR);
        }
      }),
  };
}

/**
 * Syncs a staged (unpublished) preview MediaStream between raw OS passthrough
 * and the OffscreenCanvas Worker color processor when the user adjusts color
 * sliders inside ScreenShareSetup.
 */
export function syncStagedStreamColorProcessor(stream: MediaStream): MediaStream {
  const outerVideo = stream.getVideoTracks()[0];
  if (!outerVideo) return stream;
  const rawVideo = getUnderlyingCaptureTrack(outerVideo);
  const hasProcessor = rawVideo != null && rawVideo !== outerVideo;
  const currentColor = useVoiceStore.getState().screenShareConfig.streamColor ?? DEFAULT_STREAM_COLOR;
  const needsProcessor = !isDefaultStreamColor(currentColor);

  if (needsProcessor && !hasProcessor) {
    return attachStreamColorProcessor(stream, createVoiceStoreColorSource());
  }
  if (!needsProcessor && hasProcessor) {
    return detachStreamColorProcessor(stream);
  }
  return stream;
}

/**
 * Attaches or detaches the LiveKit TrackProcessor on the active local screen-share
 * publication so default color settings bypass WebGL entirely (zero-copy hardware
 * capture → encoder), while non-default adjustments hot-swap via RTCRtpSender.replaceTrack.
 */
export async function syncPublishedScreenShareColorProcessor(room: Room): Promise<boolean> {
  const pub = room.localParticipant.getTrackPublication?.(Track.Source.ScreenShare)
    ?? room.localParticipant.getTrackPublications().find((p) => p.source === Track.Source.ScreenShare);
  const lkTrack = pub?.track as LocalVideoTrack | undefined;
  if (!lkTrack || typeof lkTrack.setProcessor !== 'function' || typeof lkTrack.stopProcessor !== 'function') {
    return false;
  }

  const currentColor = useVoiceStore.getState().screenShareConfig.streamColor ?? DEFAULT_STREAM_COLOR;
  const needsProcessor = !isDefaultStreamColor(currentColor);
  const hasProcessor = Boolean(lkTrack.getProcessor?.());

  if (needsProcessor && !hasProcessor) {
    await lkTrack.setProcessor(createScreenShareColorTrackProcessor(createVoiceStoreColorSource()), true);
    return true;
  }
  if (!needsProcessor && hasProcessor) {
    await lkTrack.stopProcessor();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stage — capture without publishing.
//
// Every screen share starts here, on every platform. Browsers open their native
// prompt; Electron's main process answers the request from the renderer's
// preselected source (see ScreenShareSetup). The returned stream is previewed
// in the setup screen and only reaches the room via publishScreenShare(), so
// cancelling the setup never sends a frame.
// ---------------------------------------------------------------------------

export function isScreenCaptureSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
}

/**
 * The user dismissed the picker rather than hitting a real failure. Both names
 * occur in the wild: Chromium raises NotAllowedError, Firefox and the Wayland
 * portal raise AbortError. Shared so a cancellation never also reports a fault.
 */
export function isCaptureCancellation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'NotAllowedError' || err.name === 'AbortError';
}

function assertBrowserScreenShareIsSdr(config: ScreenShareConfig): void {
  if (config.hdrEnabled) throw new DOMException(i18n.t('voice:streamSettings.hdrUnavailable'), 'NotSupportedError');
}

/** Must run inside a user gesture in browsers (getDisplayMedia requires transient activation). */
export async function stageScreenCapture(): Promise<MediaStream> {
  const config = useVoiceStore.getState().screenShareConfig;
  assertBrowserScreenShareIsSdr(config);
  void probeHardwareScreenShareCodecs(buildProbeTargetForConfig(config));
  const opts = buildScreenShareOptions(config);
  if (!isScreenCaptureSupported()) {
    throw new DOMException('getDisplayMedia is not available', 'NotSupportedError');
  }
  try {
    const rawStream = await navigator.mediaDevices.getDisplayMedia(buildCaptureConstraints(config, opts));
    const video = rawStream.getVideoTracks()[0];
    if (video) {
      await applyCaptureConstraintsToTrack(video, opts);
      video.contentHint = opts.contentHint;
    }
    const currentColor = useVoiceStore.getState().screenShareConfig.streamColor ?? DEFAULT_STREAM_COLOR;
    if (isDefaultStreamColor(currentColor)) {
      return rawStream;
    }
    return attachStreamColorProcessor(rawStream, createVoiceStoreColorSource());
  } catch (err) {
    // Loopback unsupported (Linux without pulse, macOS without Catap) makes
    // the whole getDisplayMedia call reject. No auto-retry: the picker
    // selection was consumed, retrying would re-prompt it.
    if (config.shareAudio && !isCaptureCancellation(err)) {
      useUIStore.getState().addToast(
        i18n.t('voice:screenPicker.audioCaptureFailed'),
        'warning',
        8000,
      );
    }
    throw err;
  }
}

/**
 * Re-apply the current config to a staged (unpublished) capture. Cheap: the
 * track is local only, so there is no SFU renegotiation. Lets the setup screen
 * reflect quality changes in the preview before anything is sent.
 */
export async function applyStagedCaptureConfig(stream: MediaStream): Promise<void> {
  const outerTrack = stream.getVideoTracks()[0];
  const track = getUnderlyingCaptureTrack(outerTrack);
  if (!outerTrack || !track || track.readyState !== 'live') return;
  const config = useVoiceStore.getState().screenShareConfig;
  assertBrowserScreenShareIsSdr(config);
  const opts = buildScreenShareOptions(config);
  const constraints = buildCaptureConstraints(config, opts).video;
  try {
    if (typeof constraints === 'object') await track.applyConstraints(constraints);
  } catch (err) {
    console.warn('[ScreenShare] Failed to apply staged constraints:', err);
  }
  track.contentHint = opts.contentHint;
  outerTrack.contentHint = opts.contentHint;
}

export function stopStagedCapture(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

// ---------------------------------------------------------------------------
// Publish — send a staged capture to the room as the local screen share
// ---------------------------------------------------------------------------

/** Codec confirmed by outbound WebRTC stats; null until stats expose it. */
let _publishedScreenShareCodec: ResolvedScreenShareCodec | 'vp8' | null = null;
/** Requested codec of the current publication, used only to decide whether republish is needed. */
let _requestedPublishedScreenShareCodec: ResolvedScreenShareCodec | null = null;

export function getPublishedScreenShareCodec(): ResolvedScreenShareCodec | 'vp8' | null {
  const nativeSdr = useNativeSdrStore.getState();
  if (nativeSdr.active && nativeSdr.codec) {
    return nativeSdr.codec === 'hevc' ? 'h265' : 'h264';
  }
  return _publishedScreenShareCodec;
}

export function getRequestedPublishedScreenShareCodec(): ResolvedScreenShareCodec | null {
  const nativeSdr = useNativeSdrStore.getState();
  if (nativeSdr.active && nativeSdr.requestedResolvedCodec) {
    return nativeSdr.requestedResolvedCodec;
  }
  return _requestedPublishedScreenShareCodec;
}

/** True while republishScreenShare() swaps publications; unpublish handlers must not treat it as a stop. */
let _republishing = false;

/** True while republishScreenShare() swaps publications. See handleScreenShareUnpublished. */
export function isScreenShareRepublishing(): boolean {
  return _republishing;
}

/**
 * True while stopScreenShare() is unpublishing. livekit-client emits
 * `LocalTrackUnpublished` synchronously inside `unpublishTrack`, so the
 * explicit stop path reaches handleScreenShareUnpublished mid-teardown; the
 * flag keeps that from broadcasting a second `voice_status` for the one stop.
 */
let _stopping = false;

export async function publishScreenShare(room: Room, stream: MediaStream): Promise<boolean> {
  // The WGC/NVENC publisher is still under acceptance in experiments/windows-hdr.
  // Never convert a restored HDR intent into an 8-bit browser publication.
  if (useVoiceStore.getState().screenShareConfig.hdrEnabled) {
    stopStagedCapture(stream);
    useUIStore.getState().addToast(i18n.t('voice:streamSettings.hdrUnavailable'), 'warning', 8000);
    return false;
  }

  // Unwrap any staged preview color wrapper so LiveKit owns the raw OS capture track;
  // if non-default color adjustments are active, syncPublishedScreenShareColorProcessor
  // attaches a hot-swappable LiveKit TrackProcessor right after publication.
  const cleanStream = detachStreamColorProcessor(stream);
  const config = ensureSupportedScreenShareCodec();
  if (config.codec === 'auto') {
    await probeHardwareScreenShareCodecs(buildProbeTargetForConfig(config));
  }
  const opts = buildScreenShareOptions(config);
  const videoTrack = cleanStream.getVideoTracks()[0];
  if (!videoTrack || videoTrack.readyState !== 'live') return false;
  const audioTrack = cleanStream.getAudioTracks().find((t) => t.readyState === 'live') ?? null;

  // Lock OS capture resolution & frameRate BEFORE LiveKit negotiates or attaches
  // the WebRTC video source adapter so Electron's capturer starts at target FPS.
  await applyCaptureConstraintsToTrack(videoTrack, opts);

  // Compute exact Native-mode bitrate from real track dimensions BEFORE negotiation
  // so 1080p/1440p native captures do not initially negotiate a 4K 20 Mbps ceiling.
  resolveNativeOverdrive(videoTrack, config, opts);

  // SDP overdrive must be installed before publishTrack negotiates the offer:
  // upgrades H.264 to High Profile 5.0 and sets x-google-start-bitrate / x-google-min-bitrate
  // on the screen-share m=video section so GCC never collapses to 300 kbps.
  activateHwOverdrive({
    codec: opts.publish.videoCodec,
    targetBitrateBps: opts.publish.videoEncoding.maxBitrate,
    trackId: videoTrack.id,
  });

  let videoPublished = false;
  try {
    videoTrack.contentHint = opts.contentHint;
    await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.ScreenShare,
      videoCodec: opts.publish.videoCodec,
      videoEncoding: opts.publish.videoEncoding,
      // LiveKit uses screenShareEncoding (not videoEncoding) for screen share tracks.
      // Without this, the default ScreenSharePresets.h1080fps15 caps at 15fps.
      screenShareEncoding: opts.publish.videoEncoding,
      degradationPreference: opts.overdrive.degradationPreference,
      simulcast: opts.publish.simulcast,
      ...(opts.publish.backupCodec ? {
        backupCodec: opts.publish.backupCodec,
        backupCodecPolicy: opts.publish.backupCodecPolicy,
      } : {}),
    });
    // livekit-client overwrites VP9 screen-share contentHint to 'motion'; restore explicit intent
    videoTrack.contentHint = opts.contentHint;
    videoPublished = true;

    if (audioTrack) {
      await room.localParticipant.publishTrack(audioTrack, {
        source: Track.Source.ScreenShareAudio,
        audioPreset: opts.publish.audioPreset,
        dtx: opts.publish.dtx,
        red: opts.publish.red,
        forceStereo: opts.publish.forceStereo,
      });
    }

    await syncPublishedScreenShareColorProcessor(room);
    getElectronAPI()?.setStreamingPowerMode?.(true);

    _requestedPublishedScreenShareCodec = opts.publish.videoCodec;
    _publishedScreenShareCodec = null;
    useVoiceStore.setState({ isScreenSharing: true, screenShareDynamicRange: 'sdr' });
    scheduleScreenShareOverdrive(room, { captureAlreadyApplied: true });
    scheduleEncoderDetection(room, opts.publish.videoCodec, videoTrack.id);
    return true;
  } catch (err) {
    console.error('[ScreenShare] Failed to publish screen share:', err);
    // A failure after the video went out would otherwise leave a dead
    // publication after its underlying staged track is stopped.
    if (videoPublished) {
      try {
        await room.localParticipant.unpublishTrack(videoTrack, false);
      } catch (unpublishErr) {
        console.error('[ScreenShare] Failed to roll back the video publication:', unpublishErr);
      }
    }
    if (config.shareAudio && err instanceof Error && err.name !== 'NotAllowedError') {
      useUIStore.getState().addToast(
        i18n.t('voice:streamSettings.systemAudioStartFailed'),
        'warning',
        8000,
      );
    }
    getElectronAPI()?.setStreamingPowerMode?.(false);
    stopStagedCapture(cleanStream);
    return false;
  } finally {
    // The global SDP hook is negotiation-scoped. Leaving it installed would
    // affect camera/microphone renegotiations later in the call.
    deactivateHwOverdrive();
  }
}

/**
 * Re-publish the live screen share with the current publish options. The
 * codec is baked into SDP negotiation, so a codec change needs a fresh
 * publication — but the MediaStreamTrack is reusable, so no re-capture and
 * no second picker prompt.
 */
export async function republishScreenShare(room: Room): Promise<void> {
  assertBrowserScreenShareIsSdr(useVoiceStore.getState().screenShareConfig);
  const videoPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const audioPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
  const publishedMediaTrack = videoPub?.track?.mediaStreamTrack;
  const videoTrack = getUnderlyingCaptureTrack(publishedMediaTrack) ?? publishedMediaTrack;
  if (!videoPub?.track || !videoTrack) return;
  const lkVideoTrack = videoPub.track as LocalVideoTrack;
  if (typeof lkVideoTrack.getProcessor === 'function' && lkVideoTrack.getProcessor()) {
    try {
      await lkVideoTrack.stopProcessor();
    } catch {
      // Non-fatal: unpublishTrack still tears down the publication cleanly.
    }
  }
  const audioTrack = audioPub?.track?.mediaStreamTrack ?? null;
  const stream = new MediaStream([videoTrack, ...(audioTrack ? [audioTrack] : [])]);

  _republishing = true;
  try {
    await room.localParticipant.unpublishTrack(videoPub.track, false);
    if (audioPub?.track) await room.localParticipant.unpublishTrack(audioPub.track, false);
  } finally {
    _republishing = false;
  }
  _publishedScreenShareCodec = null;
  _requestedPublishedScreenShareCodec = null;

  const ok = await publishScreenShare(room, stream);
  if (!ok) {
    deactivateHwOverdrive();
    getElectronAPI()?.setStreamingPowerMode?.(false);
    useVoiceStore.setState({ isScreenSharing: false, screenShareDynamicRange: 'sdr' });
    // The swap suppressed handleScreenShareUnpublished, and a video publish
    // that never landed emits no rollback unpublish either, so nothing else
    // will carry the stop to the clients outside the LiveKit room. Without
    // this their channel lists keep the sharing indicator up indefinitely
    // while the sharer's own UI says they stopped.
    broadcastVoiceStatus();
  }
}

// ---------------------------------------------------------------------------
// Shared screen-share sender scheduling
// ---------------------------------------------------------------------------

const OVERDRIVE_ATTEMPT_OFFSETS_MS = [0, 250, 750, 2000, 5000] as const;

/**
 * Apply the current screen-share capture settings once and sender parameters
 * as soon as a negotiated encoding is available. The final pass deliberately
 * remains at five seconds to reassert the ceiling after Chromium's bandwidth
 * estimate converges. Reconnect and track-restart paths use the same scheduler
 * because they can replace the sender and briefly expose placeholder encodings.
 */
export function scheduleScreenShareOverdrive(
  room: Room,
  options?: { captureAlreadyApplied?: boolean },
): void {
  const startedAt = Date.now();
  let attemptIndex = 0;
  let captureConfigured = options?.captureAlreadyApplied ?? false;

  const apply = async (): Promise<void> => {
    if (!useVoiceStore.getState().isScreenSharing) return;
    const freshOpts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);

    const screenPub = room.localParticipant.getTrackPublications()
      .find(p => p.source === Track.Source.ScreenShare);
    if (screenPub?.track?.mediaStreamTrack) {
      const publishedTrack = screenPub.track.mediaStreamTrack;
      const mediaTrack = getUnderlyingCaptureTrack(publishedTrack) ?? publishedTrack;
      if (!captureConfigured) {
        captureConfigured = true;
        await applyCaptureConstraintsToTrack(mediaTrack, freshOpts);
      }
      mediaTrack.contentHint = freshOpts.contentHint;
      publishedTrack.contentHint = freshOpts.contentHint;

      // Native dimensions can settle after negotiation/restart, so recompute
      // their ceiling on each bounded sender attempt without reapplying capture
      // constraints or restarting the source track.
      resolveNativeOverdrive(mediaTrack, useVoiceStore.getState().screenShareConfig, freshOpts);
      if (isWindowsElectronCapture()) {
        freshOpts.overdrive.scaleResolutionDownBy = computeEncoderScaleDown(
          mediaTrack.getSettings().height,
          freshOpts.capture.height,
        );
      }
    }
    const applied = await applyOverdrive(room, Track.Source.ScreenShare, freshOpts.overdrive);
    if (!useVoiceStore.getState().isScreenSharing) return;

    const lastIndex = OVERDRIVE_ATTEMPT_OFFSETS_MS.length - 1;
    if (attemptIndex >= lastIndex) return;

    // Once a real sender encoding accepts the values, skip intermediate
    // retries but keep the 5-second pass that reasserts the ceiling after
    // Chromium's screen-share bandwidth estimate has converged.
    attemptIndex = applied ? lastIndex : attemptIndex + 1;
    const targetOffset = OVERDRIVE_ATTEMPT_OFFSETS_MS[attemptIndex]!;
    const delay = Math.max(0, targetOffset - (Date.now() - startedAt));
    setTimeout(() => { void apply(); }, delay);
  };
  void apply();
}

// ---------------------------------------------------------------------------
// Negotiated codec and encoder detection — checks stats after stream starts
// ---------------------------------------------------------------------------

interface EncoderStatsEntry extends RTCStats {
  kind?: string;
  mediaType?: string;
  codecId?: string;
  mimeType?: string;
  bytesSent?: number;
  active?: boolean;
  encoderImplementation?: string;
}

function normalizeVideoCodec(value: string | undefined): ResolvedScreenShareCodec | 'vp8' | null {
  const normalized = value?.toLowerCase();
  if (normalized?.includes('vp9')) return 'vp9';
  if (normalized?.includes('h264')) return 'h264';
  if (normalized?.includes('h265') || normalized?.includes('hevc')) return 'h265';
  if (normalized?.includes('vp8')) return 'vp8';
  return null;
}

async function inspectPublishedEncoder(
  room: Room,
  requestedCodec: ResolvedScreenShareCodec,
  expectedRawTrackId: string,
): Promise<boolean> {
  if (!useVoiceStore.getState().isScreenSharing) return true;

  const pc = getPublisherPC(room);
  if (!pc) return false;
  const screenPub = room.localParticipant.getTrackPublications()
    .find(p => p.source === Track.Source.ScreenShare);
  if (!screenPub?.track) return false;
  const mediaTrack = getMediaStreamTrack(screenPub.track);
  const rawTrack = getUnderlyingCaptureTrack(mediaTrack) ?? mediaTrack;
  if (!mediaTrack || !rawTrack || rawTrack.id !== expectedRawTrackId) return true;
  const sender = pc.getSenders().find(
    (s) => s.track?.id === mediaTrack.id || s.track?.id === expectedRawTrackId,
  ) ?? (screenPub.track as { sender?: RTCRtpSender }).sender;
  if (!sender) return false;

  const candidateSenders: RTCRtpSender[] = [sender];
  const simulcastCodecs = (screenPub.track as {
    simulcastCodecs?: Map<string, { sender?: RTCRtpSender; mediaStreamTrack?: MediaStreamTrack }>;
  }).simulcastCodecs;
  if (simulcastCodecs) {
    for (const sc of simulcastCodecs.values()) {
      const bs = sc.sender ?? (sc.mediaStreamTrack ? pc.getSenders().find(s => s.track?.id === sc.mediaStreamTrack?.id) : undefined);
      if (bs && !candidateSenders.includes(bs)) candidateSenders.push(bs);
    }
  }

  const codecById = new Map<string, string>();
  const outbound: Array<{ codec: ResolvedScreenShareCodec | 'vp8'; bytesSent: number; encoderImpl: string | null }> = [];
  for (const cand of candidateSenders) {
    const stats = await cand.getStats();
    stats.forEach((report) => {
      const entry = report as EncoderStatsEntry;
      if (entry.type === 'codec' && entry.mimeType) codecById.set(entry.id, entry.mimeType);
    });
    stats.forEach((report) => {
      const entry = report as EncoderStatsEntry;
      if (entry.type !== 'outbound-rtp' || (entry.kind !== 'video' && entry.mediaType !== 'video')) return;
      if (entry.active === false) return;
      const codec = normalizeVideoCodec(entry.mimeType ?? (entry.codecId ? codecById.get(entry.codecId) : undefined));
      if (!codec) return;
      outbound.push({
        codec,
        bytesSent: entry.bytesSent ?? 0,
        encoderImpl: entry.encoderImplementation ?? null,
      });
    });
  }
  if (outbound.length === 0) return false;

  const sending = outbound.filter((entry) => entry.bytesSent > 0);
  // Prefer a confirmed, sending primary; only report the backup when the requested
  // codec is absent/inactive and VP8 is the stream actually carrying bytes.
  const selected = sending.find((entry) => entry.codec === requestedCodec)
    ?? (sending.length > 0
      ? sending.reduce((best, entry) => entry.bytesSent > best.bytesSent ? entry : best)
      : outbound.find((entry) => entry.codec === requestedCodec) ?? outbound[0]!);
  _publishedScreenShareCodec = selected.codec;

  // If viewer capability regression switched the active outbound stream (e.g. H.265 → H.264),
  // reassert overdrive on the regressed sender so full target FPS & gaming bitrate stay locked.
  if (selected.codec !== requestedCodec && selected.bytesSent > 0 && selected.codec === 'h264') {
    const currentConfig = useVoiceStore.getState().screenShareConfig;
    const regressedConfig: ScreenShareConfig = { ...currentConfig, codec: 'h264' };
    const regressedOpts = buildScreenShareOptions(regressedConfig);
    resolveNativeOverdrive(rawTrack, regressedConfig, regressedOpts);
    void applyOverdrive(room, Track.Source.ScreenShare, regressedOpts.overdrive);
  }

  const h264Implementations = outbound
    .filter((entry) => entry.codec === 'h264')
    .map((entry) => entry.encoderImpl)
    .filter((value): value is string => value != null);
  if (
    (requestedCodec === 'h264' || selected.codec === 'h264') &&
    selected.codec === 'h264' &&
    h264Implementations.some((value) => /openh264/i.test(value))
  ) {
    useUIStore.getState().addToast(
      i18n.t('voice:streamSettings.softwareH264Fallback'),
      'warning',
      8000,
    );
    return true;
  }

  if (
    selected.encoderImpl &&
    (selected.codec === 'vp9' || selected.codec === 'h265' || selected.codec === 'vp8') &&
    /libvpx|libaom|ffmpeg|openh264/i.test(selected.encoderImpl)
  ) {
    useUIStore.getState().addToast(
      i18n.t('voice:streamSettings.softwareEncoderFallback', {
        codec: selected.codec.toUpperCase(),
        encoder: selected.encoderImpl,
      }),
      'warning',
      8000,
    );
    return true;
  }

  // Chromium may expose the codec before encoderImplementation. Retry briefly
  // when encoderImplementation is still absent so software-fallback detection works.
  if (requestedCodec === 'h264' && selected.codec === 'h264') {
    return h264Implementations.length > 0;
  }
  return selected.encoderImpl !== null;
}

const ENCODER_DETECTION_OFFSETS_MS = [0, 1000, 4000, 8000] as const;

function scheduleEncoderDetection(
  room: Room,
  requestedCodec: ResolvedScreenShareCodec,
  expectedRawTrackId: string,
): void {
  const startedAt = Date.now();
  let attemptIndex = 0;
  const inspect = async (): Promise<void> => {
    try {
      if (await inspectPublishedEncoder(room, requestedCodec, expectedRawTrackId)) return;
    } catch {
      // Non-critical — the connection inspector still exposes available stats.
    }
    attemptIndex += 1;
    if (attemptIndex >= ENCODER_DETECTION_OFFSETS_MS.length) return;
    const targetOffset = ENCODER_DETECTION_OFFSETS_MS[attemptIndex]!;
    const delay = Math.max(0, targetOffset - (Date.now() - startedAt));
    setTimeout(() => { void inspect(); }, delay);
  };
  void inspect();
}

// ---------------------------------------------------------------------------
// Stop screen sharing
// ---------------------------------------------------------------------------

export async function stopScreenShare(room: Room): Promise<void> {
  if (useNativeSdrStore.getState().active) {
    await useNativeSdrStore.getState().stop(room);
    return;
  }
  if (useNativeHdrStore.getState().publication || useVoiceStore.getState().screenShareDynamicRange === 'hdr') {
    getElectronAPI()?.setStreamingPowerMode?.(false);
    await useNativeHdrStore.getState().stop('publisher');
    return;
  }
  _stopping = true;
  try {
    for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
      // Per publication, not per loop: a throw on the video track used to abort
      // the loop, leaving the screen-share audio published with nothing left in
      // the UI able to stop it — isScreenSharing is already false by then, so
      // every stop path is closed and remote peers keep hearing the desktop.
      try {
        const pub = room.localParticipant.getTrackPublication(source);
        if (source === Track.Source.ScreenShare && pub?.track) {
          const lkVideoTrack = pub.track as LocalVideoTrack;
          if (typeof lkVideoTrack.getProcessor === 'function' && lkVideoTrack.getProcessor()) {
            await lkVideoTrack.stopProcessor().catch(() => {});
          }
        }
        if (pub?.track) await room.localParticipant.unpublishTrack(pub.track, true);
      } catch (err) {
        console.error(`[ScreenShare] Failed to unpublish ${source}:`, err);
      }
    }
  } finally {
    _stopping = false;
  }
  deactivateHwOverdrive();
  getElectronAPI()?.setStreamingPowerMode?.(false);
  _publishedScreenShareCodec = null;
  _requestedPublishedScreenShareCodec = null;
  useVoiceStore.setState({ isScreenSharing: false, screenShareDynamicRange: 'sdr' });
  // `voice_status` is what carries isScreenSharing to people who are not in the
  // LiveKit room (channel lists, join sheets). Every stop path funnels through
  // here or through handleScreenShareUnpublished, so both must broadcast.
  broadcastVoiceStatus();
}

// ---------------------------------------------------------------------------
// Change screen share source — stop, then reopen the setup screen
// ---------------------------------------------------------------------------

export async function changeScreenShare(room: Room): Promise<void> {
  await stopScreenShare(room);
  openScreenShareSetup();
}

// ---------------------------------------------------------------------------
// OS-level "Stop sharing" handler
// ---------------------------------------------------------------------------

export function handleScreenShareUnpublished(): void {
  if (_republishing) return;
  // The explicit stop path unpublishes synchronously, so this handler runs from
  // inside stopScreenShare(), which clears the same state and broadcasts once
  // its publications are gone. Returning here keeps a single stop to a single
  // `voice_status` fan-out instead of two.
  if (_stopping) return;
  deactivateHwOverdrive();
  getElectronAPI()?.setStreamingPowerMode?.(false);
  _publishedScreenShareCodec = null;
  _requestedPublishedScreenShareCodec = null;
  useVoiceStore.setState({ isScreenSharing: false, screenShareDynamicRange: 'sdr' });
  // `voice_status` is what carries isScreenSharing to people who are not in the
  // LiveKit room (channel lists, join sheets). Every stop path funnels through
  // here or through handleScreenShareUnpublished, so both must broadcast.
  broadcastVoiceStatus();
}
