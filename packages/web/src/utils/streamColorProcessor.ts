import type { Track, TrackProcessor, VideoProcessorOptions } from 'livekit-client';
import {
  computeStreamColorUniforms,
  type StreamColorSettings,
  type StreamColorUniforms,
} from './streamColor';
import { startStreamColorWorker, type StreamColorWorkerHandle } from './streamColorWorker';

interface VideoFrameInitLike {
  timestamp: number;
  duration?: number;
}

interface VideoFrameLike {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  readonly duration: number | null;
  close(): void;
}

type VideoFrameConstructor = new (
  source: OffscreenCanvas | HTMLCanvasElement,
  init: VideoFrameInitLike,
) => VideoFrameLike;

interface MediaStreamTrackProcessorLike {
  readonly readable: ReadableStream<VideoFrameLike>;
}

type MediaStreamTrackProcessorConstructor = new (init: {
  track: MediaStreamTrack;
}) => MediaStreamTrackProcessorLike;

type MediaStreamTrackGeneratorLike = MediaStreamTrack & {
  readonly writable: WritableStream<VideoFrameLike>;
};

type MediaStreamTrackGeneratorConstructor = new (init: {
  kind: 'video';
}) => MediaStreamTrackGeneratorLike;

const VERTEX_SHADER_SOURCE = `#version 300 es
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  vUv = vec2(pos.x, 1.0 - pos.y);
}
`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSource;
uniform vec3 uContrast;
uniform vec3 uBrightness;
uniform vec3 uInvGamma;
uniform float uVibrance;
uniform mat3 uHueMatrix;

void main() {
  vec4 src = texture(uSource, vUv);
  vec3 c = clamp((src.rgb - 0.5) * uContrast + 0.5 + uBrightness, 0.0, 1.0);
  c = pow(c, uInvGamma);
  if (uVibrance != 0.0) {
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
    float scale = uVibrance < 0.0 ? (1.0 + uVibrance) : (1.0 + uVibrance * (2.0 - sat));
    c = clamp(vec3(luma) + (c - vec3(luma)) * scale, 0.0, 1.0);
  }
  c = clamp(uHueMatrix * c, 0.0, 1.0);
  outColor = vec4(c, src.a);
}
`;

const underlyingCaptureTracks = new WeakMap<MediaStreamTrack, MediaStreamTrack>();
const nonDestructiveDetachHandlers = new WeakMap<MediaStreamTrack, () => void>();

/**
 * Resolve the raw OS/browser capture track behind a color-processed video track.
 * Capture constraints (`applyConstraints`), `contentHint`, and native dimension
 * inspection (`getSettings`) must target the real source track rather than the
 * synthetic generator output.
 */
export function getUnderlyingCaptureTrack(track: MediaStreamTrack | null | undefined): MediaStreamTrack | null {
  if (!track) return null;
  return underlyingCaptureTracks.get(track) ?? track;
}

/**
 * Tear down any synthetic color-processor wrapper on `stream` *without* stopping
 * the underlying OS screen-capture track, returning a `MediaStream` backed by
 * the raw capture video track and original audio tracks.
 */
export function detachStreamColorProcessor(stream: MediaStream): MediaStream {
  const outerVideo = stream.getVideoTracks()[0];
  if (!outerVideo) return stream;
  const rawVideo = underlyingCaptureTracks.get(outerVideo);
  if (!rawVideo || rawVideo === outerVideo) return stream;
  nonDestructiveDetachHandlers.get(outerVideo)?.();
  return new MediaStream([rawVideo, ...stream.getAudioTracks()]);
}

export interface StreamColorSurfaceRenderer {
  readonly surface: OffscreenCanvas | HTMLCanvasElement;
  render(source: TexImageSource, width: number, height: number, uniforms: StreamColorUniforms): boolean;
  dispose(): void;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to allocate WebGL2 shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader compile failed: ${info}`);
  }
  return shader;
}

