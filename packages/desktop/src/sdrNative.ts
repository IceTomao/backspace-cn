import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { hdrColorCliArgs, hdrColorPacket, validateHdrColor, type HdrColor } from './hdrColor';

export type SdrNativeCodec = 'hevc' | 'h264';
export type SdrFailure = 'native_unavailable' | 'encoder_unavailable' | 'source_unsupported' | 'native_failed';

export interface SdrDisplay {
  gdiName: string;
  name: string;
  hmonitor: string;
  left: number;
  top: number;
  isPrimary: boolean;
  width: number;
  height: number;
}

export interface ScreenMonitorHint {
  sourceId: string;
  physicalBounds: { x: number; y: number; width: number; height: number } | null;
  dipBounds: { x: number; y: number; width: number; height: number } | null;
  scaleFactor: number;
  isPrimary: boolean;
  screenIndex: number;
  totalScreens: number;
}

export interface WindowCaptureHint {
  kind: 'window';
  sourceId: string;
  hwnd: string;
}

export type SdrCaptureTarget = ScreenMonitorHint | WindowCaptureHint;

export interface SdrCapabilities {
  protocol: 1;
  available: boolean;
  hevcAvailable: boolean;
  h264Available: boolean;
  colorControl: 2;
  reason?: SdrFailure;
  displays: SdrDisplay[];
}

export interface SdrVideoConfig {
  maxHeight?: number | 'native';
  width?: number;
  height?: number;
  fps: number;
  bitrateKbps: number;
  codec: SdrNativeCodec;
  shareAudio: boolean;
  color?: HdrColor;
}

export interface SdrCredentials {
  url: string;
  token: string;
  identity: string;
}

export interface SdrPublishResult {
  trackSid: string;
  identity: string;
  width: number;
  height: number;
  codec: SdrNativeCodec;
}

export type SdrRuntimeNotification =
  | { kind: 'publisher'; state: 'stopped'; reason?: string }
  | {
      kind: 'stats';
      codec: SdrNativeCodec;
      encodeFps: number;
      captureFps: number;
      encodeTimeMs: number;
      bitrateKbps: number;
      width: number;
      height: number;
      sourceWidth: number;
      sourceHeight: number;
    }
  | { kind: 'audio-stopped'; reason?: string };

export interface SdrAudioChunk {
  sampleRate: number;
  channels: number;
  frames: number;
  pcm: Float32Array;
}

