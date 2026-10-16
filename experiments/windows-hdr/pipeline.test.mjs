import test from 'node:test';
import assert from 'node:assert/strict';
import { captureArgs, captureFramesArgs, rawHdrEncodeArgs, requireHdrDisplay, encodeArgs, verifyHdrStream, pqFromNits, syntheticFrame, verifyHighlightPatches, validateOptions } from './pipeline.mjs';

const display = { gdiName: '\\\\.\\DISPLAY1', hmonitor: '65537', hdrActive: true };
test('rejects missing, WCG-only, disabled and ambiguous display state', () => {
  for (const value of [false, null, undefined]) {
    assert.throws(() => requireHdrDisplay({ schemaVersion: 2, displays: [{ ...display, hdrActive: value, advancedColorEnabled: true }] }, display.gdiName));
  }
  assert.throws(() => requireHdrDisplay({ schemaVersion: 2, displays: [display, display] }, display.gdiName));
  assert.equal(requireHdrDisplay({ schemaVersion: 2, displays: [display] }, display.gdiName).hmonitor, '65537');
});
test('single HDR video encoder, float capture, and no fallback outputs', () => {
  const args = captureArgs(display, { width: 3840, height: 2160 }, 'capture.mkv');
  assert.equal(args.filter(a => a === '-c:v').length, 1);
  assert.equal(args.filter(a => a === '-map').length, 1);
  assert.equal(args.at(-1), 'capture.mkv');
  assert.ok(args.some(a => a.includes('output_fmt=rgbaf16')));
  assert.ok(args.some(a => a.includes('npl=80')));
  assert.equal(args[args.indexOf('-profile:v') + 1], 'main10');
  assert.doesNotMatch(args.join(' '), /vp8|libx264|tonemap|bgra|split=|tee|yuv420p(?:[^1]|$)/);
  assert.throws(() => captureArgs({ ...display, hdrActive: null }, {}, 'x'));
});
test('untrusted or unbounded capture parameters fail before spawning native code', () => {
  for (const options of [{ fps: 0 }, { fps: NaN }, { width: 1921 }, { seconds: 3600 }, { bitrateKbps: '1000;cmd' }])
    assert.throws(() => validateOptions(options));
  assert.throws(() => captureArgs({ ...display, hmonitor: '1:window_title=secret' }, {}, 'x'));
  assert.equal(encodeArgs({})[3], '-sn');
});
test('split runtime uses a local float pipe and exactly one compressed video encoder', () => {
  const source = captureFramesArgs(display, {}), encoder = rawHdrEncodeArgs({}, 'hdr.mkv');
  assert.equal(source.at(-1), 'pipe:1');
  assert.ok(source.includes('hwdownload,format=rgbaf16le,format=gbrpf32le'));
  assert.ok(encoder.includes('gbrpf32le'));
  assert.equal([...source, ...encoder].filter(value => value === 'hevc_nvenc').length, 1);
  assert.doesNotMatch([...source, ...encoder].join(' '), /vp8|bgra|libx264|tonemap|tee|udp:|rtmp:/);
});
const hdr = { codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', color_range: 'tv', width: 1920, height: 1080 };
test('checks elementary stream depth and color, rejecting mere HEVC support or container tags', () => {
  assert.equal(verifyHdrStream({ streams: [hdr] }).profile, 'Main 10');
  for (const patch of [{ profile: 'Main' }, { pix_fmt: 'yuv420p' }, { color_transfer: undefined }, { color_primaries: 'bt709' }])
    assert.throws(() => verifyHdrStream({ streams: [{ ...hdr, ...patch }] }));
  assert.throws(() => verifyHdrStream({ streams: [hdr, hdr] }));
  assert.throws(() => verifyHdrStream({ streams: [hdr, { codec_type: 'audio' }] }));
  const expected = { width: 1920, height: 1080, fps: 60, seconds: 10 };
  assert.doesNotThrow(() => verifyHdrStream({ streams: [{ ...hdr, nb_read_packets: '600', r_frame_rate: '60/1' }] }, expected));
  assert.throws(() => verifyHdrStream({ streams: [{ ...hdr, nb_read_packets: '300', r_frame_rate: '60/1' }] }, expected));
  assert.throws(() => verifyHdrStream({ streams: [{ ...hdr, nb_read_packets: '600', r_frame_rate: '30/1' }] }, expected));
});
test('HDR reference pattern retains values above SDR white', () => {
  assert.ok(Math.abs(pqFromNits(100) - 0.508078) < 0.000001);
  assert.ok(Math.abs(pqFromNits(1000) - 0.751827) < 0.000001);
  const frame = syntheticFrame(256, 128);
  assert.equal(frame.readFloatLE(224 * 4), 12.5);
  const decoded = Buffer.alloc(256 * 128 * 2);
  const levels = [64, 490, 572, 723]; // Independent ST2084 limited-range reference.
  for (let x = 0; x < 256; x++) decoded.writeUInt16LE(levels[Math.floor(x / 64)], (64 * 256 + x) * 2);
  assert.equal(verifyHighlightPatches(decoded, 256, 128).length, 4);
  decoded.writeUInt16LE(490, (64 * 256 + 224) * 2);
  assert.throws(() => verifyHighlightPatches(decoded, 256, 128), /1000 nits/);
});
