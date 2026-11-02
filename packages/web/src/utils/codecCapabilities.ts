import { supportsH265 } from 'livekit-client';

export type ResolvedScreenShareCodec = 'h264' | 'vp9' | 'h265';
export type ScreenShareCodecPreference = 'auto' | ResolvedScreenShareCodec;

export interface CodecHardwareSupport {
  supported: boolean;
  powerEfficient: boolean;
}

export interface ProbedCodecCapabilities {
  h265: CodecHardwareSupport;
  h264: CodecHardwareSupport;
  vp9: CodecHardwareSupport;
}

const H265_MIME_CANDIDATES = ['video/H265', 'video/hevc'] as const;
const H264_MIME_CANDIDATES = [
  'video/H264; profile-level-id=4d0032',
  'video/H264; profile-level-id=42e01f',
  'video/H264',
] as const;
const VP9_MIME_CANDIDATES = ['video/VP9; profile-id=0', 'video/VP9'] as const;

let cachedCapabilities: ProbedCodecCapabilities | null = null;
let inFlightProbe: Promise<ProbedCodecCapabilities> | null = null;
const listeners = new Set<() => void>();

export function isH265WebRtcSupported(): boolean {
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
    return false;
  }
  try {
    return supportsH265();
  } catch {
    return false;
  }
}

function getRtpVideoCodecs(): RTCRtpCodec[] | null {
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
    return null;
  }
  try {
    const caps = RTCRtpSender.getCapabilities('video');
    return caps?.codecs ?? null;
  } catch {
    return null;
  }
}

function hasRtpSenderCodec(codecs: RTCRtpCodec[] | null, codecSubstring: string): boolean {
  if (!codecs) return false;
  const needle = codecSubstring.toLowerCase();
  return codecs.some((c) => c.mimeType?.toLowerCase().includes(needle));
}

async function probeMimeCandidates(
  candidates: readonly string[],
  rtpSupported: boolean,
): Promise<CodecHardwareSupport> {
  if (!rtpSupported) {
    return { supported: false, powerEfficient: false };
  }
  const mediaCaps = typeof navigator !== 'undefined' ? navigator.mediaCapabilities : undefined;
  if (!mediaCaps || typeof mediaCaps.encodingInfo !== 'function') {
    return { supported: true, powerEfficient: false };
  }

  let anySupported = false;
  for (const contentType of candidates) {
    try {
      const info = await mediaCaps.encodingInfo({
        type: 'webrtc',
        video: {
          contentType,
          width: 1920,
          height: 1080,
          bitrate: 8_000_000,
          framerate: 60,
        },
      });
      if (info.supported) {
        anySupported = true;
        if (info.powerEfficient) {
          return { supported: true, powerEfficient: true };
        }
      }
    } catch {
      // Try next MIME candidate
    }
  }

  return {
    supported: anySupported || rtpSupported,
    powerEfficient: false,
  };
}

/**
 * Asynchronously probes WebRTC hardware encoder (`powerEfficient`) support via
 * `navigator.mediaCapabilities.encodingInfo`, caching the result for synchronous reads.
 */
export function probeHardwareScreenShareCodecs(): Promise<ProbedCodecCapabilities> {
  if (cachedCapabilities) return Promise.resolve(cachedCapabilities);
  if (inFlightProbe) return inFlightProbe;

  const previousResolved = computeAutoScreenShareCodec();

  inFlightProbe = (async (): Promise<ProbedCodecCapabilities> => {
    const rtpCodecs = getRtpVideoCodecs();
    const h265Rtp = isH265WebRtcSupported();
    const h264Rtp = rtpCodecs ? hasRtpSenderCodec(rtpCodecs, 'h264') : false;
    const vp9Rtp = rtpCodecs ? hasRtpSenderCodec(rtpCodecs, 'vp9') : true;

    const [h265, h264, vp9] = await Promise.all([
      probeMimeCandidates(H265_MIME_CANDIDATES, h265Rtp),
      probeMimeCandidates(H264_MIME_CANDIDATES, h264Rtp),
      probeMimeCandidates(VP9_MIME_CANDIDATES, vp9Rtp),
    ]);

    const result: ProbedCodecCapabilities = { h265, h264, vp9 };
    cachedCapabilities = result;
    inFlightProbe = null;

    if (computeAutoScreenShareCodec() !== previousResolved) {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // Ignore subscriber errors
        }
      }
    }
    return result;
  })();

  return inFlightProbe;
}

export function getProbedCodecCapabilities(): ProbedCodecCapabilities | null {
  return cachedCapabilities;
}

export function subscribeCodecCapabilities(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function computeAutoScreenShareCodec(): ResolvedScreenShareCodec {
  const rtpCodecs = getRtpVideoCodecs();
  const h265Available = isH265WebRtcSupported();
  const h264Available = hasRtpSenderCodec(rtpCodecs, 'h264');

  if (!cachedCapabilities) {
    if (h265Available) return 'h265';
    if (h264Available) return 'h264';
    return 'vp9';
  }

  if (h265Available && cachedCapabilities.h265.supported && cachedCapabilities.h265.powerEfficient) {
    return 'h265';
  }
  if (cachedCapabilities.h264.supported && cachedCapabilities.h264.powerEfficient) {
    return 'h264';
  }
  if (cachedCapabilities.vp9.supported && cachedCapabilities.vp9.powerEfficient) {
    return 'vp9';
  }
  if (cachedCapabilities.h264.supported) {
    return 'h264';
  }
  if (h265Available && cachedCapabilities.h265.supported) {
    return 'h265';
  }
  return 'vp9';
}

/**
 * Select the optimal concrete WebRTC codec when user preference is `'auto'`:
 *   1. Hardware-accelerated (`powerEfficient`) H.265
 *   2. Hardware-accelerated (`powerEfficient`) H.264
 *   3. Hardware-accelerated (`powerEfficient`) VP9
 *   4. Supported H.264 (broadest hardware/OS fast-path & lowest CPU decode cost)
 *   5. Supported H.265
 *   6. Supported VP9
 */
export function resolveAutoScreenShareCodec(): ResolvedScreenShareCodec {
  if (!cachedCapabilities) {
    void probeHardwareScreenShareCodecs();
  }
  return computeAutoScreenShareCodec();
}

export function resolveEffectiveScreenShareCodec(
  preference: ScreenShareCodecPreference,
  hdrEnabled = false,
): ResolvedScreenShareCodec {
  if (hdrEnabled) return 'h265';
  if (preference === 'auto') return resolveAutoScreenShareCodec();
  return preference;
}

export function resetCodecCapabilityCacheForTests(): void {
  cachedCapabilities = null;
  inFlightProbe = null;
  listeners.clear();
}
