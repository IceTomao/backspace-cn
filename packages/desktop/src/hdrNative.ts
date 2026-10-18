import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { hdrColorPacket, validateHdrColor, type HdrColor } from './hdrColor';

export type HdrFailure = 'validation_pending' | 'native_unavailable' | 'system_hdr_off' | 'source_unsupported' | 'native_failed' | 'encoder_unavailable';
export interface HdrDisplay { id: string; name: string; hdrActive: boolean; width: number; height: number }
export interface HdrCapabilities { protocol: 1; available: boolean; publisherAvailable?: boolean; colorControl?: 1; experimental?: boolean; reason?: HdrFailure; displays: HdrDisplay[]; labMode?: boolean }
export interface HdrVideoConfig { width: number; height: number; fps: number; bitrateKbps: number; shareAudio: boolean; color?: HdrColor }
export interface HdrCredentials { url: string; token: string; identity: string; hasAudio?: boolean }
interface NativeDisplay { gdiName: string; name: string; hdrActive: boolean | null; hmonitor: string; width: number; height: number }
interface NativeEvent { type: string; reason?: string; trackSid?: string; identity?: string; sampleRate?: number; channels?: number; format?: string; revision?: number }

const TRACK = 'backspace-screen-hdr-v1';

export function validateHdrVideo(config: HdrVideoConfig): void {
  if (!config || ![config.width, config.height, config.fps, config.bitrateKbps].every(Number.isSafeInteger) ||
      config.width < 256 || config.width > 7680 || config.width % 2 || config.height < 128 || config.height > 4320 || config.height % 2 ||
      config.fps < 1 || config.fps > 120 || config.bitrateKbps < 500 || config.bitrateKbps > 200000 || typeof config.shareAudio !== 'boolean') {
    throw new Error('Invalid HDR configuration');
  }
  if (config.color !== undefined) validateHdrColor(config.color);
}

export function hdrGpuArgs(config: HdrVideoConfig, monitor?: string): string[] {
  validateHdrVideo(config);
  if (monitor !== undefined && (!/^[1-9][0-9]{0,19}$/.test(monitor) || BigInt(monitor) > 0xffffffffffffffffn)) throw new Error('Invalid HDR monitor');
  return ['--width', String(config.width), '--height', String(config.height), '--fps', String(config.fps),
    '--bitrate-kbps', String(config.bitrateKbps),
    ...(config.color ? ['--exposure-tenths', String(Math.round(config.color.exposureEv * 10)), '--brightness', String(config.color.brightness)] : []),
    ...(monitor === undefined ? ['--synthetic', '--frames', '4'] : ['--monitor', monitor, '--watch-parent'])];
}

export function assertHdrBitstream(probe: unknown, expected?: Pick<HdrVideoConfig, 'width' | 'height'>): void {
  const streams = (probe as { streams?: Record<string, unknown>[] })?.streams;
  if (!Array.isArray(streams) || streams.length !== 1) throw new Error('Unexpected HDR streams');
  const required = { codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le',
    color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', color_range: 'tv',
    ...(expected ? { width: expected.width, height: expected.height } : {}) };
  for (const [key, value] of Object.entries(required)) if (streams[0]?.[key] !== value) throw new Error(`Invalid HDR bitstream: ${key}`);
}

/** Read through the next AUD, keeping every consumed byte for the publisher. */
export function readHdrPrefix(stream: Readable, timeoutMs = 15000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const cleanup = () => { clearTimeout(timeout); stream.off('data', data); stream.off('error', failed); stream.off('end', ended); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const ended = () => failed(new Error('HDR encoder ended before producing a complete picture'));
    const timeout = setTimeout(() => failed(new Error('HDR encoder timed out')), timeoutMs);
    const data = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 16 * 1024 * 1024) return failed(new Error('HDR picture exceeds limit'));
      let auds = 0;
      for (let i = 0; i + 4 < bytes.length; i++) {
        if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3]! >> 1) === 35) auds++;
      }
      if (auds >= 2) { stream.pause(); cleanup(); resolve(bytes); }
    };
    stream.on('data', data); stream.once('error', failed); stream.once('end', ended);
  });
}

