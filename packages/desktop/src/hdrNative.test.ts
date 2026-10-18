import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import { assertHdrBitstream, hdrGpuArgs, HdrNativeRuntime, readHdrPrefix, validateHdrVideo } from './hdrNative';

const video = { width: 3840, height: 2160, fps: 60, bitrateKbps: 20000, shareAudio: false };
const hdr = { codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le',
  color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', color_range: 'tv', width: 3840, height: 2160 };

describe('native HDR publication guards', () => {
  it('allows explicit experimental testing but never starts an encoder for ordinary settings detection', async () => {
    const runtime = new HdrNativeRuntime('/test-hdr-runtime', vi.fn());
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ protocol: 1, releaseAccepted: false, experimentalAllowed: true }));
    const stat = vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as any);
    vi.spyOn(runtime as any, 'displays').mockResolvedValue([{ gdiName: 'test', name: 'test', hdrActive: true, width: 3840, height: 2160 }]);
    const encode = vi.spyOn(runtime as any, 'canEncode').mockResolvedValue(false);
    try {
      expect(await runtime.capabilities()).toMatchObject({ publisherAvailable: true, experimental: true, colorControl: 1 });
      expect(encode).not.toHaveBeenCalled();
      expect(await runtime.capabilities(true)).toMatchObject({ publisherAvailable: false, reason: 'encoder_unavailable' });
      expect(encode).toHaveBeenCalledTimes(1);
      read.mockReturnValue(JSON.stringify({ protocol: 1, releaseAccepted: false }));
      expect(await runtime.capabilities()).toMatchObject({ available: false, reason: 'validation_pending' });
    } finally { read.mockRestore(); stat.mockRestore(); runtime.dispose(); }
  });
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
    expect(hdrGpuArgs({ ...video, color: { exposureEv: -1.5, brightness: 20 } }, '65537')).toEqual([
      '--width', '3840', '--height', '2160', '--fps', '60', '--bitrate-kbps', '20000',
      '--exposure-tenths', '-15', '--brightness', '20', '--monitor', '65537', '--watch-parent',
    ]);
    expect(() => hdrGpuArgs({ ...video, color: { exposureEv: NaN, brightness: 0 } })).toThrow();
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
