import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isH265WebRtcSupported,
  probeHardwareScreenShareCodecs,
  resetCodecCapabilityCacheForTests,
  resolveAutoScreenShareCodec,
  resolveEffectiveScreenShareCodec,
  subscribeCodecCapabilities,
} from './codecCapabilities';

describe('codecCapabilities', () => {
  beforeEach(() => {
    resetCodecCapabilityCacheForTests();
  });

  afterEach(() => {
    resetCodecCapabilityCacheForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prefers hardware-accelerated H.265 when WebRTC sender and MediaCapabilities report powerEfficient HEVC', async () => {
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: vi.fn(() => ({
        codecs: [{ mimeType: 'video/H265' }, { mimeType: 'video/H264' }, { mimeType: 'video/VP9' }],
      })),
    });
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        encodingInfo: vi.fn(async ({ video }: { video: { contentType: string } }) => ({
          supported: true,
          smooth: true,
          powerEfficient:
            video.contentType.toLowerCase().includes('h265') ||
            video.contentType.toLowerCase().includes('hevc') ||
            video.contentType.toLowerCase().includes('h264'),
        })),
      },
    });

    const snapshot = await probeHardwareScreenShareCodecs();

    expect(isH265WebRtcSupported()).toBe(true);
    expect(snapshot.h265.powerEfficient).toBe(true);
    expect(snapshot.h264.powerEfficient).toBe(true);
    expect(snapshot.vp9.powerEfficient).toBe(false);
    expect(resolveAutoScreenShareCodec()).toBe('h265');
    expect(resolveEffectiveScreenShareCodec('auto', false)).toBe('h265');
  });

  it('notifies subscribers when async probe shifts auto from H.265 RTP candidate down to hardware H.264', async () => {
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: vi.fn(() => ({
        codecs: [{ mimeType: 'video/H265' }, { mimeType: 'video/H264' }, { mimeType: 'video/VP9' }],
      })),
    });
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        encodingInfo: vi.fn(async ({ video }: { video: { contentType: string } }) => ({
          supported: true,
          smooth: video.contentType.toLowerCase().includes('h264'),
          powerEfficient: video.contentType.toLowerCase().includes('h264'),
        })),
      },
    });

    const listener = vi.fn();
    const unsub = subscribeCodecCapabilities(listener);
    await probeHardwareScreenShareCodecs();
    unsub();

    expect(resolveAutoScreenShareCodec()).toBe('h264');
    expect(resolveEffectiveScreenShareCodec('auto', false)).toBe('h264');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('falls back to hardware VP9 when only VP9 is supported, and to VP9 when WebRTC sender capabilities are absent', async () => {
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: vi.fn(() => ({
        codecs: [{ mimeType: 'video/VP9' }],
      })),
    });
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        encodingInfo: vi.fn(async ({ video }: { video: { contentType: string } }) => ({
          supported: video.contentType.toLowerCase().includes('vp9'),
          smooth: video.contentType.toLowerCase().includes('vp9'),
          powerEfficient: video.contentType.toLowerCase().includes('vp9'),
        })),
      },
    });

    await probeHardwareScreenShareCodecs();
    expect(resolveAutoScreenShareCodec()).toBe('vp9');

    resetCodecCapabilityCacheForTests();
    vi.stubGlobal('RTCRtpSender', undefined);
    vi.stubGlobal('navigator', {});
    await probeHardwareScreenShareCodecs();
    expect(resolveAutoScreenShareCodec()).toBe('vp9');
    expect(resolveEffectiveScreenShareCodec('auto', true)).toBe('h265');
  });
});