export function createWebGlStreamColorRenderer(
  preferOffscreen = true,
): StreamColorSurfaceRenderer | null {
  let surface: OffscreenCanvas | HTMLCanvasElement;
  if (preferOffscreen && typeof OffscreenCanvas !== 'undefined') {
    surface = new OffscreenCanvas(2, 2);
  } else if (typeof document !== 'undefined') {
    surface = document.createElement('canvas');
    surface.width = 2;
    surface.height = 2;
  } else {
    return null;
  }

  const contextOptions: WebGLContextAttributes = {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  };

  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = surface.getContext('webgl2', contextOptions) as WebGL2RenderingContext | null;
  } catch {
    return null;
  }
  if (!gl) return null;

  let vs: WebGLShader | null = null;
  let fs: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let texture: WebGLTexture | null = null;

  try {
    vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
    program = gl.createProgram();
    if (!program) throw new Error('Failed to create WebGL2 program');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`WebGL2 program link failed: ${gl.getProgramInfoLog(program) ?? 'unknown'}`);
    }

    vao = gl.createVertexArray();
    texture = gl.createTexture();
    if (!vao || !texture) throw new Error('Failed to create WebGL2 resources');

    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);

    gl.useProgram(program);
    const uSource = gl.getUniformLocation(program, 'uSource');
    const uContrast = gl.getUniformLocation(program, 'uContrast');
    const uBrightness = gl.getUniformLocation(program, 'uBrightness');
    const uInvGamma = gl.getUniformLocation(program, 'uInvGamma');
    const uVibrance = gl.getUniformLocation(program, 'uVibrance');
    const uHueMatrix = gl.getUniformLocation(program, 'uHueMatrix');
    gl.uniform1i(uSource, 0);

    let disposed = false;

    return {
      surface,
      render(source: TexImageSource, width: number, height: number, uniforms: StreamColorUniforms): boolean {
        if (disposed || !gl || gl.isContextLost() || width <= 0 || height <= 0) return false;
        if (surface.width !== width || surface.height !== height) {
          surface.width = width;
          surface.height = height;
          gl.viewport(0, 0, width, height);
        }
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

        gl.uniform3f(uContrast, uniforms.contrast[0], uniforms.contrast[1], uniforms.contrast[2]);
        gl.uniform3f(
          uBrightness,
          uniforms.brightnessOffset[0],
          uniforms.brightnessOffset[1],
          uniforms.brightnessOffset[2],
        );
        gl.uniform3f(uInvGamma, uniforms.invGamma[0], uniforms.invGamma[1], uniforms.invGamma[2]);
        gl.uniform1f(uVibrance, uniforms.vibrance);
        gl.uniformMatrix3fv(uHueMatrix, false, uniforms.hueMatrix);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return true;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        if (!gl) return;
        try {
          if (texture) gl.deleteTexture(texture);
          if (vao) gl.deleteVertexArray(vao);
          if (program) gl.deleteProgram(program);
          if (vs) gl.deleteShader(vs);
          if (fs) gl.deleteShader(fs);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        } catch {
          // Ignore teardown errors on already-lost contexts
        }
      },
    };
  } catch {
    try {
      if (texture) gl.deleteTexture(texture);
      if (vao) gl.deleteVertexArray(vao);
      if (program) gl.deleteProgram(program);
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // Ignore cleanup failures
    }
    return null;
  }
}

export interface StreamColorProcessorSource {
  getColor: () => StreamColorSettings;
  subscribe: (listener: (color: StreamColorSettings) => void) => () => void;
  rendererFactory?: (preferOffscreen?: boolean) => StreamColorSurfaceRenderer | null;
  /** Disable Dedicated Worker offload (used when custom main-thread `rendererFactory` is injected). */
  preferWorker?: boolean;
}

