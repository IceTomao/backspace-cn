import { describe, expect, it } from 'vitest';
import {
  decodePcmChunkToStereoOrMonoFloat32,
  hasAnnexBStartCode,
  matchSdrDisplay,
  resolveSdrOutputDimensions,
  sdrGpuArgs,
  sdrKeyFramePacket,
  validateSdrVideo,
  type SdrDisplay,
} from './sdrNative';
import { DEFAULT_STREAM_COLOR } from './hdrColor';

describe('native SDR zero-copy runtime helpers', () => {
  it('computes even aspect-preserving output dimensions without upscaling smaller displays', () => {
    // 2K display -> 1080p
    expect(resolveSdrOutputDimensions({ width: 2560, height: 1440 }, { maxHeight: 1080 })).toEqual({ width: 1920, height: 1080 });
    // 2K display -> Native
    expect(resolveSdrOutputDimensions({ width: 2560, height: 1440 }, { maxHeight: 'native' })).toEqual({ width: 2560, height: 1440 });
    // 1080p display -> 1440p requested (never upscales)
    expect(resolveSdrOutputDimensions({ width: 1920, height: 1080 }, { maxHeight: 1440 })).toEqual({ width: 1920, height: 1080 });
    // 21:9 ultrawide 3440x1440 -> 1080p preserves aspect without black bars
    expect(resolveSdrOutputDimensions({ width: 3440, height: 1440 }, { maxHeight: 1080 })).toEqual({ width: 2580, height: 1080 });
  });

  it('matches physical bounds across multi-monitor DPI-scaled setups', () => {
    const displays: SdrDisplay[] = [
      { gdiName: '\\\\.\\DISPLAY1', name: 'Primary 2K', hmonitor: '65537', left: 0, top: 0, isPrimary: true, width: 2560, height: 1440 },
      { gdiName: '\\\\.\\DISPLAY2', name: 'Secondary 1080p', hmonitor: '65539', left: 2560, top: 180, isPrimary: false, width: 1920, height: 1080 },
    ];
    expect(matchSdrDisplay(displays, {
      sourceId: 'screen:1:0',
      physicalBounds: { x: 2560, y: 180, width: 1920, height: 1080 },
      dipBounds: { x: 1707, y: 120, width: 1920, height: 1080 },
      scaleFactor: 1,
      isPrimary: false,
      screenIndex: 1,
      totalScreens: 2,
    })?.hmonitor).toBe('65539');
  });

  it('builds validated CLI arguments for HEVC and H.264 SDR capture', () => {
    expect(sdrGpuArgs({
      width: 2560,
      height: 1440,
      fps: 120,
      bitrateKbps: 25000,
      codec: 'hevc',
      shareAudio: true,
      color: { exposureEv: 0, streamColor: { ...DEFAULT_STREAM_COLOR, digitalVibrance: 70 } },
    }, '65537')).toEqual([
      '--sdr', '--codec', 'hevc', '--width', '2560', '--height', '1440', '--fps', '120',
      '--bitrate-kbps', '25000', '--exposure-tenths', '0', '--vibrance', '70', '--monitor', '65537', '--watch-parent',
    ]);
    expect(() => validateSdrVideo({ width: 1920, height: 1080, fps: 60, bitrateKbps: 10000, codec: 'vp9' as any, shareAudio: false })).toThrow();
  });

  it('decodes WASAPI loopback PCM and downmixes surround channels cleanly', () => {
    const buf = Buffer.alloc(6 * 4 * 2); // 2 frames, 6 channels (5.1), f32le
    buf.writeFloatLE(0.5, 0);
    buf.writeFloatLE(-0.25, 4);
    buf.writeFloatLE(-0.75, 24);
    buf.writeFloatLE(0.125, 28);
    const { pcm, outChannels } = decodePcmChunkToStereoOrMonoFloat32(buf, 0, 2, 6, 'f32le');
    expect(outChannels).toBe(2);
    expect(Array.from(pcm)).toEqual([0.5, -0.25, -0.75, 0.125]);
    expect(hasAnnexBStartCode(Buffer.from([0, 0, 0, 1, 0x67, 0x64]))).toBe(true);
    expect(sdrKeyFramePacket().subarray(0, 4).toString('ascii')).toBe('IDR1');
    expect(sdrKeyFramePacket().length).toBe(40);
  });
});
