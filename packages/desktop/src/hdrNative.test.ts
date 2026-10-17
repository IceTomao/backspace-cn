import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { assertHdrBitstream, hdrGpuArgs, HdrNativeRuntime, readHdrPrefix, validateHdrVideo } from './hdrNative';

const video = { width: 3840, height: 2160, fps: 60, bitrateKbps: 20000, shareAudio: false };
const hdr = { codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le',
  color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', color_range: 'tv', width: 3840, height: 2160 };

describe('native HDR publication guards', () => {
  it('requires actual Main10/PQ/BT.2020 bitstream metadata, dimensions and one video', () => {
    expect(() => assertHdrBitstream({ streams: [hdr] }, video)).not.toThrow();
    for (const patch of [{ pix_fmt: 'yuv420p' }, { color_transfer: 'bt709' }, { profile: 'Main' }, { width: 1920 }]) {
      expect(() => assertHdrBitstream({ streams: [{ ...hdr, ...patch }] }, video)).toThrow();
    }
    expect(() => assertHdrBitstream({ streams: [hdr, hdr] })).toThrow();
  });
  it('selects the exact native capture monitor without pixel pipes or SDR encoder arguments', () => {
    const args = hdrGpuArgs(video, '65537');
    expect(args).toEqual(['--width', '3840', '--height', '2160', '--fps', '60', '--bitrate-kbps', '20000', '--monitor', '65537', '--watch-parent']);
    for (const monitor of ['0', '-1', '1:window_title=other', '18446744073709551616']) expect(() => hdrGpuArgs(video, monitor)).toThrow();
    expect(hdrGpuArgs(video)).toContain('--synthetic');
    expect(() => validateHdrVideo({ ...video, width: 3839 })).toThrow();
    expect(() => validateHdrVideo({ ...video, shareAudio: true })).not.toThrow();
  });
  it('preserves a fragmented Annex B prefix without losing bytes at a pipe boundary', async () => {
    const input = new PassThrough();
    const result = readHdrPrefix(input);
    const first = Buffer.from([0, 0, 0, 1, 70, 1, 16, 0, 0, 1, 66, 1, 128, 0]);
    const second = Buffer.from([0, 0, 1, 70, 1, 16, 0, 0, 1, 2, 1, 128]);
    input.write(first);
    input.write(second);
    expect(await result).toEqual(Buffer.concat([first, second]));
    expect(input.isPaused()).toBe(true);
    input.destroy();
  });
  it('rejects an ended encoder and missing acceptance without launching capture', async () => {
    const input = new PassThrough();
    const result = readHdrPrefix(input);
    input.end(Buffer.from([0, 0, 1, 70, 1]));
    await expect(result).rejects.toThrow('complete picture');
    const runtime = new HdrNativeRuntime('/missing-hdr-runtime', vi.fn());
    expect(await runtime.capabilities()).toMatchObject({ available: false, displays: [] });
    await expect(runtime.startPublisher('hdr:screen', video, { url: 'wss://voice.example', token: 'private', identity: 'helper' })).rejects.toThrow('acceptance');
    runtime.dispose();
  });
});