function getInsertableStreamApis(): {
  Processor: MediaStreamTrackProcessorConstructor;
  Generator: MediaStreamTrackGeneratorConstructor;
  VideoFrameCtor: VideoFrameConstructor;
} | null {
  const g = globalThis as Record<string, unknown>;
  const Processor = g.MediaStreamTrackProcessor as MediaStreamTrackProcessorConstructor | undefined;
  const Generator = g.MediaStreamTrackGenerator as MediaStreamTrackGeneratorConstructor | undefined;
  const VideoFrameCtor = g.VideoFrame as VideoFrameConstructor | undefined;
  if (typeof Processor === 'function' && typeof Generator === 'function' && typeof VideoFrameCtor === 'function') {
    return { Processor, Generator, VideoFrameCtor };
  }
  return null;
}

/**
 * Wrap a captured screen-share `MediaStream` with a real-time GPU color processor.
 *
 * - In Chromium / Electron (`MediaStreamTrackProcessor` + `MediaStreamTrackGenerator`),
 *   transfers the `VideoFrame` streams to a Dedicated Worker (`OffscreenCanvas` WebGL2)
 *   so frame processing never touches the UI main thread; falls back cleanly to an
 *   in-process `TransformStream` when Worker stream transfer is unavailable.
 * - In non-Chromium browsers without `MediaStreamTrackGenerator`, falls back to an
 *   off-DOM WebGL2 `<canvas>.captureStream()` pipeline when WebGL2 is available, or
 *   returns `rawStream` unchanged if WebGL2 is unavailable (e.g., unit test `jsdom`).
 */
export function attachStreamColorProcessor(
  rawStream: MediaStream,
  source: StreamColorProcessorSource,
): MediaStream {
  const rawVideoTrack = rawStream.getVideoTracks()[0];
  if (!rawVideoTrack || rawVideoTrack.readyState !== 'live') return rawStream;

  const rendererFactory = source.rendererFactory ?? createWebGlStreamColorRenderer;
  const insertable = getInsertableStreamApis();

  if (insertable) {
    return attachInsertableStreamProcessor(rawStream, rawVideoTrack, source, insertable, rendererFactory);
  }

  return attachCanvasFallbackProcessor(rawStream, rawVideoTrack, source, rendererFactory);
}

/**
 * LiveKit `TrackProcessor` adapter for on-demand stream color grading.
 *
 * Attached via `localVideoTrack.setProcessor(processor, true)` ONLY when color
 * settings are non-default, and removed via `localVideoTrack.stopProcessor()`
 * when settings return to default — preserving 100% native zero-copy capture →
 * hardware encode when unadjusted.
 */
export function createScreenShareColorTrackProcessor(
  source: StreamColorProcessorSource,
): TrackProcessor<Track.Kind.Video, VideoProcessorOptions> {
  let activeProcessedTrack: MediaStreamTrack | undefined;

  const teardownCurrent = () => {
    const current = activeProcessedTrack;
    activeProcessedTrack = undefined;
    if (!current) return;
    const detach = nonDestructiveDetachHandlers.get(current);
    if (detach) {
      detach();
    } else {
      try {
        current.stop();
      } catch {
        // Ignore stop errors
      }
    }
  };

  const setupForTrack = async (rawTrack: MediaStreamTrack): Promise<void> => {
    teardownCurrent();
    const wrapped = attachStreamColorProcessor(new MediaStream([rawTrack]), source);
    const outTrack = wrapped.getVideoTracks()[0];
    activeProcessedTrack = outTrack && outTrack !== rawTrack ? outTrack : undefined;
  };

  const processor: TrackProcessor<Track.Kind.Video, VideoProcessorOptions> = {
    name: 'backspace-stream-color',
    get processedTrack(): MediaStreamTrack | undefined {
      return activeProcessedTrack;
    },
    async init(opts: VideoProcessorOptions): Promise<void> {
      await setupForTrack(opts.track);
    },
    async restart(opts: VideoProcessorOptions): Promise<void> {
      await setupForTrack(opts.track);
    },
    async destroy(): Promise<void> {
      teardownCurrent();
    },
  };

  return processor;
}

