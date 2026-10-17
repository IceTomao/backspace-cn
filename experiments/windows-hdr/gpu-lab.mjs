// Real D3D11 shader + NVENC tests. Synthetic pixels only; no desktop capture,
// HDR output, network upload or release acceptance is performed here.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { verifyHdrStream, verifyHighlightPatches, validateOptions, SCRGB_TO_PQ } from './pipeline.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, '../..');
const { values } = parseArgs({ options: {
  width: { type: 'string', default: '3840' }, height: { type: 'string', default: '2160' },
  fps: { type: 'string', default: '60' }, seconds: { type: 'string', default: '10' },
  bitrate: { type: 'string', default: '32000' }, output: { type: 'string' },
  native: { type: 'string', default: path.join(repo, 'packages/desktop/hdr-runtime/HdrGpu.exe') },
  ffmpeg: { type: 'string', default: path.join(directory, '.artifacts/runtime/ffmpeg-8.0.1-full_build-shared/bin/ffmpeg.exe') },
  ffprobe: { type: 'string', default: path.join(directory, '.artifacts/runtime/ffmpeg-8.0.1-full_build-shared/bin/ffprobe.exe') },
} });
const options = validateOptions({ width: Number(values.width), height: Number(values.height), fps: Number(values.fps),
  seconds: Number(values.seconds), bitrateKbps: Number(values.bitrate) });
const output = values.output ? path.resolve(values.output) : path.join(directory, `.artifacts/gpu-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
function ffmpeg(args, extra = {}) {
  return execFileSync(values.ffmpeg, ['-v', 'error', '-nostdin', ...args], { windowsHide: true, timeout: 30000,
    maxBuffer: options.width * options.height * 4, ...extra });
}
async function native(name, width, height, frames, pattern, realtime = false, sourceSize) {
  const file = path.join(output, `${name}.hevc`);
  const args = ['--synthetic', '--width', String(width), '--height', String(height), '--fps', String(options.fps),
    '--bitrate-kbps', String(options.bitrateKbps), '--frames', String(frames), '--pattern', String(pattern), ...(realtime ? ['--realtime'] : [])];
  if (sourceSize) args.push('--source-width', String(sourceSize[0]), '--source-height', String(sourceSize[1]));
  const started = performance.now();
  const child = spawn(values.native, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stream = createWriteStream(file); let diagnostics = '', bytes = 0;
  child.stdout.pipe(stream);
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 512 * 1024 * 1024) child.kill(); });
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-65536); });
  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('GPU encoder timed out')); }, 90000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Native GPU encoder failed (${code}): ${diagnostics}`)); });
  });
  stream.once('error', () => child.kill());
  const finished = new Promise((resolve, reject) => { stream.once('finish', resolve); stream.once('error', reject); });
  await Promise.all([closed, finished]);
  const wallSeconds = (performance.now() - started) / 1000;
  const metrics = diagnostics.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    .find(event => event.type === 'gpu-complete');
  if (!metrics || metrics.frames !== frames || metrics.videoEncoders !== 1 || metrics.pixelReadback !== false) throw new Error('Invalid GPU pipeline report');
  const probe = JSON.parse(execFileSync(values.ffprobe, ['-v', 'error', '-count_packets', '-show_streams', '-of', 'json', file], { windowsHide: true }).toString());
  const video = verifyHdrStream(probe, { width, height, fps: options.fps });
  if (video.chroma_location !== 'center') throw new Error('GPU 2x2 chroma sampling location was not signaled');
  if (Number(video.nb_read_packets) !== frames) throw new Error(`GPU output lost frames: ${video.nb_read_packets}/${frames}`);
  return { file, metrics, wallSeconds, totalFps: frames / wallSeconds, actualFileMbps: bytes * 8 / (frames / options.fps) / 1e6 };
}
const decode = file => ffmpeg(['-i', file, '-frames:v', '1', '-pix_fmt', 'yuv420p10le', '-f', 'rawvideo', 'pipe:1']);
const grey = await native('grey', 256, 128, 4, 0);
const highlights = verifyHighlightPatches(decode(grey.file), 256, 128);