interface NativeEvent {
  type: string;
  reason?: string;
  trackSid?: string;
  identity?: string;
  sampleRate?: number;
  channels?: number;
  format?: string;
  revision?: number;
  codec?: string;
  encodeFps?: number;
  freshFps?: number;
  encodeTimeMs?: number;
  bitrateKbps?: number;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

const REQUIRED_FILES = ['DisplayProbe.exe', 'HdrGpu.exe', 'HdrAudio.exe', 'hdr-bridge.exe'] as const;

export function validateSdrVideo(config: SdrVideoConfig): void {
  if (!config || typeof config !== 'object') throw new Error('Invalid SDR configuration');
  if (config.codec !== 'hevc' && config.codec !== 'h264') throw new Error('Invalid SDR codec');
  if (![config.fps, config.bitrateKbps].every(Number.isSafeInteger) ||
      config.fps < 1 || config.fps > 120 ||
      config.bitrateKbps < 500 || config.bitrateKbps > 200000 ||
      typeof config.shareAudio !== 'boolean') {
    throw new Error('Invalid SDR configuration');
  }
  if (config.maxHeight !== undefined && config.maxHeight !== 'native') {
    if (!Number.isSafeInteger(config.maxHeight) || config.maxHeight < 128 || config.maxHeight > 4320) {
      throw new Error('Invalid SDR maxHeight');
    }
  }
  if (config.width !== undefined || config.height !== undefined) {
    if (!Number.isSafeInteger(config.width) || !Number.isSafeInteger(config.height) ||
        config.width! < 256 || config.width! > 7680 || config.width! % 2 !== 0 ||
        config.height! < 128 || config.height! > 4320 || config.height! % 2 !== 0) {
      throw new Error('Invalid SDR dimensions');
    }
  }
  if (config.color !== undefined) validateHdrColor(config.color);
}

export function resolveSdrOutputDimensions(
  display: Pick<SdrDisplay, 'width' | 'height'>,
  config: Pick<SdrVideoConfig, 'maxHeight' | 'width' | 'height'>,
): { width: number; height: number } {
  if (config.width && config.height) {
    return { width: config.width, height: config.height };
  }
  const srcW = Math.max(256, Math.min(7680, Math.floor(display.width)));
  const srcH = Math.max(128, Math.min(4320, Math.floor(display.height)));
  const capH = config.maxHeight === undefined || config.maxHeight === 'native'
    ? srcH
    : Math.min(srcH, config.maxHeight);
  const scale = Math.min(1, capH / srcH);
  const even = (n: number, min: number, max: number) =>
    Math.max(min, Math.min(max, Math.round(n / 2) * 2));
  return {
    width: even(srcW * scale, 256, 7680),
    height: even(srcH * scale, 128, 4320),
  };
}

export function matchSdrDisplay(displays: SdrDisplay[], hint: ScreenMonitorHint): SdrDisplay | null {
  if (displays.length === 0) return null;
  if (displays.length === 1 && hint.totalScreens <= 1) return displays[0]!;
  if (hint.physicalBounds) {
    const b = hint.physicalBounds;
    const exact = displays.find(d => d.left === b.x && d.top === b.y && d.width === b.width && d.height === b.height);
    if (exact) return exact;
    const near = displays.find(d =>
      Math.abs(d.left - b.x) <= 6 &&
      Math.abs(d.top - b.y) <= 6 &&
      Math.abs(d.width - b.width) <= 6 &&
      Math.abs(d.height - b.height) <= 6,
    );
    if (near) return near;
  }
  if (hint.dipBounds) {
    const b = hint.dipBounds;
    const dipMatch = displays.find(d => d.left === b.x && d.top === b.y && d.width === b.width && d.height === b.height);
    if (dipMatch) return dipMatch;
  }
  if (hint.isPrimary) {
    const primary = displays.find(d => d.isPrimary);
    if (primary) return primary;
  }
  if (hint.screenIndex >= 0 && hint.screenIndex < displays.length) {
    return displays[hint.screenIndex]!;
  }
  return displays[0] ?? null;
}

export function parseWindowHwndFromSourceId(sourceId: string): string | null {
  if (typeof sourceId !== 'string') return null;
  const match = /^window:([1-9][0-9]{0,19}):[0-9]+$/.exec(sourceId);
  if (!match?.[1]) return null;
  try {
    if (BigInt(match[1]) > 0xffffffffffffffffn) return null;
    return match[1];
  } catch {
    return null;
  }
}

export function sdrAudioArgs(targetPid?: number, ownPid = process.pid): string[] {
  if (
    targetPid !== undefined &&
    Number.isSafeInteger(targetPid) &&
    targetPid > 0 &&
    targetPid <= 0xffffffff &&
    targetPid !== ownPid
  ) {
    return ['--pid', String(targetPid)];
  }
  return [];
}

function isWindowCaptureTarget(target: SdrCaptureTarget): target is WindowCaptureHint {
  return 'kind' in target && target.kind === 'window';
}

function validateNativeHandle(handle: string, label: string): void {
  if (!/^[1-9][0-9]{0,19}$/.test(handle) || BigInt(handle) > 0xffffffffffffffffn) {
    throw new Error(`Invalid SDR ${label}`);
  }
}

export function sdrGpuArgs(
  config: SdrVideoConfig & { width: number; height: number },
  target?: string | { monitor: string } | { window: string },
): string[] {
  validateSdrVideo(config);
  let targetArgs: string[];
  if (target === undefined) {
    targetArgs = ['--synthetic', '--frames', '2'];
  } else if (typeof target === 'string') {
    validateNativeHandle(target, 'monitor');
    targetArgs = ['--monitor', target, '--watch-parent'];
  } else if ('monitor' in target) {
    validateNativeHandle(target.monitor, 'monitor');
    targetArgs = ['--monitor', target.monitor, '--watch-parent'];
  } else if ('window' in target) {
    validateNativeHandle(target.window, 'window');
    targetArgs = ['--window', target.window, '--watch-parent'];
  } else {
    throw new Error('Invalid SDR capture target');
  }
  return [
    '--sdr',
    '--codec', config.codec,
    '--width', String(config.width),
    '--height', String(config.height),
    '--fps', String(config.fps),
    '--bitrate-kbps', String(config.bitrateKbps),
    ...(config.color ? hdrColorCliArgs(config.color) : []),
    ...targetArgs,
  ];
}

export function decodePcmChunkToStereoOrMonoFloat32(
  buf: Buffer,
  offset: number,
  frames: number,
  inChannels: number,
  format: string,
): { pcm: Float32Array; outChannels: number } {
  const outChannels = Math.min(2, Math.max(1, inChannels));
  const out = new Float32Array(frames * outChannels);
  const bytesPerSample = format === 's16le' ? 2 : format === 's24le' ? 3 : 4;
  const frameStride = inChannels * bytesPerSample;

  const readSample = (pos: number): number => {
    if (format === 'f32le') {
      const v = buf.readFloatLE(pos);
      return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    }
    if (format === 's16le') return buf.readInt16LE(pos) / 32768;
    if (format === 's24le') {
      const b0 = buf[pos]!;
      const b1 = buf[pos + 1]!;
      const b2 = buf[pos + 2]!;
      const signed = ((b2 << 24) | (b1 << 16) | (b0 << 8)) >> 8;
      return signed / 8388608;
    }
    return buf.readInt32LE(pos) / 2147483648;
  };

  for (let f = 0; f < frames; f++) {
    const base = offset + f * frameStride;
    for (let c = 0; c < outChannels; c++) {
      out[f * outChannels + c] = readSample(base + c * bytesPerSample);
    }
  }
  return { pcm: out, outChannels };
}

export function hasAnnexBStartCode(buf: Buffer): boolean {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      return true;
    }
  }
  return false;
}

