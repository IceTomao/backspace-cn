import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { captureArgs, captureFramesArgs, rawHdrEncodeArgs, requireHdrDisplay, syntheticFrame, validateOptions, verifyHdrStream, verifyHighlightPatches } from './pipeline.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  ffmpeg: { type: 'string', default: 'ffmpeg' }, ffprobe: { type: 'string', default: 'ffprobe' },
  'capture-ffmpeg': { type: 'string' },
  'gpu-conversion': { type: 'boolean', default: false },
  display: { type: 'string' }, width: { type: 'string', default: '1920' }, height: { type: 'string', default: '1080' },
  fps: { type: 'string', default: '60' }, seconds: { type: 'string', default: '10' }, bitrate: { type: 'string', default: '16000' },
  file: { type: 'string' }, output: { type: 'string' },
} });
const command = positionals[0];
const artifacts = path.join(directory, '.artifacts');
mkdirSync(artifacts, { recursive: true });

function native(exe, args, extra = {}) {
  return execFileSync(exe, args, { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...extra });
}

function displaySnapshot() {
  if (process.platform !== 'win32') throw new Error('Native display preflight requires Windows');
  const source = path.join(directory, 'DisplayProbe.cs'), exe = path.join(artifacts, 'DisplayProbe.exe');
  let rebuild = false;
  try { rebuild = statSync(source).mtimeMs > statSync(exe).mtimeMs; } catch { rebuild = true; }
  if (rebuild) {
    const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    native(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${exe}`, source]);
  }
  return JSON.parse(native(exe, []).toString('utf8').replace(/^\uFEFF/, ''));
}

function inspect(file, expected) {
  // Inspect Annex B parameter sets, not just Matroska's color tags.
  const elementary = file.endsWith('.hevc') ? file : `${file}.hevc`;
  if (elementary !== file) native(values.ffmpeg, ['-hide_banner', '-v', 'error', '-n', '-i', file, '-map', '0:v:0', '-c:v', 'copy', '-an', '-bsf:v', 'hevc_mp4toannexb', '-f', 'hevc', elementary]);
  const probe = JSON.parse(native(values.ffprobe, ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', elementary]).toString());
  return { stream: verifyHdrStream(probe, expected), elementary };
}

async function encode(args, { frame, frames, monitor, producerArgs } = {}) {
  const started = performance.now();
  const child = spawn(values.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', progress = '', failure = null;
  const gpuSamples = [];
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-32768); });
  child.stdout.on('data', data => { progress = (progress + data).slice(-32768); });
  child.stdin.on('error', () => {}); // Process failure is reported by close/error.
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 && !failure ? resolve() : reject(new Error(failure ?? `FFmpeg exited ${code}\n${stderr}`)));
  });
  // Attach a rejection handler before writing raw frames, avoiding an unhandled
  // rejection if NVENC refuses to initialize while stdin is backpressured.
  completion.catch(() => {});
  let producer = null, producerStderr = '';
  if (producerArgs) {
    producer = spawn(values['capture-ffmpeg'], producerArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    producer.stderr.on('data', data => { producerStderr = (producerStderr + data).slice(-16384); });
    producer.on('error', error => { failure = `WGC capture failed: ${error.message}`; child.kill(); });
    producer.on('close', code => { if (code !== 0 && child.exitCode === null) { failure = `WGC exited ${code}: ${producerStderr}`; child.kill(); } });
    producer.stdout.pipe(child.stdin);
  }
  let checking = false;
  const interval = setInterval(() => {
    if (checking) return;
    checking = true;
    try {
      if (monitor) {
        const current = requireHdrDisplay(displaySnapshot(), monitor.gdiName);
        if (current.hmonitor !== monitor.hmonitor) throw new Error('Selected display changed during capture');
      }
      try {
        const sample = native('nvidia-smi', ['--query-gpu=timestamp,name,utilization.gpu,utilization.encoder,memory.used,power.draw', '--format=csv,noheader,nounits'], { timeout: 3000 });
        gpuSamples.push(sample.toString().trim());
      } catch { /* GPU telemetry is optional; a missing sample never grants HDR support. */ }
    } catch (error) {
      failure = error.message;
      child.kill();
    } finally { checking = false; }
  }, 1000);
  const timeout = setTimeout(() => { failure = 'Encoder deadline exceeded'; child.kill(); }, (Number(values.seconds) * 8 + 30) * 1000);
  const interrupt = () => { failure = 'Capture interrupted'; child.kill(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    if (frame) {
      for (let i = 0; i < frames; i++) {
        if (child.exitCode !== null || child.killed || child.stdin.destroyed) break;
        await Promise.race([
          new Promise((resolve, reject) => child.stdin.write(frame, error => error ? reject(error) : resolve())),
          completion,
        ]).catch(async error => { await completion; throw error; });
      }
    }
    if (!producer) child.stdin.end();
    await completion;
    return { wallSeconds: (performance.now() - started) / 1000, progress, benchmark: stderr.split(/\r?\n/).filter(line => line.startsWith('bench:')), gpuSamples, captureLog: producerStderr || undefined };
  } finally {
    clearInterval(interval);
    clearTimeout(timeout);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (child.exitCode === null) child.kill();
    if (producer && producer.exitCode === null) producer.kill();
  }
}

async function main() {
  if (command === 'probe') {
    console.log(JSON.stringify(displaySnapshot(), null, 2));
    return;
  }
  if (command === 'inspect') {
    if (!values.file) throw new Error('inspect requires --file');
    console.log(JSON.stringify(inspect(path.resolve(values.file)), null, 2));
    return;
  }
  if (command !== 'synthetic' && command !== 'capture') throw new Error('Usage: node lab.mjs probe|synthetic|capture|inspect [--ffmpeg PATH --ffprobe PATH --display \\\\.\\DISPLAY1 --width 1920 --height 1080 --fps 60 --seconds 10 --bitrate 16000]');
  const options = validateOptions({ width: Number(values.width), height: Number(values.height), fps: Number(values.fps), seconds: Number(values.seconds), bitrateKbps: Number(values.bitrate) });
  // Check the exact selected display before creating any capture process.
  const monitor = command === 'capture' ? requireHdrDisplay(displaySnapshot(), values.display) : null;
  const runDirectory = values.output ? path.resolve(values.output) : path.join(artifacts, `${command}-${Date.now()}`);
  mkdirSync(runDirectory, { recursive: true });
  const file = path.join(runDirectory, 'hdr.mkv');
  const separateCapture = monitor && values['capture-ffmpeg'];
  const conversion = { gpuConversion: values['gpu-conversion'] };
  const args = monitor && !separateCapture ? captureArgs(monitor, options, file, conversion) : rawHdrEncodeArgs(options, file, conversion);
  const performanceResult = await encode(args, monitor ? { monitor, producerArgs: separateCapture ? captureFramesArgs(monitor, options) : undefined }
    : { frame: syntheticFrame(options.width, options.height), frames: options.fps * options.seconds });
  // Detect a display change in the final interval as well.
  if (monitor && requireHdrDisplay(displaySnapshot(), monitor.gdiName).hmonitor !== monitor.hmonitor) throw new Error('Display changed before final verification');
  const verified = inspect(file, options);
  let patches = null;
  if (!monitor) {
    const decoded = native(values.ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1', '-pix_fmt', 'yuv420p10le', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: options.width * options.height * 4 });
    patches = verifyHighlightPatches(decoded, options.width, options.height);
  }
  const report = {
    schemaVersion: 1, createdAt: new Date().toISOString(), stage: command,
    endToEndVerified: false, // Only dual-machine LiveKit/display acceptance can change this.
    options, monitor, conversion: conversion.gpuConversion ? 'vulkan-libplacebo' : 'cpu-zscale',
    ffmpegVersion: native(values.ffmpeg, ['-version']).toString().split(/\r?\n/)[0],
    ...verified, patches, performance: performanceResult,
    encodedFileMbps: statSync(file).size * 8 / options.seconds / 1e6,
    note: 'File bitrate is not LiveKit network bandwidth. Capture still uses float readback; GPU conversion also uses upload/readback. GPU samples include other applications. No viewer/rendering validation is implied.',
  };
  const reportFile = path.join(runDirectory, 'report.json');
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ reportFile, stage: command, patches, encodedFileMbps: report.encodedFileMbps, wallSeconds: performanceResult.wallSeconds, endToEndVerified: false }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