function attachInsertableStreamProcessor(
  rawStream: MediaStream,
  rawVideoTrack: MediaStreamTrack,
  source: StreamColorProcessorSource,
  apis: {
    Processor: MediaStreamTrackProcessorConstructor;
    Generator: MediaStreamTrackGeneratorConstructor;
    VideoFrameCtor: VideoFrameConstructor;
  },
  rendererFactory: (preferOffscreen?: boolean) => StreamColorSurfaceRenderer | null,
): MediaStream {
  let processor: MediaStreamTrackProcessorLike;
  let generator: MediaStreamTrackGeneratorLike;
  try {
    processor = new apis.Processor({ track: rawVideoTrack });
    generator = new apis.Generator({ kind: 'video' });
  } catch {
    return rawStream;
  }

  let uniforms = computeStreamColorUniforms(source.getColor());
  let renderer: StreamColorSurfaceRenderer | null = null;
  let rendererUnavailable = false;
  let workerHandle: StreamColorWorkerHandle | null = null;
  let cleanedUp = false;

  // Offload to Dedicated Worker when no custom main-thread rendererFactory was injected
  const canUseWorker = source.preferWorker !== false && source.rendererFactory === undefined;
  if (canUseWorker && !processor.readable.locked && !generator.writable.locked) {
    workerHandle = startStreamColorWorker(processor.readable, generator.writable, uniforms);
  }

  const unsubscribe = source.subscribe((nextColor) => {
    uniforms = computeStreamColorUniforms(nextColor);
    workerHandle?.updateUniforms(uniforms);
  });

  const abortController = new AbortController();
  const nativeStop = generator.stop.bind(generator);

  const cleanup = (stopRaw: boolean) => {
    if (cleanedUp) return;
    cleanedUp = true;
    unsubscribe();
    rawVideoTrack.removeEventListener?.('ended', onRawEnded);
    abortController.abort();
    workerHandle?.dispose();
    workerHandle = null;
    renderer?.dispose();
    renderer = null;
    if (stopRaw) {
      try {
        rawVideoTrack.stop();
      } catch {
        // Ignore stop errors
      }
    }
    try {
      nativeStop();
    } catch {
      // Ignore stop errors
    }
  };

  const onRawEnded = () => {
    cleanup(false);
    // Notify listeners watching `ended` on the published/staged track (e.g. ScreenShareSetup / LiveKit)
    try {
      generator.dispatchEvent?.(new Event('ended'));
    } catch {
      // Synthetic generator tracks in mocks may not implement EventTarget
    }
  };

  rawVideoTrack.addEventListener?.('ended', onRawEnded);
  generator.stop = () => {
    cleanup(true);
  };
  nonDestructiveDetachHandlers.set(generator, () => {
    cleanup(false);
  });

  if (rawVideoTrack.contentHint) {
    generator.contentHint = rawVideoTrack.contentHint;
  }
  underlyingCaptureTracks.set(generator, rawVideoTrack);

  if (!workerHandle) {
    const transform = new TransformStream<VideoFrameLike, VideoFrameLike>({
      transform(frame, controller) {
        if (cleanedUp) {
          frame.close();
          return;
        }
        if (uniforms.isDefault || rendererUnavailable) {
          controller.enqueue(frame);
          return;
        }
        if (!renderer) {
          renderer = rendererFactory(true);
          if (!renderer) {
            rendererUnavailable = true;
            controller.enqueue(frame);
            return;
          }
        }

        const width = frame.displayWidth || frame.codedWidth;
        const height = frame.displayHeight || frame.codedHeight;
        try {
          const rendered = renderer.render(frame as unknown as TexImageSource, width, height, uniforms);
          if (!rendered) {
            controller.enqueue(frame);
            return;
          }
          const outFrame = new apis.VideoFrameCtor(renderer.surface, {
            timestamp: frame.timestamp,
            ...(frame.duration != null ? { duration: frame.duration } : {}),
          });
          frame.close();
          controller.enqueue(outFrame);
        } catch {
          controller.enqueue(frame);
        }
      },
      flush() {
        renderer?.dispose();
        renderer = null;
      },
    });

    void processor.readable
      .pipeThrough(transform)
      .pipeTo(generator.writable, { signal: abortController.signal })
      .catch(() => {
        // Expected on abort when stopping capture
      });
  }

  const audioTracks = rawStream.getAudioTracks();
  return new MediaStream([generator, ...audioTracks]);
}