export function sdrKeyFramePacket(): Buffer {
  const packet = Buffer.alloc(40, 0);
  packet.write('IDR1', 0, 'ascii');
  return packet;
}

function runBytes(executable: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: 'pipe' });
    let output = Buffer.alloc(0);
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolve(output);
      }
    };
    const timeout = setTimeout(() => finish(new Error('Native SDR probe timed out')), 12000);
    child.on('error', () => finish(new Error('Native SDR probe unavailable')));
    child.stdout.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 2 * 1024 * 1024) finish(new Error('Native SDR probe output exceeds limit'));
    });
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.on('close', code => finish(code === 0 ? undefined : new Error('Native SDR probe failed')));
    child.stdin.end();
  });
}

async function runJson(executable: string, args: string[]): Promise<unknown> {
  const bytes = await runBytes(executable, args);
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

interface PublisherOperation {
  children: Set<ChildProcessWithoutNullStreams>;
  audioChild?: ChildProcessWithoutNullStreams;
  encoder?: ChildProcessWithoutNullStreams;
  stopped: boolean;
  colorRevision: number;
  colorWaiters: Map<number, { resolve: () => void; reject: (error: Error) => void }>;
}

export class SdrNativeRuntime {
  private publisher: PublisherOperation | null = null;
  private cachedEncoderSupport: { hevc: boolean; h264: boolean } | null = null;
  private encoderProbeInFlight: Promise<{ hevc: boolean; h264: boolean }> | null = null;

  constructor(
    private readonly root: string,
    private readonly notify: (event: SdrRuntimeNotification) => void,
    private readonly onAudioChunk?: (chunk: SdrAudioChunk) => void,
  ) {}

  private file(name: string): string {
    return path.join(this.root, name);
  }

  private availability(): SdrFailure | undefined {
    try {
      for (const file of REQUIRED_FILES) {
        if (!fs.statSync(this.file(file)).isFile()) return 'native_unavailable';
      }
      return undefined;
    } catch {
      return 'native_unavailable';
    }
  }

  private async displays(): Promise<SdrDisplay[]> {
    const result = await runJson(this.file('DisplayProbe.exe'), []) as {
      schemaVersion?: unknown;
      displays?: Array<Partial<SdrDisplay>>;
    };
    if (result.schemaVersion !== 2 || !Array.isArray(result.displays)) {
      throw new Error('Display probe schema mismatch');
    }
    return result.displays.map(d => ({
      gdiName: String(d.gdiName ?? ''),
      name: String(d.name ?? ''),
      hmonitor: String(d.hmonitor ?? ''),
      left: typeof d.left === 'number' ? d.left : 0,
      top: typeof d.top === 'number' ? d.top : 0,
      isPrimary: d.isPrimary === true,
      width: typeof d.width === 'number' ? d.width : 1920,
      height: typeof d.height === 'number' ? d.height : 1080,
    }));
  }

  private async probeWindow(hwnd: string): Promise<{ width: number; height: number; pid: number }> {
    validateNativeHandle(hwnd, 'window');
    const result = await runJson(this.file('DisplayProbe.exe'), ['--window', hwnd]) as {
      schemaVersion?: unknown;
      window?: {
        valid?: boolean;
        width?: number;
        height?: number;
        monitorWidth?: number;
        monitorHeight?: number;
        pid?: number;
      };
    };
    if (result.schemaVersion !== 2 || !result.window || result.window.valid !== true) {
      throw new Error('Selected window is no longer available');
    }
    const rawW = typeof result.window.width === 'number' ? result.window.width : 0;
    const rawH = typeof result.window.height === 'number' ? result.window.height : 0;
    const monW = typeof result.window.monitorWidth === 'number' ? result.window.monitorWidth : 0;
    const monH = typeof result.window.monitorHeight === 'number' ? result.window.monitorHeight : 0;
    const width = rawW >= 64 && rawH >= 64 ? rawW : (monW >= 256 && monH >= 128 ? monW : 1920);
    const height = rawW >= 64 && rawH >= 64 ? rawH : (monW >= 256 && monH >= 128 ? monH : 1080);
    const pid = typeof result.window.pid === 'number' && Number.isSafeInteger(result.window.pid) && result.window.pid > 0
      ? result.window.pid
      : 0;
    return { width, height, pid };
  }

  private async probeCodec(codec: SdrNativeCodec): Promise<boolean> {
    try {
      const probeConfig = { width: 256, height: 128, fps: 60, bitrateKbps: 1000, codec, shareAudio: false };
      const encoded = await runBytes(this.file('HdrGpu.exe'), sdrGpuArgs(probeConfig));
      return hasAnnexBStartCode(encoded);
    } catch {
      return false;
    }
  }

  private async probeEncoders(): Promise<{ hevc: boolean; h264: boolean }> {
    if (this.cachedEncoderSupport) return this.cachedEncoderSupport;
    if (!this.encoderProbeInFlight) {
      this.encoderProbeInFlight = (async () => {
        const [hevc, h264] = await Promise.all([this.probeCodec('hevc'), this.probeCodec('h264')]);
        const result = { hevc, h264 };
        if (hevc || h264) this.cachedEncoderSupport = result;
        return result;
      })().finally(() => {
        this.encoderProbeInFlight = null;
      });
    }
    return this.encoderProbeInFlight;
  }

  async capabilities(probeEncoder = false): Promise<SdrCapabilities> {
    const reason = this.availability();
    if (reason) {
      return { protocol: 1, available: false, hevcAvailable: false, h264Available: false, colorControl: 2, reason, displays: [] };
    }
    try {
      const displays = await this.displays();
      if (displays.length === 0) {
        return { protocol: 1, available: false, hevcAvailable: false, h264Available: false, colorControl: 2, reason: 'source_unsupported', displays: [] };
      }
      if (!probeEncoder && !this.cachedEncoderSupport) {
        return { protocol: 1, available: true, hevcAvailable: true, h264Available: true, colorControl: 2, displays };
      }
      const support = await this.probeEncoders();
      const available = support.hevc || support.h264;
      return {
        protocol: 1,
        available,
        hevcAvailable: support.hevc,
        h264Available: support.h264,
        colorControl: 2,
        ...(!available ? { reason: 'encoder_unavailable' as const } : {}),
        displays,
      };
    } catch {
      return { protocol: 1, available: false, hevcAvailable: false, h264Available: false, colorControl: 2, reason: 'native_failed', displays: [] };
    }
  }

  private events(child: ChildProcessWithoutNullStreams, source: 'stdout' | 'stderr', handler: (event: NativeEvent) => void): void {
    let pending = '';
    child[source].setEncoding('utf8');
    child[source].on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > 65536) {
        child.kill();
        return;
      }
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as NativeEvent;
          if (typeof event.type === 'string') handler(event);
        } catch {
          // Ignore non-JSON SDK diagnostic lines
        }
      }
    });
  }

  private spawnCriticalChild(op: PublisherOperation, executable: string, args: string[]): ChildProcessWithoutNullStreams {
    if (op.stopped) throw new Error('SDR operation cancelled');
    const child = spawn(this.file(executable), args, { windowsHide: true, stdio: 'pipe', cwd: this.root });
    op.children.add(child);
    child.stdin.on('error', () => {});
    const failed = () => this.stopOperation(op, 'native_process_exited');
    child.once('error', failed);
    child.once('close', failed);
    return child;
  }

  private startAudioLoopback(op: PublisherOperation, targetPid?: number): void {
    if (!this.onAudioChunk || op.stopped) return;
    let audio: ChildProcessWithoutNullStreams;
    try {
      audio = spawn(this.file('HdrAudio.exe'), sdrAudioArgs(targetPid), { windowsHide: true, stdio: 'pipe', cwd: this.root });
    } catch {
      this.notify({ kind: 'audio-stopped', reason: 'audio_spawn_failed' });
      return;
    }
    op.audioChild = audio;
    audio.stdin.on('error', () => {});
    let sampleRate = 0;
    let inChannels = 0;
    let format = '';
    let bytesPerSample = 0;
    let chunkFrames = 0;
    let chunkBytes = 0;
    let pending: Buffer = Buffer.alloc(0);

    const stopAudio = (reason?: string) => {
      if (op.audioChild === audio) {
        op.audioChild = undefined;
        try { audio.stdin.destroy(); audio.kill(); } catch { /* ignore */ }
        if (!op.stopped) this.notify({ kind: 'audio-stopped', ...(reason ? { reason } : {}) });
      }
    };
    audio.once('error', () => stopAudio('audio_process_error'));
    audio.once('close', () => stopAudio('audio_process_exited'));

    this.events(audio, 'stderr', event => {
      if (event.type === 'audio-ready' &&
          Number.isSafeInteger(event.sampleRate) && event.sampleRate! >= 8000 && event.sampleRate! <= 192000 &&
          Number.isSafeInteger(event.channels) && event.channels! >= 1 && event.channels! <= 8 &&
          ['f32le', 's16le', 's24le', 's32le'].includes(event.format ?? '')) {
        sampleRate = event.sampleRate!;
        inChannels = event.channels!;
        format = event.format!;
        bytesPerSample = format === 's16le' ? 2 : format === 's24le' ? 3 : 4;
        chunkFrames = Math.max(80, Math.floor(sampleRate / 50)); // 20ms chunks
        chunkBytes = chunkFrames * inChannels * bytesPerSample;
      } else if (event.type === 'failed') {
        stopAudio(event.reason ?? 'system_audio_unavailable');
      }
    });

    audio.stdout.on('data', (data: Buffer) => {
      if (op.stopped || !chunkBytes) return;
      pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
      if (pending.length > 4 * 1024 * 1024) {
        stopAudio('audio_buffer_overflow');
        return;
      }
      let offset = 0;
      while (offset + chunkBytes <= pending.length) {
        const { pcm, outChannels } = decodePcmChunkToStereoOrMonoFloat32(pending, offset, chunkFrames, inChannels, format);
        this.onAudioChunk?.({ sampleRate, channels: outChannels, frames: chunkFrames, pcm });
        offset += chunkBytes;
      }
      if (offset > 0) {
        pending = offset === pending.length ? Buffer.alloc(0) : pending.subarray(offset);
      }
    });
  }

  async startPublisher(
    captureTarget: SdrCaptureTarget,
    config: SdrVideoConfig,
    credentials: SdrCredentials,
  ): Promise<SdrPublishResult> {
    validateSdrVideo(config);
    if (this.availability()) throw new Error('Native SDR runtime files missing');
    this.stop();
    const op: PublisherOperation = {
      children: new Set(),
      stopped: false,
      colorRevision: 0,
      colorWaiters: new Map(),
    };
    this.publisher = op;

    try {
      const support = await this.probeEncoders();
      if ((config.codec === 'hevc' && !support.hevc) || (config.codec === 'h264' && !support.h264)) {
        throw new Error(`NVENC ${config.codec} encoder unavailable`);
      }

      let sourceDims: { width: number; height: number };
      let gpuTarget: { monitor: string } | { window: string };
      let audioTargetPid: number | undefined;

      if (isWindowCaptureTarget(captureTarget)) {
        validateNativeHandle(captureTarget.hwnd, 'window');
        const winInfo = await this.probeWindow(captureTarget.hwnd);
        sourceDims = { width: winInfo.width, height: winInfo.height };
        gpuTarget = { window: captureTarget.hwnd };
        audioTargetPid = winInfo.pid || undefined;
      } else {
        const displays = await this.displays();
        const target = matchSdrDisplay(displays, captureTarget);
        if (!target || !/^[1-9][0-9]*$/.test(target.hmonitor)) {
          throw new Error('Selected monitor handle unavailable');
        }
        sourceDims = { width: target.width, height: target.height };
        gpuTarget = { monitor: target.hmonitor };
      }
      if (op.stopped) throw new Error('SDR operation cancelled');

      const { width, height } = resolveSdrOutputDimensions(sourceDims, config);
      const resolvedConfig = { ...config, width, height };
      const encoder = this.spawnCriticalChild(op, 'HdrGpu.exe', sdrGpuArgs(resolvedConfig, gpuTarget));
      op.encoder = encoder;

      this.events(encoder, 'stderr', event => {
        if (event.type === 'failed') {
          this.stopOperation(op, event.reason);
        } else if (event.type === 'color-applied' && typeof event.revision === 'number') {
          op.colorWaiters.get(event.revision)?.resolve();
        } else if (event.type === 'gpu-stats') {
          this.notify({
            kind: 'stats',
            codec: config.codec,
            encodeFps: typeof event.encodeFps === 'number' ? event.encodeFps : 0,
            captureFps: typeof event.freshFps === 'number' ? event.freshFps : 0,
            encodeTimeMs: typeof event.encodeTimeMs === 'number' ? event.encodeTimeMs : 0,
            bitrateKbps: typeof event.bitrateKbps === 'number' ? event.bitrateKbps : 0,
            width: typeof event.width === 'number' ? event.width : width,
            height: typeof event.height === 'number' ? event.height : height,
            sourceWidth: typeof event.sourceWidth === 'number' ? event.sourceWidth : sourceDims.width,
            sourceHeight: typeof event.sourceHeight === 'number' ? event.sourceHeight : sourceDims.height,
          });
        }
      });

      const transport = this.spawnCriticalChild(op, 'hdr-bridge.exe', []);
      transport.stdout.resume();

      const streamingPromise = new Promise<NativeEvent>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('SDR bridge startup timed out'));
          this.stopOperation(op, 'bridge_timeout');
        }, 20000);
        const failed = () => {
          clearTimeout(timeout);
          reject(new Error('SDR bridge process exited before streaming'));
        };
        transport.once('close', failed);
        transport.once('error', failed);
        this.events(transport, 'stderr', event => {
          if (event.type === 'streaming') {
            clearTimeout(timeout);
            transport.off('close', failed);
            transport.off('error', failed);
            resolve(event);
          } else if (event.type === 'failed' || event.type === 'stopped') {
            failed();
            this.stopOperation(op, event.reason);
          }
        });
      });

      const bridgeCodec = config.codec === 'h264' ? 'h264' : 'h265';
      transport.stdin.write(
        `${JSON.stringify({
          protocol: 1,
          mode: 'publish',
          streamKind: 'sdr',
          codec: bridgeCodec,
          url: credentials.url,
          token: credentials.token,
          width,
          height,
          fps: config.fps,
          bitrateKbps: config.bitrateKbps,
        })}\n`,
      );
      encoder.stdout.pipe(transport.stdin);

      const started = await streamingPromise;
      if (op.stopped || !started.trackSid || started.identity !== credentials.identity) {
        throw new Error('SDR publication not confirmed by bridge');
      }

      if (config.shareAudio) {
        this.startAudioLoopback(op, audioTargetPid);
      }

      return {
        trackSid: started.trackSid,
        identity: started.identity,
        width,
        height,
        codec: config.codec,
      };
    } catch (error) {
      this.stopOperation(op);
      throw error;
    }
  }

  async setPublisherColor(color: HdrColor): Promise<void> {
    validateHdrColor(color);
    const op = this.publisher;
    if (!op || op.stopped || !op.encoder) throw new Error('SDR publisher unavailable');
    if (op.colorWaiters.size) throw new Error('SDR color update busy');
    const revision = op.colorRevision + 1;
    const packet = hdrColorPacket(color, revision);
    op.colorRevision = revision;
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timeout);
        op.colorWaiters.delete(revision);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        done(new Error('SDR color update timed out'));
      }, 3000);
      op.colorWaiters.set(revision, { resolve: () => done(), reject: done });
      op.encoder!.stdin.write(packet, error => {
        if (error) done(new Error('SDR control pipe closed'));
      });
    });
  }

  requestKeyFrame(): boolean {
    const op = this.publisher;
    if (!op || op.stopped || !op.encoder) return false;
    try {
      return op.encoder.stdin.write(sdrKeyFramePacket());
    } catch {
      return false;
    }
  }

  private stopOperation(op: PublisherOperation, reason?: string): void {
    if (op.stopped) return;
    op.stopped = true;
    for (const waiter of op.colorWaiters.values()) {
      waiter.reject(new Error('SDR publisher stopped'));
    }
    op.colorWaiters.clear();
    if (op.audioChild) {
      try { op.audioChild.stdin.destroy(); op.audioChild.kill(); } catch { /* ignore */ }
      op.audioChild = undefined;
    }
    for (const child of op.children) {
      try { child.stdin.destroy(); child.kill(); } catch { /* ignore */ }
    }
    const wasCurrent = this.publisher === op;
    if (wasCurrent) {
      this.publisher = null;
      this.notify({ kind: 'publisher', state: 'stopped', ...(reason ? { reason } : {}) });
    }
  }

  stop(): void {
    if (this.publisher) this.stopOperation(this.publisher);
  }

  dispose(): void {
    this.stop();
  }
}

export const SDR_NATIVE_TRACK = 'backspace-screen-sdr-v1';