function runBytes(executable: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: 'pipe' });
    let output = Buffer.alloc(0), finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timeout);
      if (error) { child.kill(); reject(error); }
      else resolve(output);
    };
    const timeout = setTimeout(() => finish(new Error('Native probe timed out')), 15000);
    child.on('error', () => finish(new Error('Native probe unavailable')));
    child.stdout.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 1024 * 1024) finish(new Error('Native probe response exceeds limit'));
    });
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.on('close', code => finish(code === 0 ? undefined : new Error('Native probe failed')));
    child.stdin.end(input);
  });
}
async function runJson(executable: string, args: string[], input?: Buffer): Promise<unknown> {
  try { return JSON.parse((await runBytes(executable, args, input)).toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid native probe response'); }
}

interface Operation {
  children: Set<ChildProcessWithoutNullStreams>;
  stopped: boolean;
  timer?: ReturnType<typeof setInterval>;
  server?: Server;
  player?: ChildProcessWithoutNullStreams;
  encoder?: ChildProcessWithoutNullStreams;
  colorRevision?: number;
  colorWaiters?: Map<number, { resolve: () => void; reject: (error: Error) => void }>;
}

/** One publisher and one viewer owned by the current desktop/voice session. */
export class HdrNativeRuntime {
  private publisher: Operation | null = null;
  private viewer: Operation | null = null;
  private encoderProbe: Promise<boolean> | null = null;
  constructor(private readonly root: string, private readonly notify: (event: { kind: 'publisher' | 'viewer'; state: 'stopped'; reason?: string }) => void, private readonly allowUnaccepted = false) {}

  private file(name: string): string { return path.join(this.root, name); }
  private availability(): HdrFailure | undefined {
    try {
      const manifest = JSON.parse(fs.readFileSync(this.file('acceptance.json'), 'utf8'));
      if (manifest.protocol !== 1 || (manifest.releaseAccepted !== true && manifest.experimentalAllowed !== true && !this.allowUnaccepted)) return 'validation_pending';
      for (const file of ['DisplayProbe.exe', 'HdrGpu.exe', 'HdrPlayer.exe', 'HdrAudio.exe', 'hdr-bridge.exe', 'libmpv-2.dll', 'hdr-probe.hevc',
        'encoder/ffmpeg.exe', 'encoder/ffprobe.exe']) if (!fs.statSync(this.file(file)).isFile()) return 'native_unavailable';
      return undefined;
    } catch { return 'native_unavailable'; }
  }
  private async displays(): Promise<NativeDisplay[]> {
    const result = await runJson(this.file('DisplayProbe.exe'), []) as { schemaVersion?: unknown; displays?: NativeDisplay[] };
    if (result.schemaVersion !== 2 || !Array.isArray(result.displays)) throw new Error('HDR state unknown');
    return result.displays;
  }
  private async canEncode(): Promise<boolean> {
    // Decode support alone cannot authorize publishing. Exercise the actual
    // shipped GPU shader and driver NVENC API; inspect its Main10/PQ output.
    if (!this.encoderProbe) this.encoderProbe = (async () => {
      try {
        const config = { width: 256, height: 128, fps: 60, bitrateKbps: 1000, shareAudio: false };
        const encoded = await runBytes(this.file('HdrGpu.exe'), hdrGpuArgs(config));
        assertHdrBitstream(await runJson(this.file('encoder/ffprobe.exe'), ['-v', 'error', '-f', 'hevc', '-show_streams', '-of', 'json', 'pipe:0'], encoded), config);
        return true;
      } catch { return false; }
    })().finally(() => { this.encoderProbe = null; });
    return this.encoderProbe;
  }
  async capabilities(probeEncoder = false): Promise<HdrCapabilities> {
    const reason = this.availability();
    if (reason) return { protocol: 1, available: false, reason, displays: [] };
    try {
      const displays = (await this.displays()).map(d => ({ id: `hdr:${d.gdiName}`, name: d.name, hdrActive: d.hdrActive === true, width: d.width, height: d.height }));
      const available = displays.some(d => d.hdrActive);
      // Opening SDR settings performs display detection only. Exercise NVENC
      // only after an explicit HDR enable/start request.
      const publisherAvailable = available && (!probeEncoder || await this.canEncode());
      const manifest = JSON.parse(fs.readFileSync(this.file('acceptance.json'), 'utf8'));
      return { protocol: 1, available, publisherAvailable, colorControl: 1, experimental: manifest.releaseAccepted !== true,
        ...(!available ? { reason: 'system_hdr_off' as const } : !publisherAvailable ? { reason: 'encoder_unavailable' as const } : {}), displays, labMode: this.allowUnaccepted };
    } catch { return { protocol: 1, available: false, reason: 'native_failed', displays: [] }; }
  }

  private child(op: Operation, executable: string, args: string[]): ChildProcessWithoutNullStreams {
    if (op.stopped) throw new Error('HDR operation cancelled');
    const child = spawn(this.file(executable), args, { windowsHide: true, stdio: 'pipe', cwd: this.root });
    op.children.add(child);
    child.stdin.on('error', () => {});
    const failed = () => this.stopOperation(op, 'native_process_exited');
    child.once('error', failed); child.once('close', failed);
    return child;
  }
  private events(child: ChildProcessWithoutNullStreams, source: 'stdout' | 'stderr', handler: (event: NativeEvent) => void): void {
    let pending = '';
    child[source].setEncoding('utf8');
    child[source].on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > 65536) { child.kill(); return; }
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try { const event = JSON.parse(line) as NativeEvent; if (typeof event.type === 'string') handler(event); } catch { /* bounded SDK diagnostics */ }
      }
    });
  }
  private waitEvent(op: Operation, child: ChildProcessWithoutNullStreams, source: 'stdout' | 'stderr', type: string): Promise<NativeEvent> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('HDR startup timed out')); this.stopOperation(op); }, 20000);
      const failed = () => { clearTimeout(timeout); reject(new Error('HDR native process failed')); };
      child.once('close', failed); child.once('error', failed);
      this.events(child, source, event => {
        if (event.type === type) { clearTimeout(timeout); child.off('close', failed); child.off('error', failed); resolve(event); }
        if (event.type === 'failed' || event.type === 'stopped') { failed(); this.stopOperation(op, event.reason); }
      });
    });
  }
  private operation(kind: 'publisher' | 'viewer'): Operation {
    this.stop(kind);
    const op: Operation = { children: new Set(), stopped: false };
    if (kind === 'publisher') this.publisher = op; else this.viewer = op;
    return op;
  }

  async startPublisher(sourceId: string, config: HdrVideoConfig, credentials: HdrCredentials): Promise<{ trackSid: string; identity: string }> {
    validateHdrVideo(config);
    if (this.availability()) throw new Error('HDR pipeline has not passed acceptance');
    const op = this.operation('publisher');
    try {
      const display = (await this.displays()).filter(d => `hdr:${d.gdiName}` === sourceId);
      if (display.length !== 1 || display[0]!.hdrActive !== true || !/^[1-9][0-9]*$/.test(display[0]!.hmonitor)) throw new Error('Selected display is not in HDR mode');
      if (op.stopped) throw new Error('HDR operation cancelled');
      const target = display[0]!;
      if (!await this.canEncode()) throw new Error('NVENC Main10 encoder unavailable');
      let audioUrl: string | undefined;
      if (config.shareAudio) {
        const audioCapture = this.child(op, 'HdrAudio.exe', []);
        const format = await this.waitEvent(op, audioCapture, 'stderr', 'audio-ready');
        if (!Number.isSafeInteger(format.sampleRate) || format.sampleRate! < 8000 || format.sampleRate! > 192000 ||
            !Number.isSafeInteger(format.channels) || format.channels! < 1 || format.channels! > 8 ||
            !['f32le', 's16le', 's24le', 's32le'].includes(format.format!)) throw new Error('Invalid system audio format');
        const opus = this.child(op, 'encoder/ffmpeg.exe', ['-hide_banner', '-loglevel', 'error', '-nostdin',
          '-f', format.format!, '-ar', String(format.sampleRate), '-ac', String(format.channels), '-i', 'pipe:0',
          '-map', '0:a:0', '-vn', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '128k', '-frame_duration', '20',
          '-application', 'lowdelay', '-page_duration', '20000', '-flush_packets', '1', '-f', 'ogg', 'pipe:1']);
        opus.stderr.resume(); audioCapture.stdout.pipe(opus.stdin);
        const secret = randomBytes(32).toString('hex');
        let connected = false;
        const server = createServer((request, response) => {
          if (request.method !== 'GET' || request.url !== `/${secret}` || connected || request.headers.origin) { response.writeHead(403).end(); return; }
          connected = true; response.writeHead(200, { 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store' }); response.flushHeaders();
          opus.stdout.pipe(response); response.once('close', () => this.stopOperation(op));
        });
        op.server = server;
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const address = server.address();
        if (op.stopped || !address || typeof address === 'string') throw new Error('HDR operation cancelled');
        audioUrl = `http://127.0.0.1:${address.port}/${secret}`;
      }
      let polling = false;
      op.timer = setInterval(() => {
        if (polling) return;
        polling = true;
        void this.displays().then(displays => {
          const matches = displays.filter(d => d.gdiName === target.gdiName);
          if (matches.length !== 1 || matches[0]!.hdrActive !== true || matches[0]!.hmonitor !== target.hmonitor) this.stopOperation(op, 'output_hdr_disabled');
        }, () => this.stopOperation(op, 'hdr_state_unknown')).finally(() => { polling = false; });
      }, 1000);
      const encoder = this.child(op, 'HdrGpu.exe', hdrGpuArgs(config, target.hmonitor));
      op.encoder = encoder; op.colorRevision = 0; op.colorWaiters = new Map();
      this.events(encoder, 'stderr', event => {
        if (event.type === 'failed') this.stopOperation(op, event.reason);
        if (event.type === 'color-applied' && typeof event.revision === 'number') op.colorWaiters?.get(event.revision)?.resolve();
      });
      const prefix = await readHdrPrefix(encoder.stdout);
      const bitstream = await runJson(this.file('encoder/ffprobe.exe'), ['-v', 'error', '-f', 'hevc', '-show_streams', '-of', 'json', 'pipe:0'], prefix);
      assertHdrBitstream(bitstream, { width: config.width, height: config.height });
      const transport = this.child(op, 'hdr-bridge.exe', []);
      transport.stdout.resume();
      const streaming = this.waitEvent(op, transport, 'stderr', 'streaming');
      const { color: _color, ...video } = config;
      transport.stdin.write(`${JSON.stringify({ protocol: 1, mode: 'publish', url: credentials.url, token: credentials.token, ...video, audioUrl })}\n`);
      transport.stdin.write(prefix);
      encoder.stdout.pipe(transport.stdin);
      const event = await streaming;
      if (op.stopped || !event.trackSid || event.identity !== credentials.identity) throw new Error('HDR publication not confirmed');
      return { trackSid: event.trackSid, identity: event.identity };
    } catch (error) { this.stopOperation(op); throw error; }
  }

  async startViewer(publisher: string, credentials: HdrCredentials, ownerWindow = '0'): Promise<void> {
    if (this.availability()) throw new Error('HDR pipeline has not passed acceptance');
    const op = this.operation('viewer');
    try {
      if (!/^[0-9]{1,20}$/.test(ownerWindow)) throw new Error('Invalid HDR owner window');
      const player = this.child(op, 'HdrPlayer.exe', [this.file('hdr-probe.hevc'), ownerWindow]);
      op.player = player;
      player.stderr.resume();
      // Actual local Main10 decode, 10-bit D3D11 swapchain and output HDR first.
      // No LiveKit helper is even connected until this succeeds.
      await this.waitEvent(op, player, 'stdout', 'ready');
      if (op.stopped) throw new Error('HDR viewer cancelled');
      const transport = this.child(op, 'hdr-bridge.exe', []);
      // Keep the first IDR during probing. +nobuffer discards probe pictures and
      // can leave a short/idle stream empty until the next encoder keyframe.
      const remux = this.child(op, 'encoder/ffmpeg.exe', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', '+genpts',
        '-probesize', '65536', '-analyzeduration', '1', '-fpsprobesize', '0',
        '-f', 'hevc', '-i', 'pipe:0', '-map', '0:v:0', '-an', '-c:v', 'copy', '-bsf:v', 'setts=pts=N*DURATION:dts=N*DURATION',
        '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-f', 'mpegts', 'pipe:1']);
      remux.stderr.resume();
      this.events(transport, 'stderr', event => { if (event.type === 'failed') this.stopOperation(op, event.reason); });
      const secret = randomBytes(32).toString('hex');
      const audioSecret = randomBytes(32).toString('hex');
      const audio = new PassThrough({ highWaterMark: 65536 });
      let audioIn = false, audioOut = false;
      let connected = false;
      const server = createServer((request, response) => {
        if (credentials.hasAudio && request.url === `/${audioSecret}` && !request.headers.origin) {
          if (request.method === 'POST' && !audioIn) {
            audioIn = true; response.writeHead(200); response.flushHeaders(); request.pipe(audio);
            request.once('end', () => response.end()); request.once('error', () => this.stopOperation(op, 'system_audio_failed')); return;
          }
          if (request.method === 'GET' && !audioOut) {
            audioOut = true; response.writeHead(200, { 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store' }); response.flushHeaders(); audio.pipe(response);
            response.once('close', () => this.stopOperation(op)); return;
          }
        }
        if (request.method !== 'GET' || request.url !== `/${secret}` || connected || request.headers.origin) { response.writeHead(403).end(); return; }
        connected = true;
        response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
        remux.stdout.pipe(response);
        response.once('close', () => this.stopOperation(op));
      });
      op.server = server;
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (op.stopped || !address || typeof address === 'string') throw new Error('HDR viewer cancelled');
      transport.stdout.pipe(remux.stdin);
      const audioUrl = credentials.hasAudio ? `http://127.0.0.1:${address.port}/${audioSecret}` : undefined;
      player.stdin.write(`${JSON.stringify({ action: 'load', url: `http://127.0.0.1:${address.port}/${secret}`, audioUrl })}\n`);
      transport.stdin.write(`${JSON.stringify({ protocol: 1, mode: 'receive', url: credentials.url, token: credentials.token, publisher, audioUrl })}\n`);
    } catch (error) { this.stopOperation(op); throw error; }
  }

  private stopOperation(op: Operation, reason?: string): void {
    if (op.stopped) return;
    op.stopped = true;
    clearInterval(op.timer);
    for (const waiter of op.colorWaiters?.values() ?? []) waiter.reject(new Error('HDR publisher stopped'));
    op.colorWaiters?.clear();
    op.server?.closeAllConnections(); op.server?.close();
    for (const child of op.children) { child.stdin.destroy(); child.kill(); }
    const kind = this.publisher === op ? 'publisher' : 'viewer';
    if (this.publisher === op) this.publisher = null;
    if (this.viewer === op) this.viewer = null;
    this.notify({ kind, state: 'stopped', ...(reason ? { reason } : {}) });
  }
  stop(kind: 'publisher' | 'viewer'): void { const op = kind === 'publisher' ? this.publisher : this.viewer; if (op) this.stopOperation(op); }
  async setPublisherColor(color: HdrColor): Promise<void> {
    validateHdrColor(color);
    const op = this.publisher;
    if (!op || op.stopped || !op.encoder || !op.colorWaiters) throw new Error('HDR publisher unavailable');
    if (op.colorWaiters.size) throw new Error('HDR color update busy');
    const revision = (op.colorRevision ?? 0) + 1;
    const packet = hdrColorPacket(color, revision); op.colorRevision = revision;
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timeout); op.colorWaiters?.delete(revision);
        if (error) reject(error); else resolve();
      };
      const timeout = setTimeout(() => {
        done(new Error('HDR color update timed out'));
        // Do not keep streaming with an unknown applied state after timeout.
        this.stopOperation(op, 'color_update_timeout');
      }, 3000);
      op.colorWaiters!.set(revision, { resolve: () => done(), reject: done });
      op.encoder!.stdin.write(packet, error => {
        if (error) { done(new Error('HDR control pipe closed')); this.stopOperation(op, 'color_control_failed'); }
      });
    });
  }
  setViewerAudio(volume: number, muted: boolean): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 400 || typeof muted !== 'boolean') throw new Error('Invalid viewer audio settings');
    this.viewer?.player?.stdin.write(`${JSON.stringify({ action: 'audio', volume, muted })}\n`);
  }
  dispose(): void { this.stop('publisher'); this.stop('viewer'); }
}

export const HDR_NATIVE_TRACK = TRACK;