function attachCanvasFallbackProcessor(
  rawStream: MediaStream,
  rawVideoTrack: MediaStreamTrack,
  source: StreamColorProcessorSource,
  rendererFactory: (preferOffscreen?: boolean) => StreamColorSurfaceRenderer | null,
): MediaStream {
  if (
    typeof document === 'undefined' ||
    typeof HTMLCanvasElement === 'undefined' ||
    typeof HTMLCanvasElement.prototype.captureStream !== 'function'
  ) {
    return rawStream;
  }

  const renderer = rendererFactory(false);
  if (!renderer || !(renderer.surface instanceof HTMLCanvasElement)) {
    renderer?.dispose();
    return rawStream;
  }

  const canvas = renderer.surface;
  const fps = Math.max(15, Math.min(120, Math.round(rawVideoTrack.getSettings?.().frameRate ?? 60)));
  let capturedStream: MediaStream;
  try {
    capturedStream = canvas.captureStream(fps);
  } catch {
    renderer.dispose();
    return rawStream;
  }
  const processedTrack = capturedStream.getVideoTracks()[0];
  if (!processedTrack) {
    renderer.dispose();
    return rawStream;
  }

  const videoEl = document.createElement('video');
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.autoplay = true;
  videoEl.srcObject = new MediaStream([rawVideoTrack]);
  void videoEl.play().catch(() => {});

  let uniforms = computeStreamColorUniforms(source.getColor());
  let cleanedUp = false;

  const unsubscribe = source.subscribe((nextColor) => {
    uniforms = computeStreamColorUniforms(nextColor);
  });

  const drawNext = () => {
    if (cleanedUp) return;
    const width = videoEl.videoWidth;
    const height = videoEl.videoHeight;
    if (width > 0 && height > 0) {
      renderer.render(videoEl, width, height, uniforms);
    }
  };

  const timer = setInterval(drawNext, Math.max(8, Math.round(1000 / fps)));
  const nativeStop = processedTrack.stop.bind(processedTrack);

  const cleanup = (stopRaw: boolean) => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(timer);
    unsubscribe();
    rawVideoTrack.removeEventListener?.('ended', onRawEnded);
    videoEl.pause();
    videoEl.srcObject = null;
    renderer.dispose();
    if (stopRaw) {
      try {
        rawVideoTrack.stop();
      } catch {
        // Ignore stop errors
      }
    }
    try {
      nativeStop();
    } catch {
      // Ignore stop errors
    }
  };

  const onRawEnded = () => {
    cleanup(false);
    try {
      processedTrack.dispatchEvent?.(new Event('ended'));
    } catch {
      // Ignore dispatch errors
    }
  };

  rawVideoTrack.addEventListener?.('ended', onRawEnded);
  processedTrack.stop = () => {
    cleanup(true);
  };
  nonDestructiveDetachHandlers.set(processedTrack, () => {
    cleanup(false);
  });
  if (rawVideoTrack.contentHint) {
    processedTrack.contentHint = rawVideoTrack.contentHint;
  }
  underlyingCaptureTracks.set(processedTrack, rawVideoTrack);

  return new MediaStream([processedTrack, ...rawStream.getAudioTracks()]);
}