// Independent zimg reference, including RGB colors and a negative scRGB
// component. This catches wrong primaries, pre-PQ clipping and Cb/Cr swaps.
const colors = [[4, 0, 0], [0, 4, 0], [0, 0, 4], [-0.1, 2.5, 12.5]];
const width = 256, height = 128, frame = Buffer.alloc(width * height * 12);
for (let plane = 0; plane < 3; plane++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  frame.writeFloatLE(colors[Math.floor(x / 64)][[1, 2, 0][plane]], ((plane * height + y) * width + x) * 4);
}
const reference = ffmpeg(['-f', 'rawvideo', '-pixel_format', 'gbrpf32le', '-video_size', `${width}x${height}`, '-i', 'pipe:0',
  '-vf', SCRGB_TO_PQ, '-frames:v', '1', '-pix_fmt', 'yuv420p10le', '-f', 'rawvideo', 'pipe:1'], { input: frame });
const colored = await native('colors', width, height, 4, 1);
const gpuColors = decode(colored.file);
const colorPatches = colors.map((rgb, patch) => {
  const x = patch * 64 + 32, y = 64;
  const positions = [(y * width + x) * 2, width * height * 2 + ((y / 2) * width / 2 + x / 2) * 2,
    width * height * 5 / 2 + ((y / 2) * width / 2 + x / 2) * 2];
  const actual = positions.map(position => gpuColors.readUInt16LE(position));
  const expected = positions.map(position => reference.readUInt16LE(position));
  if (actual.some((value, index) => Math.abs(value - expected[index]) > 8)) throw new Error(`GPU HDR color mismatch: ${JSON.stringify({ rgb, actual, expected })}`);
  return { rgb, actual, expected };
});
const resized = await native('aspect-fit', 256, 128, 4, 0, false, [512, 128]);
const resizedPixels = decode(resized.file);
const resizedHighlights = verifyHighlightPatches(resizedPixels, 256, 128);
const blackBars = [0, 127].map(y => resizedPixels.readUInt16LE((y * 256 + 128) * 2));
if (blackBars.some(value => Math.abs(value - 64) > 2)) throw new Error('GPU aspect fit did not preserve black bars');
const benchmark = await native('dynamic', options.width, options.height, options.fps * options.seconds, 2);
verifyHighlightPatches(decode(benchmark.file), options.width, options.height);
// A changing GPU texture must reach consecutive encoded pictures. Metadata
// and static patches alone cannot expose stale texture/synchronization bugs.
const frameHashes = ffmpeg(['-i', benchmark.file, '-frames:v', '2', '-f', 'framemd5', 'pipe:1']).toString()
  .split(/\r?\n/).filter(line => /^\d+\s*,/.test(line)).map(line => line.split(',').at(-1).trim());
if (frameHashes.length !== 2 || frameHashes[0] === frameHashes[1]) throw new Error('GPU dynamic input did not update encoded pictures');
const realtime = await native('realtime', options.width, options.height, options.fps * Math.min(3, options.seconds), 2, true);
const realtimePassed = benchmark.totalFps >= options.fps && realtime.metrics.fps >= options.fps * 0.98;
const report = {
  schemaVersion: 1, createdAt: new Date().toISOString(), pipeline: 'd3d11-compute-p010-nvenc',
  options, syntheticOnly: true, endToEndVerified: false, hardwareHdrDisplayVerified: false,
  pixelReadback: false, videoEncoders: 1, highlights, colorPatches, aspectFit: { highlights: resizedHighlights, blackBars }, consecutiveFrameHashes: frameHashes,
  benchmark, realtime, realtimePassed,
  note: 'Synthetic GPU input exercises color conversion and one NVENC encoder. No WGC/HDR output/LiveKit/dual-machine or network bandwidth acceptance is implied. File bitrate is synthetic media only.',
};
await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ reportFile: path.join(output, 'report.json'), highlights, colorPatches,
  pipelineFps: benchmark.metrics.fps, includingStartupFps: benchmark.totalFps, realtimeFps: realtime.metrics.fps,
  realtimePassed, endToEndVerified: false }, null, 2));
if (!realtimePassed) process.exitCode = 1;
