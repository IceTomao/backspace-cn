import type { StreamColorUniforms } from './streamColor';

export interface StreamColorWorkerHandle {
  updateUniforms(uniforms: StreamColorUniforms): void;
  dispose(): void;
}

const WORKER_SCRIPT = `
'use strict';

const VERTEX_SHADER_SOURCE = \`#version 300 es
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  vUv = vec2(pos.x, 1.0 - pos.y);
}
\`;

const FRAGMENT_SHADER_SOURCE = \`#version 300 es
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
\`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to allocate WebGL2 shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error('WebGL2 shader compile failed: ' + info);
  }
  return shader;
}

function createWorkerRenderer() {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const surface = new OffscreenCanvas(2, 2);
  let gl = null;
  try {
    gl = surface.getContext('webgl2', {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
  } catch {
    return null;
  }
  if (!gl) return null;

  let vs = null;
  let fs = null;
  let program = null;
  let vao = null;
  let texture = null;

  try {
    vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
    program = gl.createProgram();
    if (!program) throw new Error('Failed to create WebGL2 program');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('WebGL2 program link failed');
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
      render(frame, width, height, uniforms) {
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
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

        gl.uniform3f(uContrast, uniforms.contrast[0], uniforms.contrast[1], uniforms.contrast[2]);
        gl.uniform3f(
          uBrightness,
          uniforms.brightnessOffset[0],
          uniforms.brightnessOffset[1],
          uniforms.brightnessOffset[2]
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
        try {
          if (texture) gl.deleteTexture(texture);
          if (vao) gl.deleteVertexArray(vao);
          if (program) gl.deleteProgram(program);
          if (vs) gl.deleteShader(vs);
          if (fs) gl.deleteShader(fs);
          const ext = gl.getExtension('WEBGL_lose_context');
          if (ext) ext.loseContext();
        } catch {
          // Ignore teardown errors
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
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    } catch {
      // Ignore cleanup errors
    }
    return null;
  }
}

let uniforms = null;
let renderer = null;
let rendererUnavailable = false;
let abortController = null;
let stopped = false;

function stopPipeline() {
  if (stopped) return;
  stopped = true;
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  if (renderer) {
    renderer.dispose();
    renderer = null;
  }
}

self.onmessage = function (event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'init') {
    uniforms = msg.uniforms;
    const readable = msg.readable;
    const writable = msg.writable;
    abortController = new AbortController();

    const transform = new TransformStream({
      transform(frame, controller) {
        if (stopped) {
          frame.close();
          return;
        }
        if (!uniforms || uniforms.isDefault || rendererUnavailable || typeof VideoFrame !== 'function') {
          controller.enqueue(frame);
          return;
        }
        if (!renderer) {
          renderer = createWorkerRenderer();
          if (!renderer) {
            rendererUnavailable = true;
            controller.enqueue(frame);
            return;
          }
        }
        const width = frame.displayWidth || frame.codedWidth;
        const height = frame.displayHeight || frame.codedHeight;
        try {
          const rendered = renderer.render(frame, width, height, uniforms);
          if (!rendered) {
            controller.enqueue(frame);
            return;
          }
          const init = { timestamp: frame.timestamp };
          if (frame.duration != null) init.duration = frame.duration;
          const outFrame = new VideoFrame(renderer.surface, init);
          frame.close();
          controller.enqueue(outFrame);
        } catch {
          controller.enqueue(frame);
        }
      },
      flush() {
        if (renderer) {
          renderer.dispose();
          renderer = null;
        }
      },
    });

    readable
      .pipeThrough(transform)
      .pipeTo(writable, { signal: abortController.signal })
      .catch(function () {
        // Expected on abort when stopping stream
      });
  } else if (msg.type === 'uniforms') {
    uniforms = msg.uniforms;
  } else if (msg.type === 'stop') {
    stopPipeline();
  }
};
`;

function serializeUniforms(uniforms: StreamColorUniforms): {
  isDefault: boolean;
  contrast: [number, number, number];
  brightnessOffset: [number, number, number];
  invGamma: [number, number, number];
  vibrance: number;
  hueMatrix: number[];
} {
  return {
    isDefault: uniforms.isDefault,
    contrast: [uniforms.contrast[0], uniforms.contrast[1], uniforms.contrast[2]],
    brightnessOffset: [
      uniforms.brightnessOffset[0],
      uniforms.brightnessOffset[1],
      uniforms.brightnessOffset[2],
    ],
    invGamma: [uniforms.invGamma[0], uniforms.invGamma[1], uniforms.invGamma[2]],
    vibrance: uniforms.vibrance,
    hueMatrix: Array.from(uniforms.hueMatrix),
  };
}

/**
 * Offloads Insertable Streams `VideoFrame` WebGL2 color grading to a Dedicated Worker
 * so no frame ever wakes or stalls the renderer UI main thread.
 *
 * Returns `null` if `Worker`, `OffscreenCanvas`, `Blob` URLs, or stream transferability
 * is unavailable in the current environment (e.g., jsdom tests or older browsers).
 * Note: if `postMessage` fails *before* transfer completes, `readable` and `writable`
 * remain unlocked so the caller can fall back to main-thread `TransformStream`.
 */
export function startStreamColorWorker(
  readable: ReadableStream<unknown>,
  writable: WritableStream<unknown>,
  initialUniforms: StreamColorUniforms,
): StreamColorWorkerHandle | null {
  if (
    typeof Worker !== 'function' ||
    typeof OffscreenCanvas !== 'function' ||
    typeof Blob !== 'function' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return null;
  }

  let objectUrl: string | null = null;
  let worker: Worker | null = null;
  try {
    const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });
    objectUrl = URL.createObjectURL(blob);
    worker = new Worker(objectUrl);
    worker.postMessage(
      {
        type: 'init',
        readable,
        writable,
        uniforms: serializeUniforms(initialUniforms),
      },
      [readable as unknown as Transferable, writable as unknown as Transferable],
    );
  } catch {
    if (worker) {
      try {
        worker.terminate();
      } catch {
        // Ignore terminate errors
      }
    }
    if (objectUrl && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // Ignore revoke errors
      }
    }
    return null;
  }

  let disposed = false;
  return {
    updateUniforms(uniforms: StreamColorUniforms) {
      if (disposed || !worker) return;
      try {
        worker.postMessage({
          type: 'uniforms',
          uniforms: serializeUniforms(uniforms),
        });
      } catch {
        // Ignore postMessage after termination
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (worker) {
        try {
          worker.postMessage({ type: 'stop' });
        } catch {
          // Ignore postMessage error
        }
        try {
          worker.terminate();
        } catch {
          // Ignore terminate error
        }
        worker = null;
      }
      if (objectUrl && typeof URL.revokeObjectURL === 'function') {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          // Ignore revoke error
        }
        objectUrl = null;
      }
    },
  };
}
